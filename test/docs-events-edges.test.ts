import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { defineManifest, registerTool } from '@kikedealba/kit/registry'
import { platformContext } from '@kikedealba/kit/platform'
import { agents } from '@kikedealba/kit'
import { modelExtras } from '../src/autodoc/model.ts'
import { runEnvironment } from '../src/autodoc/env.ts'
import { findMapByPage } from '../src/db/confluence-map.ts'
import { openMemoryDatabase } from '../src/db/open.ts'
import { listPages, requirePage } from '../src/db/pages.ts'
import { findSpaceById, insertSpace, updateSpace } from '../src/db/spaces.ts'
import { resolveConflict, syncProject } from '../src/confluence/sync.ts'
import { setDocsEventSink, type DocsChangedEvent, type DocsChangeKind } from '../src/docs/events.ts'
import { initDocsRepo } from '../src/docs/git.ts'
import { recordPageDoc } from '../src/docs/page-record.ts'
import { FakeConfluence } from './helpers/fake-confluence.ts'
import { nodeLauncher, sandbox, type Sandbox } from './helpers/sandbox.ts'
import { DatabaseSync } from 'node:sqlite'

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

const SITE = 'https://acme.atlassian.net'
const NOW = '2026-10-06T12:00:00.000Z'
const SESSION = 'abcdef12-3456-7890-abcd-ef1234567890'

async function syncWorld(t: { after: (fn: () => void) => void }) {
  const db = openMemoryDatabase()
  const docsRoot = mkdtempSync(join(tmpdir(), 'inkwell-events-edges-'))
  t.after(() => rmSync(docsRoot, { recursive: true, force: true }))
  const ctx = { db, docsRoot, timezone: 'America/Mazatlan', now: new Date(NOW) }
  const space = insertSpace(db, { name: 'Apartados', createdAt: NOW })
  updateSpace(db, space.id, { site: SITE, confluence: { ref: `${SITE}/wiki/spaces/K/pages/100/Apartados`, kind: 'page' }, syncPull: true, syncPush: true })
  const fake = new FakeConfluence(SITE)
  fake.add({ id: '100', title: 'Apartados', parentId: null, storage: 'root' })
  fake.add({ id: '101', title: 'Arquitectura', parentId: '100', storage: '## Estado\n\nuno' })
  fake.add({ id: '102', title: 'WAF', parentId: '101', storage: '## Reglas\n\nbloquea admin' })
  await initDocsRepo(docsRoot)
  const project = () => findSpaceById(db, space.id)!
  const byTitle = (title: string) => {
    const page = listPages(db).find((candidate) => candidate.title === title)
    assert.ok(page, title)
    return page
  }
  return { db, docsRoot, ctx, fake, project, byTitle }
}

test('a sync with a Confluence rename and a two-sided conflict emits one coherent event, and resolving the conflict emits one more', async (t) => {
  const w = await syncWorld(t)
  await syncProject(w.ctx, w.fake, w.project(), SITE, { dryRun: false })
  const arquitectura = w.byTitle('Arquitectura')
  const waf = w.byTitle('WAF')
  const seen = capture(t)

  w.fake.edit('101', '## Estado\n\nuno\n\ncon el cambio de nombre', 'Arquitectura base')
  w.fake.edit('102', '## Reglas\n\nremoto')
  await recordPageDoc(w.ctx, requirePage(w.db, waf.id), { body: '## Reglas\n\nlocal' })
  const before = seen.length
  const report = await syncProject(w.ctx, w.fake, w.project(), SITE, { dryRun: false })
  assert.equal(report.conflicts.length, 1)
  assert.equal(report.pulled.length, 1)

  const syncEvents = seen.slice(before)
  assert.equal(syncEvents.length, 1)
  const changes = syncEvents[0]!.event.changes
  assert.deepEqual(changes, [
    { action: 'moved', relPath: 'apartados/arquitectura-base.md', from: 'apartados/arquitectura.md' },
    { action: 'moved', relPath: 'apartados/arquitectura-base/waf.md', from: 'apartados/arquitectura/waf.md' },
  ])
  assert.equal(requirePage(w.db, arquitectura.id).title, 'Arquitectura base')

  w.fake.edit('102', '## Reglas\n\nremoto', 'WAF edge')
  const resolvedBefore = seen.length
  await resolveConflict(w.ctx, w.fake, waf.id, 'remote')
  const resolved = seen.slice(resolvedBefore)
  assert.equal(resolved.length, 1)
  const wafNow = requirePage(w.db, waf.id)
  assert.equal(wafNow.title, 'WAF edge')
  assert.ok(resolved[0]!.event.changes.some((change) => change.relPath === wafNow.relPath))
  assert.ok(!resolved[0]!.event.changes.some((change) => change.action === 'deleted' && change.relPath === wafNow.relPath))
  assert.equal(findMapByPage(w.db, waf.id)?.state, 'synced')
  assert.equal(resolved[0]!.kind, 'page')
})

