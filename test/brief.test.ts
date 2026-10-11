import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { registerFakeBita, sandbox, type FakeEntry } from './helpers/sandbox.ts'

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

test('page show --brief returns the markdown body and ids only, and --section one section', (t) => {
  const box = sandbox(t)
  registerFakeBita(box, [ENTRY], [41])
  box.ok('space', 'add', 'Apartados', '--key', 'APT')
  const pageId = String(box.ok('page', 'new', 'Arquitectura', '--space', 'APT').page.pageId)
  const body = join(box.dir, 'body.md')
  writeFileSync(body, '## Estado\n\nEl WAF bloquea admin.\n\n## Red\n\nUna sola AZ.\n')
  box.ok('page', 'write', pageId, '--md', body)

  const full = box.run(['page', 'show', pageId])
  const brief = box.run(['page', 'show', pageId, '--brief'])
  assert.equal(brief.status, 0, brief.stderr)
  const data = brief.json.data
  assert.deepEqual(Object.keys(data).sort(), ['markdown', 'pageId', 'relPath', 'sections', 'space', 'title'])
  assert.equal(data.pageId, Number(pageId))
  assert.equal(data.space, 'Apartados')
  assert.deepEqual(data.sections, ['Estado', 'Red'])
  assert.match(data.markdown, /^# Arquitectura/)
  assert.doesNotMatch(data.markdown, /^---/)
  assert.match(data.markdown, /Una sola AZ\./)
  assert.equal(brief.json.meta, undefined)
  assert.ok(brief.stdout.length < full.stdout.length)

  const section = box.ok('page', 'show', pageId, '--section', 'red')
  assert.equal(section.section, 'Red')
  assert.equal(section.markdown, '## Red\n\nUna sola AZ.')

  const missing = box.run(['page', 'show', pageId, '--section', 'Costos'])
  assert.notEqual(missing.status, 0)
  assert.equal(missing.json.error.code, 'SECTION_NOT_FOUND')
  assert.match(missing.json.error.hint, /Estado, Red/)
})

test('note show --brief and --section return the note body without front matter', (t) => {
  const box = sandbox(t, { INKWELL_NO_BITA: '1', TZ: 'UTC' })
  registerFakeBita(box, [ENTRY], [41])
  const saved = box.run(['note', 'save', '41', '--section', 'Contexto', '--md', '-'], 'El WAF bloquea /admin desde la VPN.\n')
  assert.equal(saved.status, 0, saved.stderr)

  const full = box.run(['note', 'show', '41'])
  const brief = box.run(['note', 'show', '41', '--brief'])
  assert.equal(brief.status, 0, brief.stderr)
  const data = brief.json.data
  assert.deepEqual(Object.keys(data).sort(), ['entryId', 'localDay', 'markdown', 'relPath', 'running', 'sections', 'space', 'title'])
  assert.equal(data.entryId, 41)
  assert.equal(data.running, true)
  assert.match(data.markdown, /^# Revisar el WAF/)
  assert.doesNotMatch(data.markdown, /entryId:/)
  assert.ok(data.sections.includes('Contexto'))
  assert.ok(brief.stdout.length < full.stdout.length)

  const section = box.ok('note', 'show', '41', '--section', 'Contexto')
  assert.equal(section.markdown, '## Contexto\n\nEl WAF bloquea /admin desde la VPN.')
})

test('note show --brief on an entry without a note returns a null body', (t) => {
  const box = sandbox(t, { INKWELL_NO_BITA: '1', TZ: 'UTC' })
  registerFakeBita(box, [ENTRY], [41])
  const data = box.ok('note', 'show', '41', '--brief')
  assert.equal(data.entryId, 41)
  assert.equal(data.markdown, null)
  assert.equal(data.relPath, null)
})

test('guide prints the shared writing rules', (t) => {
  const box = sandbox(t)
  const listed = box.ok('guide')
  assert.deepEqual(listed.guides, ['writing', 'entry-notes', 'diagrams', 'confluence'])
  const writing = box.ok('guide', 'writing')
  assert.match(writing.markdown, /Así no/)
  assert.equal(box.run(['guide', 'nope']).json.error.code, 'USAGE_ERROR')
})
