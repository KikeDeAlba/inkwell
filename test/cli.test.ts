import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertConformance } from '@kikedealba/kit/conformance'
import { readManifest } from '@kikedealba/kit/registry'
import { platformContext } from '@kikedealba/kit/platform'
import { agents } from '@kikedealba/kit'
import { ANTIGRAVITY_RULES_FILE, CAPABILITIES, integration, manifest } from '../src/setup.ts'
import { HELP } from '../src/cli/router.ts'
import { BIN, registerFakeBita, sandbox } from './helpers/sandbox.ts'

const ENTRY = {
  id: 77,
  description: 'Ajustar el WAF',
  kind: null,
  projectId: 3,
  projectName: 'Apartados',
  startedAt: '2026-10-09T15:00:00.000Z',
  stoppedAt: '2026-10-09T16:30:00.000Z',
  note: null,
}

test('inkwell passes the kit conformance checks', async (t) => {
  const box = sandbox(t)
  await assertConformance([process.execPath, BIN], manifest(), platformContext({ env: box.env }))
})

test('capabilities lists every documentation capability of the contract', (t) => {
  const box = sandbox(t)
  const data = box.ok('capabilities')
  assert.equal(data.name, 'inkwell')
  assert.deepEqual(data.capabilities, CAPABILITIES)
  for (const capability of ['docs.page.read', 'docs.page.write', 'docs.backlog', 'docs.history', 'docs.propose', 'docs.diagrams', 'docs.export.pdf', 'docs.confluence.sync', 'docs.entry-notes']) {
    assert.ok(data.capabilities.includes(capability), capability)
  }
})

test('setup registers the manifest with the bita subscription and installs the skill for the chosen agents', async (t) => {
  const box = sandbox(t)
  const data = box.ok('setup', '--agents', 'codex,gemini', '--no-drawio')
  assert.ok(data.manifest.endsWith('inkwell.json'))
  const registered = await readManifest('inkwell', platformContext({ env: box.env }))
  assert.ok(registered)
  assert.deepEqual(registered.subscribes[0]?.tool, 'bita')
  assert.ok(registered.subscribes[0]?.events.includes('delete'))
  assert.ok(registered.subscribes[0]?.events.includes('merge'))
  assert.deepEqual(registered.subscribes[0]?.command.slice(-1), ['bita-hook'])
  assert.ok(data.steps.some((step: { agent: string }) => step.agent === 'codex'))
  assert.ok(data.steps.some((step: { agent: string }) => step.agent === 'gemini'))
  assert.equal(data.steps.some((step: { agent: string }) => step.agent === 'claude'), false)

  const codexHooks = JSON.parse(readFileSync(join(box.dir, '.codex', 'hooks.json'), 'utf8')).hooks
  for (const event of ['PreCompact', 'SessionEnd']) assert.equal(codexHooks[event][0].hooks[0].command, 'inkwell hook session-end --harness codex', event)
  const geminiHooks = JSON.parse(readFileSync(join(box.dir, '.gemini', 'extensions', 'inkwell', 'hooks', 'hooks.json'), 'utf8')).hooks
  for (const event of ['PreCompress', 'SessionEnd']) assert.equal(geminiHooks[event][0].hooks[0].command, 'inkwell hook session-end --harness gemini', event)

  const removed = box.ok('uninstall')
  assert.equal(removed.unregistered, true)
  const left = JSON.parse(readFileSync(join(box.dir, '.codex', 'hooks.json'), 'utf8')).hooks
  assert.equal(left['PreCompact'], undefined)
  assert.equal(left['SessionEnd'], undefined)
})

test('every kit agent is offered, antigravity gets a short always-on rule, and claude desktop gets nothing', () => {
  for (const agent of agents.AGENTS) assert.ok(HELP.includes(agent), agent)
  const tools = integration()
  assert.equal(tools.antigravity?.rules, ANTIGRAVITY_RULES_FILE)
  const rule = readFileSync(ANTIGRAVITY_RULES_FILE, 'utf8').trim().split('\n')
  assert.ok(rule.length >= 1 && rule.length <= 4)
  assert.match(rule.join(' '), /skill `inkwell`/)
  assert.equal(tools.claudeDesktop, undefined)
})

