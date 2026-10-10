import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { registerFakeBita, sandbox, type FakeEntry, type Sandbox } from './helpers/sandbox.ts'

const ENTRY: FakeEntry = {
  id: 41,
  description: 'Revisar el WAF',
  kind: null,
  projectId: 3,
  projectName: 'Apartados',
  startedAt: '2026-10-09T15:00:00.000Z',
  stoppedAt: null,
  note: null,
}

function docsDir(box: Sandbox): string {
  return box.env['INKWELL_DOCS_DIR'] as string
}

function gitLog(box: Sandbox): string[] {
  return execFileSync('git', ['log', '--format=%s'], { cwd: docsDir(box), encoding: 'utf8', env: box.env }).trim().split('\n')
}

function hook(box: Sandbox, document: Record<string, unknown>): any {
  const result = box.run(['bita-hook'], JSON.stringify({ source: 'bita', docPath: null, pageIds: [], ...document }))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.json.data.note.error, null)
  return result.json.data
}

function eventEntry(entry: FakeEntry, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: entry.id, description: entry.description, kind: entry.kind, projectId: entry.projectId, projectName: entry.projectName, start: entry.startedAt, stop: entry.stoppedAt, ...extra }
}

test('note save, show, get, path, ls and search follow the bita note contract', (t) => {
  const box = sandbox(t, { INKWELL_NO_BITA: '1', TZ: 'UTC' })
  registerFakeBita(box, [ENTRY], [41])
  box.ok('config', 'set', 'timezone', 'America/Mexico_City')

  const planned = box.ok('note', 'path', '41')
  assert.equal(planned.relPath, 'apartados/2026/10/09-41-revisar-el-waf.md')
  assert.equal(planned.exists, false)

  const saved = box.run(['note', 'save', '41', '--section', 'Contexto', '--md', '-'], 'El WAF bloquea /admin desde la VPN.\n')
  assert.equal(saved.status, 0, saved.stderr)
  assert.equal(saved.json.command, 'note save')
  assert.equal(saved.json.data.created, true)
  assert.equal(saved.json.data.relPath, planned.relPath)

  const meeting = join(box.dir, 'minuta.md')
  writeFileSync(meeting, '- Se acordó abrir la regla.\n')
  const second = box.ok('note', 'save', '--entry', '41', '--note-md', meeting, '--section', 'Reunión', '--command', 'aws wafv2 list-web-acls')
  assert.equal(second.created, false)

  const markdown = readFileSync(join(docsDir(box), planned.relPath), 'utf8')
  assert.match(markdown, /^---\ninkwell: 1\nentryId: 41\n/)
  assert.match(markdown, /# Revisar el WAF/)
  assert.match(markdown, /## Contexto\n\nEl WAF bloquea \/admin desde la VPN\./)
  assert.match(markdown, /## Qué se hizo/)
  assert.match(markdown, /## Pendiente/)
  assert.match(markdown, /## Reunión\n\n- Se acordó abrir la regla\./)
  assert.match(markdown, /## Tocado\n\n### Comandos\n\n- `aws wafv2 list-web-acls`/)

  const shown = box.ok('note', 'show', '41')
  assert.equal(shown.entryId, 41)
  assert.equal(shown.title, 'Revisar el WAF')
  assert.equal(shown.projectName, 'Apartados')
  assert.equal(shown.running, true)
  assert.equal(shown.doc.relPath, planned.relPath)
  assert.equal(shown.doc.frontMatter.entryId, '41')
  assert.ok(shown.doc.sections.some((section: { heading: string; state: string }) => section.heading === 'Contexto' && section.state === 'written'))
  assert.equal(box.ok('note', 'show', '--path', planned.relPath).entryId, 41)

  const got = box.ok('note', 'get', '41')
  assert.equal(got.entryId, 41)
  assert.match(got.markdown, /Se acordó/)
  assert.equal(box.ok('note', '41').relPath, planned.relPath)

  const perEntry = box.run(['note', 'ls', '41'])
  assert.equal(perEntry.json.data.length, 1)
  assert.equal(perEntry.json.data[0].ref, 'bita:entry:41')

  const listed = box.run(['note', 'ls', '--from', '2026-10-01', '--to', '2026-10-31', '--project', 'Apartados'])
  assert.equal(listed.json.data.length, 1)
  assert.equal(listed.json.data[0].doc.file.status, 'ok')
  assert.equal(listed.json.meta.page.total, 1)
  assert.equal(box.ok('note', 'ls', '--from', '2026-09-01', '--to', '2026-09-30').length, 0)

  const found = box.run(['note', 'search', 'vpn'])
  assert.equal(found.json.data.length, 1)
  assert.equal(found.json.data[0].entryId, 41)
  assert.equal(found.json.data[0].matches[0].section, 'Contexto')

  assert.deepEqual(gitLog(box).slice(0, 2), ['docs(apartados): update note revisar el WAF', 'docs(apartados): create note revisar el WAF'])

  const missing = box.run(['note', 'show', '999'])
  assert.equal(missing.json.error.code, 'ENTRY_NOT_FOUND')
  const bad = box.run(['note', 'save', '41', '--section', 'Contexto'])
  assert.equal(bad.json.error.code, 'USAGE_ERROR')
})

test('bita events create, rename, stamp, merge and remove the entry notes', (t) => {
  const box = sandbox(t, { INKWELL_NO_BITA: '1' })
  box.ok('config', 'set', 'timezone', 'UTC')

  const started = hook(box, { event: 'start', entry: eventEntry(ENTRY) })
  assert.equal(started.note.action, 'created')
  const first = 'apartados/2026/10/09-41-revisar-el-waf.md'
  assert.equal(started.note.relPath, first)
  const skeleton = readFileSync(join(docsDir(box), first), 'utf8')
  assert.match(skeleton, /## Contexto\n\n## Qué se hizo\n\n## Pendiente/)
  assert.equal(hook(box, { event: 'start', entry: eventEntry(ENTRY) }).note.action, 'none')

  box.run(['note', 'save', '41', '--section', 'Qué se hizo', '--md', '-'], 'Se revisó la regla 7.\n')

  const amended = hook(box, { event: 'amend', entry: eventEntry(ENTRY, { description: 'Abrir el WAF', projectId: 5, projectName: 'CoDi' }), previousTitle: 'Revisar el WAF', previousProjectId: 3 })
  assert.equal(amended.note.action, 'moved')
  const moved = 'codi/2026/10/09-41-abrir-el-waf.md'
  assert.equal(amended.note.relPath, moved)
  assert.equal(existsSync(join(docsDir(box), first)), false)
  assert.equal(existsSync(join(docsDir(box), 'apartados')), false)
  assert.match(readFileSync(join(docsDir(box), moved), 'utf8'), /Se revisó la regla 7\./)

  const stopped = hook(box, { event: 'stop', entry: eventEntry(ENTRY, { description: 'Abrir el WAF', projectId: 5, projectName: 'CoDi', stop: '2026-10-09T16:30:00.000Z', durationSeconds: 5400 }) })
  assert.equal(stopped.note.action, 'updated')
  const stamped = readFileSync(join(docsDir(box), moved), 'utf8')
  assert.match(stamped, /endedAt: 2026-10-09T16:30:00.000Z/)
  assert.match(stamped, /duration: 1h 30m/)

  const other = { ...ENTRY, id: 42, description: 'Seguir con el WAF', projectId: 5, projectName: 'CoDi', startedAt: '2026-10-10T15:00:00.000Z' }
  hook(box, { event: 'start', entry: eventEntry(other) })
  box.run(['note', 'save', '42', '--section', 'Qué se hizo', '--md', '-'], 'Se abrió la regla 7.\n')
  box.run(['note', 'save', '42', '--section', 'Hallazgos', '--md', '-'], 'La regla 9 también bloquea.\n')
  hook(box, { event: 'stop', entry: eventEntry(other, { stop: '2026-10-10T15:30:00.000Z' }) })

  const merged = hook(box, { event: 'merge', entry: eventEntry(ENTRY, { description: 'Abrir el WAF', projectId: 5, projectName: 'CoDi', stop: '2026-10-09T16:30:00.000Z', durationSeconds: 7200 }), mergedIds: [42] })
  assert.equal(merged.note.action, 'merged')
  assert.deepEqual(merged.note.removed, ['codi/2026/10/10-42-seguir-con-el-waf.md'])
  const survivor = readFileSync(join(docsDir(box), moved), 'utf8')
  assert.match(survivor, /## Qué se hizo\n\nSe revisó la regla 7\.\n\nSe abrió la regla 7\./)
  assert.match(survivor, /## Hallazgos\n\nLa regla 9 también bloquea\./)
  assert.match(survivor, /duration: 2h/)
  assert.equal(existsSync(join(docsDir(box), 'codi', '2026', '10', '10-42-seguir-con-el-waf.md')), false)
  assert.equal(box.ok('note', 'ls', '42').length, 0)

  const deleted = hook(box, { event: 'delete', entry: { id: 41 } })
  assert.equal(deleted.note.action, 'removed')
  assert.equal(existsSync(join(docsDir(box), moved)), false)
  assert.equal(box.ok('note', 'ls').length, 0)
  assert.equal(hook(box, { event: 'cancel', entry: { id: 41 } }).note.action, 'none')

  const log = gitLog(box)
  assert.match(log[0] ?? '', /^docs\(codi\): remove note abrir el WAF/)
  assert.ok(log.some((subject) => subject.startsWith('docs(codi): merge notes into abrir el WAF')))
  assert.ok(log.some((subject) => subject.startsWith('docs(codi): move note abrir el WAF')))
})

test('older bita amend events without previousTitle still stamp the note, and an amend without a note does nothing', (t) => {
  const box = sandbox(t, { INKWELL_NO_BITA: '1' })
  box.ok('config', 'set', 'timezone', 'UTC')
  assert.equal(hook(box, { event: 'amend', entry: eventEntry(ENTRY), previousKind: null }).note.action, 'none')
  assert.equal(existsSync(join(docsDir(box), 'apartados')), false)
  hook(box, { event: 'start', entry: eventEntry(ENTRY) })
  const amended = hook(box, { event: 'amend', entry: eventEntry(ENTRY, { kind: 'remote-meeting' }), previousKind: null })
  assert.equal(amended.note.action, 'updated')
  assert.match(readFileSync(join(docsDir(box), amended.note.relPath), 'utf8'), /kind: remote-meeting/)
})
