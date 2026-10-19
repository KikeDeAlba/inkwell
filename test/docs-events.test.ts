import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { defineManifest, registerTool } from '@kikedealba/kit/registry'
import { platformContext } from '@kikedealba/kit/platform'
import {
  changeKind,
  mergeChanges,
  parseNameStatus,
  setDocsEventSink,
  withEventBatch,
  type DocsChangedEvent,
  type DocsChangeKind,
} from '../src/docs/events.ts'
import { commitPaths, initDocsRepo } from '../src/docs/git.ts'
import { openMemoryDatabase } from '../src/db/open.ts'
import { insertSpace, updateSpace, findSpaceById } from '../src/db/spaces.ts'
import { syncProject } from '../src/confluence/sync.ts'
import { EMITTED_EVENTS, manifest } from '../src/setup.ts'
import { FakeConfluence } from './helpers/fake-confluence.ts'
import { registerFakeBita, sandbox, type Sandbox } from './helpers/sandbox.ts'

interface Captured {
  event: DocsChangedEvent
  kind: DocsChangeKind
}

function capture(t: { after: (fn: () => void) => void }): Captured[] {
  const seen: Captured[] = []
  const previous = setDocsEventSink(async (event, kind) => {
    seen.push({ event, kind })
  })
  t.after(() => setDocsEventSink(previous))
  return seen
}

function scratch(t: { after: (fn: () => void) => void }, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('name-status output becomes written, deleted and moved markdown changes, skipping assets', () => {
  const output = ['A', 'dp/infra.md', 'M', 'dp/red.md', 'D', 'dp/old.md', 'R100', 'dp/old-name.md', 'dp/new.md', 'A', 'dp/infra.assets/diagram.md', 'A', 'dp/infra.assets/a.png', 'M', '.gitignore', ''].join('\0')
  assert.deepEqual(parseNameStatus(output), [
    { action: 'written', relPath: 'dp/infra.md', created: true },
    { action: 'written', relPath: 'dp/red.md' },
    { action: 'deleted', relPath: 'dp/old.md' },
    { action: 'moved', relPath: 'dp/new.md', from: 'dp/old-name.md' },
  ])
})

test('the kind attribute tells pages from entry notes', () => {
  assert.equal(changeKind([{ action: 'written', relPath: 'apartados/arquitectura.md' }]), 'page')
  assert.equal(changeKind([{ action: 'written', relPath: 'apartados/2026/10/09-41-revisar-el-waf.md' }]), 'entry')
  assert.equal(
    changeKind([
      { action: 'written', relPath: 'apartados/arquitectura.md' },
      { action: 'deleted', relPath: 'sin-proyecto/2026/01/02-7-x.md' },
    ]),
    'mixed',
  )
})

test('merging keeps the last change per path and collapses moves', () => {
  assert.deepEqual(mergeChanges([{ action: 'written', relPath: 'a.md' }], [{ action: 'deleted', relPath: 'a.md' }]), [{ action: 'deleted', relPath: 'a.md' }])
  assert.deepEqual(mergeChanges([{ action: 'moved', relPath: 'b.md', from: 'a.md' }], [{ action: 'written', relPath: 'b.md' }]), [
    { action: 'moved', relPath: 'b.md', from: 'a.md' },
  ])
  assert.deepEqual(mergeChanges([{ action: 'moved', relPath: 'b.md', from: 'a.md' }], [{ action: 'moved', relPath: 'c.md', from: 'b.md' }]), [
    { action: 'moved', relPath: 'c.md', from: 'a.md' },
  ])
  assert.deepEqual(mergeChanges([{ action: 'moved', relPath: 'b.md', from: 'a.md' }], [{ action: 'deleted', relPath: 'b.md' }]), [
    { action: 'deleted', relPath: 'a.md' },
  ])
  assert.deepEqual(mergeChanges([{ action: 'moved', relPath: 'b.md', from: 'a.md' }], [{ action: 'moved', relPath: 'a.md', from: 'b.md' }]), [
    { action: 'written', relPath: 'a.md' },
  ])
  assert.deepEqual(mergeChanges([{ action: 'deleted', relPath: 'a.md' }], [{ action: 'written', relPath: 'a.md' }]), [{ action: 'written', relPath: 'a.md' }])
  assert.deepEqual(mergeChanges([{ action: 'deleted', relPath: 'a.md' }], [{ action: 'written', relPath: 'a.md', created: true }]), [{ action: 'written', relPath: 'a.md' }])
})

test('a file created inside a batch and then deleted leaves no trace, and one created then moved is written at its destination', () => {
  assert.deepEqual(mergeChanges([{ action: 'written', relPath: 'a.md', created: true }], [{ action: 'deleted', relPath: 'a.md' }]), [])
  assert.deepEqual(
    mergeChanges([{ action: 'written', relPath: 'a.md', created: true }], [{ action: 'written', relPath: 'a.md' }, { action: 'deleted', relPath: 'a.md' }]),
    [],
  )
  assert.deepEqual(mergeChanges([{ action: 'written', relPath: 'a.md', created: true }], [{ action: 'moved', relPath: 'b.md', from: 'a.md' }]), [
    { action: 'written', relPath: 'b.md', created: true },
  ])
  assert.deepEqual(
    mergeChanges([{ action: 'written', relPath: 'a.md', created: true }], [{ action: 'moved', relPath: 'b.md', from: 'a.md' }, { action: 'deleted', relPath: 'b.md' }]),
    [],
  )
  assert.deepEqual(mergeChanges([{ action: 'written', relPath: 'a.md' }], [{ action: 'deleted', relPath: 'a.md' }]), [{ action: 'deleted', relPath: 'a.md' }])
})

test('a batch hides the created flag and reports a created then moved file as written without from', async (t) => {
  const seen = capture(t)
  const root = scratch(t, 'inkwell-events-')
  await initDocsRepo(root)
  writeFileSync(join(root, 'keep.md'), '# Keep\n')
  await commitPaths(root, ['keep.md'], { source: 'manual', subject: 'docs: add keep' })
  seen.length = 0
  await withEventBatch(async () => {
    writeFileSync(join(root, 'tmp.md'), '# Temporal con bastante texto para que git lo vea como renombre\n')
    await commitPaths(root, ['tmp.md'], { source: 'manual', subject: 'docs: add tmp' })
    renameSync(join(root, 'tmp.md'), join(root, 'final.md'))
    await commitPaths(root, ['tmp.md', 'final.md'], { source: 'manual', subject: 'docs: move tmp' })
  })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0]?.event.changes, [{ action: 'written', relPath: 'final.md' }])
})