test('spaces, pages, links and backlog work from the CLI, and --space is an alias of --project', (t) => {
  const box = sandbox(t)
  registerFakeBita(box, [ENTRY], [77])
  const space = box.ok('space', 'add', 'Apartados', '--key', 'APT', '--external-ref', 'bita:project:3')
  assert.equal(space.key, 'APT')

  const created = box.ok('page', 'new', 'Arquitectura', '--space', 'APT')
  const pageId = String(created.page.pageId)
  assert.equal(created.page.relPath, 'apartados/arquitectura.md')

  const body = join(box.dir, 'body.md')
  writeFileSync(body, '## Estado\n\nEl WAF bloquea admin.\n\n## Pendiente\n\n- rotar\n')
  const written = box.ok('page', 'write', pageId, '--md', body)
  assert.equal(written.warnings[0].code, 'BACKLOG_SECTION_IN_PAGE')
  assert.match(written.warnings[0].message, /inkwell backlog add/)

  const linked = box.ok('page', 'link', pageId, '--entry', '77', '--summary', 'Se abrió el WAF.')
  assert.equal(linked.page.entryCount, 1)
  assert.equal(linked.page.durationSeconds, 5400)
  const byEntry = box.ok('page', 'ls', '--entry', '77')
  assert.deepEqual(byEntry.pages.map((page: { pageId: number }) => page.pageId), [Number(pageId)])
  assert.deepEqual(box.ok('page', 'ls', '--entry', '78').pages, [])

  const child = box.ok('page', 'new', 'WAF', '--from-entry', '77', '--parent', pageId)
  assert.equal(child.page.parentId, Number(pageId))

  const fromBitaId = box.ok('page', 'new', 'Runbook', '--project', '3')
  assert.equal(fromBitaId.page.projectId, space.id)

  const shown = box.ok('page', 'show', pageId)
  assert.equal(shown.entries[0].entryId, 77)
  assert.equal(shown.entries[0].title, 'Ajustar el WAF')
  assert.equal(shown.entries[0].summary, 'Se abrió el WAF.')
  assert.match(shown.doc.markdown, /El WAF bloquea admin/)

  const item = box.ok('backlog', 'add', '--kind', 'finding', '--title', 'El NAT vive en una sola AZ')
  assert.equal(item.key, 'APT-1')
  assert.equal(item.entryId, 77)
  assert.equal(item.originRef, 'bita:entry:77')
  assert.equal(item.pageId, Number(pageId))

  const listed = box.run(['backlog', 'ls', '--project', 'Apartados'])
  assert.equal(listed.json.data.length, 1)
  assert.equal(box.ok('backlog', 'resolve', 'APT-1', '--resolution', 'dos NAT').status, 'resolved')

  const tree = box.ok('tree')
  assert.equal(tree.spaces[0].projectName, 'Apartados')
  assert.equal(tree.spaces[0].pageCount, 3)

  const history = box.ok('page', 'history', pageId)
  assert.equal(history.revisions.length, 2)

  const found = box.ok('search', 'waf')
  assert.ok(found.some((hit: { pageId: number }) => hit.pageId === Number(pageId)))

  const html = join(box.dir, 'out', 'page.html')
  const exported = box.ok('export', 'page', pageId, '--html', html)
  assert.equal(exported.format, 'html')
  assert.match(readFileSync(html, 'utf8'), /<h1 class="print-title">Arquitectura<\/h1>/)
})

test('without bita, entries are still linked but flagged, and backlog needs a place', (t) => {
  const box = sandbox(t)
  box.ok('space', 'add', 'CoDi')
  const created = box.ok('page', 'new', 'Reglas', '--project', 'CoDi')
  const linked = box.ok('page', 'link', String(created.page.pageId), '--entry', '5')
  assert.match(linked.warnings[0], /bita is not installed/)
  const missing = box.run(['backlog', 'add', '--kind', 'pending', '--title', 'x'])
  assert.equal(missing.status, 2)
  assert.equal(missing.json.error.code, 'USAGE_ERROR')
  const unknown = box.run(['page', 'new', 'X', '--project', 'nadie'])
  assert.equal(unknown.json.error.code, 'PROJECT_NOT_FOUND')
})

