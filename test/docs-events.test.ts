import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    { action: 'written', relPath: 'dp/infra.md' },
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
  assert.deepEqual(seen[0]?.event.changes, [
    { action: 'deleted', relPath: 'a.md' },
    { action: 'written', relPath: 'b.md' },
  ])
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
  const removed = box.ok('page', 'rm', String(root.pageId), '--recursive')
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