test('a commit emits its markdown changes, and a commit with nothing staged emits nothing', async (t) => {
  const seen = capture(t)
  const root = scratch(t, 'inkwell-events-')
  await initDocsRepo(root)
  writeFileSync(join(root, 'nota.md'), '# Nota\n')
  const sha = await commitPaths(root, ['nota.md'], { source: 'manual', subject: 'docs: add nota' })
  assert.ok(sha)
  assert.deepEqual(seen, [{ event: { docsRoot: root, commit: sha, changes: [{ action: 'written', relPath: 'nota.md' }] }, kind: 'page' }])

  assert.equal(await commitPaths(root, ['nota.md'], { source: 'manual', subject: 'docs: again' }), null)
  writeFileSync(join(root, 'data.txt'), 'x')
  assert.ok(await commitPaths(root, ['data.txt'], { source: 'manual', subject: 'docs: add data' }))
  assert.equal(seen.length, 1)
})

test('a batch emits one event for every commit made inside it, even when it throws', async (t) => {
  const seen = capture(t)
  const root = scratch(t, 'inkwell-events-')
  await initDocsRepo(root)
  let last: string | null = null
  await assert.rejects(
    withEventBatch(async () => {
      writeFileSync(join(root, 'a.md'), '# A\n')
      await commitPaths(root, ['a.md'], { source: 'manual', subject: 'docs: add a' })
      writeFileSync(join(root, 'b.md'), '# B\n')
      last = await commitPaths(root, ['b.md'], { source: 'manual', subject: 'docs: add b' })
      rmSync(join(root, 'a.md'))
      await commitPaths(root, ['a.md'], { source: 'manual', subject: 'docs: remove a' })
      writeFileSync(join(root, 'b.md'), '# B2\n')
      last = await commitPaths(root, ['b.md'], { source: 'manual', subject: 'docs: edit b' })
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.event.commit, last)
  assert.deepEqual(seen[0]?.event.changes, [{ action: 'written', relPath: 'b.md' }])
})

test('a Confluence sync that pulls several pages emits a single event', async (t) => {
  const SITE = 'https://acme.atlassian.net'
  const NOW = '2026-10-06T12:00:00.000Z'
  const db = openMemoryDatabase()
  const docsRoot = scratch(t, 'inkwell-events-sync-')
  const ctx = { db, docsRoot, timezone: 'America/Mazatlan', now: new Date(NOW) }
  const space = insertSpace(db, { name: 'Apartados', createdAt: NOW })
  updateSpace(db, space.id, { site: SITE, confluence: { ref: `${SITE}/wiki/spaces/K/pages/100/Apartados`, kind: 'page' }, syncPull: true, syncPush: true })
  const fake = new FakeConfluence(SITE)
  fake.add({ id: '100', title: 'Apartados', parentId: null, storage: 'root' })
  fake.add({ id: '101', title: 'Arquitectura', parentId: '100', storage: '## Estado\n\nuno' })
  fake.add({ id: '102', title: 'WAF', parentId: '101', storage: '# Reglas\n\nbloquea admin' })
  await initDocsRepo(docsRoot)

  const seen = capture(t)
  const report = await syncProject(ctx, fake, findSpaceById(db, space.id)!, SITE, { dryRun: false })
  assert.equal(report.created.length, 2)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.kind, 'page')
  assert.deepEqual(
    seen[0]?.event.changes.map((change) => change.action).sort(),
    ['written', 'written'],
  )
  assert.ok(seen[0]?.event.changes.some((change) => change.relPath.endsWith('waf.md')))
})

test('the manifest declares docs.changed', () => {
  assert.deepEqual(EMITTED_EVENTS, ['docs.changed'])
  assert.deepEqual(manifest().emits, ['docs.changed'])
})

function listen(box: Sandbox): string {
  const out = join(box.dir, 'received.jsonl')
  const script = join(box.dir, 'listener.mjs')
  writeFileSync(
    script,
    `import { appendFileSync } from 'node:fs'
let body = ''
process.stdin.on('data', (chunk) => (body += chunk))
process.stdin.on('end', () => appendFileSync(${JSON.stringify(out)}, JSON.stringify({ body: JSON.parse(body), event: process.env.KIT_EVENT }) + '\\n'))
`,
  )
  return script
}

async function subscribe(box: Sandbox, filter?: Record<string, string[]>): Promise<string> {
  const script = listen(box)
  await registerTool(
    defineManifest({
      name: 'listener',
      version: '1.0.0',
      bin: [process.execPath, script],
      capabilities: [],
      subscribes: [{ tool: 'inkwell', events: ['docs.changed'], ...(filter ? { filter } : {}), command: [process.execPath, script] }],
    }),
    platformContext({ env: box.env }),
  )
  return join(box.dir, 'received.jsonl')
}

async function received(file: string, count: number): Promise<any[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').trim().split('\n').filter((line) => line.length > 0)
      if (lines.length >= count) return lines.map((line) => JSON.parse(line))
    }
    await sleep(50)
  }
  throw new Error(`${file} never got ${count} events`)
}