test('keeping both sides of a conflict changes no file and emits nothing', async (t) => {
  const w = await syncWorld(t)
  await syncProject(w.ctx, w.fake, w.project(), SITE, { dryRun: false })
  const waf = w.byTitle('WAF')
  w.fake.edit('102', '## Reglas\n\nremoto')
  await recordPageDoc(w.ctx, requirePage(w.db, waf.id), { body: '## Reglas\n\nlocal' })
  await syncProject(w.ctx, w.fake, w.project(), SITE, { dryRun: false })
  const seen = capture(t)
  await resolveConflict(w.ctx, w.fake, waf.id, 'both')
  assert.equal(seen.length, 0)
})

test('a dry run sync and an unchanged sync emit nothing', async (t) => {
  const w = await syncWorld(t)
  const seen = capture(t)
  await syncProject(w.ctx, w.fake, w.project(), SITE, { dryRun: true })
  assert.equal(seen.length, 0)
  await syncProject(w.ctx, w.fake, w.project(), SITE, { dryRun: false })
  assert.equal(seen.length, 1)
  await syncProject(w.ctx, w.fake, w.project(), SITE, { dryRun: false })
  assert.equal(seen.length, 1)
})

function fakeClaude(box: Sandbox): { answer(result: unknown): void; envKeys(): string[] } {
  const dir = join(box.dir, 'fake-claude')
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'claude.mjs')
  const answerFile = join(dir, 'answer.json')
  const callsFile = join(dir, 'calls.jsonl')
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync } from 'node:fs'
for await (const chunk of process.stdin) void chunk
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ noEvents: process.env.KIT_NO_EVENTS ?? null }) + '\\n')
const answer = JSON.parse(readFileSync(${JSON.stringify(answerFile)}, 'utf8'))
process.stdout.write(JSON.stringify({ type: 'result', result: JSON.stringify(answer), is_error: false }))
`,
  )
  box.env['INKWELL_CLAUDE_BIN'] = nodeLauncher(dir, 'claude', script)
  return {
    answer: (result) => writeFileSync(answerFile, JSON.stringify(result)),
    envKeys: () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line).noEvents) : []),
  }
}

function fakeBitaRepo(box: Sandbox): void {
  const script = join(box.dir, 'fake-bita.mjs')
  writeFileSync(
    script,
    `const args = process.argv.slice(2).filter((arg) => arg !== '--json')