test('bita delete and merge events keep the links pointing at entries that exist', (t) => {
  const box = sandbox(t)
  box.ok('space', 'add', 'CoDi')
  const page = String(box.ok('page', 'new', 'Reglas', '--project', 'CoDi').page.pageId)
  box.ok('page', 'link', page, '--entry', '10,11,12')
  box.ok('backlog', 'add', '--kind', 'pending', '--title', 'Algo', '--page', page, '--origin', 'bita:entry:11')

  const merged = box.run(['bita-hook'], JSON.stringify({ event: 'merge', source: 'bita', entry: { id: 10, description: 'Junta', start: '2026-10-09T15:00:00.000Z', stop: '2026-10-09T16:00:00.000Z' }, mergedIds: [11] }))
  assert.equal(merged.status, 0, merged.stderr)
  assert.equal(merged.json.data.linksMerged, 1)
  assert.equal(merged.json.data.backlogUpdated, 1)

  const afterMerge = box.ok('page', 'show', page)
  assert.deepEqual(afterMerge.entries.map((entry: { entryId: number }) => entry.entryId).sort(), [10, 12])
  assert.equal(box.ok('backlog', 'ls')[0].originRef, 'bita:entry:10')

  const deleted = box.run(['bita-hook'], JSON.stringify({ event: 'delete', source: 'bita', entry: { id: 12 } }))
  assert.equal(deleted.json.data.linksRemoved, 1)
  assert.deepEqual(box.ok('page', 'show', page).entries.map((entry: { entryId: number }) => entry.entryId), [10])

  const stopped = box.run(['bita-hook'], JSON.stringify({ event: 'stop', source: 'bita', entry: { id: 20, description: 'Nuevo', start: '2026-10-09T17:00:00.000Z', stop: '2026-10-09T17:30:00.000Z' }, pageIds: [Number(page), 999] }))
  assert.equal(stopped.json.data.linksAdded, 1)
  const withNew = box.ok('page', 'show', page).entries.find((entry: { entryId: number }) => entry.entryId === 20)
  assert.equal(withNew.durationSeconds, 1800)
})

test('migrate status answers the contract shape before any migration', (t) => {
  const box = sandbox(t)
  assert.deepEqual(box.ok('migrate', 'status'), { migrated: false, bitaDatabase: null, migratedAt: null })
})

test('unknown commands fail with a usage envelope and exit 2', (t) => {
  const box = sandbox(t)
  const result = box.run(['nope'])
  assert.equal(result.status, 2)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error.code, 'USAGE_ERROR')
})

test('renaming or moving a parent carries the whole subtree, and moving without --parent keeps the parent', (t) => {
  const box = sandbox(t)
  box.ok('space', 'add', 'CoDi')
  const parent = String(box.ok('page', 'new', '--project', 'CoDi', 'Reglas').page.pageId)
  const child = box.ok('page', 'new', 'Límites', '--parent', parent).page
  assert.equal(child.relPath, 'codi/reglas/limites.md')

  const same = box.ok('page', 'rename', parent, 'REGLAS')
  assert.equal(same.page.relPath, 'codi/reglas.md')

  box.ok('page', 'rename', parent, 'Reglas de negocio')
  const moved = box.ok('page', 'show', String(child.pageId))
  assert.equal(moved.relPath, 'codi/reglas-de-negocio/limites.md')
  assert.equal(moved.doc.file.status, 'ok')
  assert.equal(existsSync(join(box.env['INKWELL_DOCS_DIR'] as string, 'codi', 'reglas')), false)

  const reordered = box.ok('page', 'move', String(child.pageId), '--position', '0')
  assert.equal(reordered.page.parentId, Number(parent))
  assert.equal(reordered.page.relPath, 'codi/reglas-de-negocio/limites.md')
  assert.deepEqual(box.ok('git', 'status').dirty, [])
})