test('page new, rename and rm reach a subscriber as written, moved and deleted', async (t) => {
  const box = sandbox(t, { KIT_NO_EVENTS: '' })
  const file = await subscribe(box)
  const docs = box.env['INKWELL_DOCS_DIR'] as string
  box.ok('space', 'add', 'Apartados', '--key', 'APA')

  const page = box.ok('page', 'new', 'Infra', '--project', 'APA').page
  const first = await received(file, 1)
  assert.equal(first[0].event, 'docs.changed')
  assert.equal(first[0].body.source, 'inkwell')
  assert.equal(first[0].body.docsRoot, docs)
  assert.match(first[0].body.commit, /^[0-9a-f]{40}$/)
  assert.deepEqual(first[0].body.changes, [{ action: 'written', relPath: 'apartados/infra.md' }])

  box.ok('page', 'rename', String(page.pageId), 'Red')
  const second = await received(file, 2)
  assert.deepEqual(second[1].body.changes, [{ action: 'moved', relPath: 'apartados/red.md', from: 'apartados/infra.md' }])

  const removed = box.ok('page', 'rm', String(page.pageId))
  assert.match(removed.sha, /^[0-9a-f]{40}$/)
  assert.equal(existsSync(join(docs, 'apartados/red.md')), false)
  const third = await received(file, 3)
  assert.deepEqual(third[2].body.changes, [{ action: 'deleted', relPath: 'apartados/red.md' }])
  await sleep(200)
  assert.equal((await received(file, 3)).length, 3)
})