const ok = args[0] === 'repo' && args[1] === 'which'
const data = ok ? { slug: 'acme/cobros', projectId: 7, projectName: 'Cobros' } : null
process.stdout.write(JSON.stringify({ schemaVersion: 3, ok: true, command: args.join(' '), generatedAt: new Date().toISOString(), data }) + '\\n')
`,
  )
  const registry = box.env['KIT_REGISTRY_DIR'] as string
  mkdirSync(registry, { recursive: true })
  writeFileSync(
    join(registry, 'bita.json'),
    JSON.stringify({ manifestVersion: 1, name: 'bita', version: '1.3.1', bin: [process.execPath, script], envelope: 1, capabilities: ['time.entries.read'], emits: [], subscribes: [] }),
  )
}

async function subscribe(box: Sandbox): Promise<string> {
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
  await registerTool(
    defineManifest({
      name: 'listener',
      version: '1.0.0',
      bin: [process.execPath, script],
      capabilities: [],
      subscribes: [{ tool: 'inkwell', events: ['docs.changed'], command: [process.execPath, script] }],
    }),
    platformContext({ env: box.env }),
  )
  return out
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

function docsGit(box: Sandbox, ...args: string[]): string {
  return execFileSync('git', args, { cwd: box.env['INKWELL_DOCS_DIR'] as string, encoding: 'utf8', env: box.env })
}

async function autodocWorld(t: { after: (fn: () => void) => void }) {
  const box = sandbox(t, { KIT_NO_EVENTS: '' })
  const claude = fakeClaude(box)
  const file = await subscribe(box)
  box.ok('space', 'add', 'Cobros', '--key', 'COB')
  const root = box.ok('page', 'new', 'Arquitectura', '--project', 'COB').page
  box.ok('page', 'write', String(root.pageId), '--body', '# Arquitectura\n\n## Red\n\nTodo pasa por el balanceador.\n\n## Datos\n\nPostgres 16.')
  fakeBitaRepo(box)
  const db = new DatabaseSync(box.env['INKWELL_DB_PATH'] as string)
  db.prepare('UPDATE spaces SET external_ref = ? WHERE id = ?').run('bita:project:7', root.spaceId)
  db.close()
  const cwd = join(box.dir, 'work')
  mkdirSync(cwd, { recursive: true })
  const long = 'El servicio de cobros publica cada pago confirmado en la cola pagos-confirmados y el conciliador lo consume cada cinco minutos. '.repeat(8)
  const transcript = join(box.dir, 'transcript.jsonl')
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Como concilia el servicio de cobros?' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: long }] } }),
    ].join('\n') + '\n',
  )
  const run = () => box.ok('autodoc-run', '--transcript', transcript, '--session', SESSION, '--cwd', cwd)
  await received(file, 2).catch(() => undefined)
  return { box, claude, file, root, run }
}

test('autodoc create writes the page from the inkwell process, which emits even though the model child is silenced', async (t) => {
  const w = await autodocWorld(t)
  const baseline = (await received(w.file, 2)).length
  w.claude.answer([{ action: 'create', title: 'Cola de pagos', parentId: w.root.pageId, markdown: '## Que es\n\nLa cola pagos-confirmados guarda cada pago confirmado.', reason: 'Documenta la cola.' }])
  const result = w.run()
  assert.equal(result.outcomes[0].kind, 'create')
  assert.deepEqual(w.claude.envKeys(), ['1'])
  const events = await received(w.file, baseline + 1)
  const last = events.at(-1)
  assert.equal(last.event, 'docs.changed')
  assert.equal(last.body.docsRoot, w.box.env['INKWELL_DOCS_DIR'])
  assert.equal(last.body.commit, docsGit(w.box, 'rev-parse', 'HEAD').trim())
  assert.ok(last.body.changes.some((change: { action: string; relPath: string }) => change.action === 'written' && change.relPath === 'cobros/arquitectura/cola-de-pagos.md'))
})

test('autodoc propose commits only to its branch, so the main docs emit nothing for it, and applying it emits written', async (t) => {
  const w = await autodocWorld(t)
  const baseline = (await received(w.file, 2)).length
  w.claude.answer([{ action: 'propose', pageId: w.root.pageId, section: 'Red', markdown: '## Red\n\nTodo pasa por el balanceador y el WAF.', reason: 'El WAF quedo delante.' }])
  const outcome = w.run().outcomes[0]
  assert.equal(outcome.kind, 'propose')
  await sleep(400)
  assert.equal((await received(w.file, baseline)).length, baseline)

  const applied = w.box.ok('branch', 'apply', outcome.branch, '--commit', outcome.sha)
  const events = await received(w.file, baseline + 1)
  assert.equal(events.length, baseline + 1)
  const last = events.at(-1)
  assert.equal(last.body.commit, applied.appliedSha)
  assert.deepEqual(last.body.changes, [{ action: 'written', relPath: 'cobros/arquitectura.md' }])
  await sleep(300)
  assert.equal((await received(w.file, baseline + 1)).length, baseline + 1)
})

test('the model child is always silenced, even when the parent environment tries to turn events on, and the run process keeps what it got', () => {
  for (const agent of agents.HEADLESS_AGENTS) {
    assert.equal(agents.headlessEnvironment(agent, { KIT_NO_EVENTS: '', PATH: '/bin' }, modelExtras(agent))['KIT_NO_EVENTS'], '1')
    assert.equal(agents.headlessEnvironment(agent, { PATH: '/bin' }, modelExtras(agent))['KIT_NO_EVENTS'], '1')
  }
  assert.equal(runEnvironment({ PATH: '/bin' }, { INKWELL_AUTODOC: '1' })['KIT_NO_EVENTS'], undefined)
  assert.equal(runEnvironment({ KIT_NO_EVENTS: '1' }, { INKWELL_AUTODOC: '1' })['KIT_NO_EVENTS'], '1')
})