test('page rm --recursive deletes the child pages, their folder and assets in one commit', async (t) => {
  const box = sandbox(t)
  const docs = box.env['INKWELL_DOCS_DIR'] as string
  box.ok('space', 'add', 'Apartados', '--key', 'APA')
  const root = box.ok('page', 'new', 'Infra', '--project', 'APA').page
  const child = box.ok('page', 'new', 'Red', '--project', 'APA', '--parent', String(root.pageId)).page
  const asset = box.ok('page', 'asset', 'path', String(root.pageId), 'flujo.drawio', '--create')
  writeFileSync(asset.path, '<mxfile/>')
  assert.ok(existsSync(join(docs, 'apartados/infra.assets/flujo.drawio')))
  assert.ok(existsSync(join(docs, child.relPath)))

  assert.equal(box.run(['page', 'rm', String(root.pageId)]).status, 2)
  assert.equal(box.run(['page', 'rm', String(root.pageId), '--recursive']).status, 9)
  assert.ok(existsSync(join(docs, 'apartados/infra.assets/flujo.drawio')))
  const removed = box.ok('page', 'rm', String(root.pageId), '--recursive', '--force')
  assert.equal(removed.removed.length, 2)
  assert.equal(existsSync(join(docs, 'apartados/infra.md')), false)
  assert.equal(existsSync(join(docs, 'apartados/infra')), false)
  assert.equal(existsSync(join(docs, 'apartados/infra.assets')), false)
  assert.deepEqual(box.ok('page', 'ls').pages, [])
  const subject = execFileSync('git', ['log', '-1', '--format=%s', '--name-status'], { cwd: docs, encoding: 'utf8', env: box.env })
  assert.match(subject, /^docs\(apartados\): remove infra/)
  assert.match(subject, /D\tapartados\/infra\.md/)
  assert.match(subject, /D\tapartados\/infra\/red\.md/)
})

test('notes written by the bita hook emit docs.changed with kind entry', async (t) => {
  const box = sandbox(t, { KIT_NO_EVENTS: '', INKWELL_NO_BITA: '1', TZ: 'UTC' })
  const file = await subscribe(box, { kind: ['entry'] })
  const entry = { id: 41, description: 'Revisar el WAF', kind: null, projectId: 3, projectName: 'Apartados', startedAt: '2026-10-09T15:00:00.000Z', stoppedAt: null, note: null }
  registerFakeBita(box, [entry], [41])
  const result = box.run(
    ['bita-hook'],
    JSON.stringify({ event: 'start', source: 'bita', docPath: null, pageIds: [], entry: { id: 41, description: entry.description, kind: null, projectId: 3, projectName: 'Apartados', start: entry.startedAt, stop: null } }),
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.json.data.note.error, null)
  const events = await received(file, 1)
  assert.equal(events[0].body.changes[0].action, 'written')
  assert.match(events[0].body.changes[0].relPath, /^apartados\/2026\/10\/09-41-/)
})

function docsGit(box: Sandbox, ...args: string[]): string {
  return execFileSync('git', args, { cwd: box.env['INKWELL_DOCS_DIR'] as string, encoding: 'utf8', env: box.env })
}

test('page rm deletes only the files of the removed pages, never entry notes that share their folder', async (t) => {
  const box = sandbox(t)
  const docs = box.env['INKWELL_DOCS_DIR'] as string
  box.ok('space', 'add', 'Proj', '--key', 'PRJ')
  const year = box.ok('page', 'new', '2026', '--project', 'PRJ').page
  assert.equal(year.relPath, 'proj/2026.md')
  const child = box.ok('page', 'new', 'Cierre', '--project', 'PRJ', '--parent', String(year.pageId)).page
  assert.equal(child.relPath, 'proj/2026/cierre.md')
  mkdirSync(join(docs, 'proj/2026/05'), { recursive: true })
  writeFileSync(join(docs, 'proj/2026/05/01-7-x.md'), '# Nota\n')
  assert.ok(box.ok('commit').sha)

  const removed = box.ok('page', 'rm', String(year.pageId), '--recursive')
  assert.match(removed.sha, /^[0-9a-f]{40}$/)
  assert.equal(existsSync(join(docs, 'proj/2026.md')), false)
  assert.equal(existsSync(join(docs, 'proj/2026/cierre.md')), false)
  assert.equal(readFileSync(join(docs, 'proj/2026/05/01-7-x.md'), 'utf8'), '# Nota\n')
  const changed = docsGit(box, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').sort()
  assert.deepEqual(changed, ['D\tproj/2026.md', 'D\tproj/2026/cierre.md'])
  assert.deepEqual(box.ok('status').dirty, [])
})

test('page rm prunes the child folders it leaves empty and keeps the project folder', async (t) => {
  const box = sandbox(t)
  const docs = box.env['INKWELL_DOCS_DIR'] as string
  box.ok('space', 'add', 'Proj', '--key', 'PRJ')
  box.ok('page', 'new', 'Otra', '--project', 'PRJ')
  const root = box.ok('page', 'new', 'Infra', '--project', 'PRJ').page
  const child = box.ok('page', 'new', 'Red', '--project', 'PRJ', '--parent', String(root.pageId)).page
  box.ok('page', 'new', 'VPC', '--project', 'PRJ', '--parent', String(child.pageId))
  assert.ok(existsSync(join(docs, 'proj/infra/red/vpc.md')))

  box.ok('page', 'rm', String(root.pageId), '--recursive')
  assert.equal(existsSync(join(docs, 'proj/infra')), false)
  assert.ok(existsSync(join(docs, 'proj/otra.md')))
})

test('page rm refuses to delete uncommitted changes unless --force', async (t) => {
  const box = sandbox(t)
  const docs = box.env['INKWELL_DOCS_DIR'] as string
  box.ok('space', 'add', 'Proj', '--key', 'PRJ')
  const page = box.ok('page', 'new', 'Infra', '--project', 'PRJ').page
  writeFileSync(join(docs, page.relPath), '# Infra\n\nsin guardar\n')

  const refused = box.run(['page', 'rm', String(page.pageId)])
  assert.equal(refused.status, 9)
  assert.equal(refused.json.error.code, 'PAGE_FILES_DIRTY')
  assert.match(refused.json.error.message, /proj\/infra\.md/)
  assert.ok(existsSync(join(docs, page.relPath)))
  assert.equal(box.ok('page', 'ls').pages.length, 1)

  const forced = box.ok('page', 'rm', String(page.pageId), '--force')
  assert.match(forced.sha, /^[0-9a-f]{40}$/)
  assert.equal(existsSync(join(docs, page.relPath)), false)
  assert.deepEqual(box.ok('status').dirty, [])
})

test('page rm warns when the deletion cannot be committed', async (t) => {
  const box = sandbox(t)
  const docs = box.env['INKWELL_DOCS_DIR'] as string
  box.ok('space', 'add', 'Proj', '--key', 'PRJ')
  const page = box.ok('page', 'new', 'Infra', '--project', 'PRJ').page
  writeFileSync(join(docs, '.git/index.lock'), '')

  const result = box.run(['page', 'rm', String(page.pageId)])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.json.data.sha, null)
  assert.equal(result.json.meta.keptDocuments, undefined)
  assert.match(result.stderr, /deletion was not committed/)
  assert.equal(existsSync(join(docs, page.relPath)), false)
})

test('page rm of a page whose file is already gone removes the record, commits nothing and does not warn', async (t) => {
  const box = sandbox(t)
  const docs = box.env['INKWELL_DOCS_DIR'] as string
  box.ok('space', 'add', 'Proj', '--key', 'PRJ')
  const page = box.ok('page', 'new', 'Infra', '--project', 'PRJ').page
  rmSync(join(docs, page.relPath))
  assert.ok(box.ok('commit').sha)
  const head = docsGit(box, 'rev-parse', 'HEAD')

  const result = box.run(['page', 'rm', String(page.pageId)])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.json.data.sha, null)
  assert.equal(result.stderr, '')
  assert.deepEqual(box.ok('page', 'ls').pages, [])
  assert.equal(docsGit(box, 'rev-parse', 'HEAD'), head)
})

test('inkwell commit of an external edit reports paths with spaces and unicode verbatim', async (t) => {
  const box = sandbox(t, { KIT_NO_EVENTS: '' })
  const file = await subscribe(box)
  const docs = box.env['INKWELL_DOCS_DIR'] as string
  box.ok('space', 'add', 'Proj', '--key', 'PRJ')
  box.ok('page', 'new', 'Infra', '--project', 'PRJ')
  await received(file, 1)
  const relPath = 'proj/diseño del año.md'
  writeFileSync(join(docs, relPath), '# Diseño\n')

  const committed = box.ok('commit')
  assert.match(committed.sha, /^[0-9a-f]{40}$/)
  const events = await received(file, 2)
  assert.equal(events[1].body.commit, committed.sha)
  assert.deepEqual(events[1].body.changes, [{ action: 'written', relPath }])
})
