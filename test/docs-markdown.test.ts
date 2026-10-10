import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  checksumOf,
  documentBody,
  emptyDocument,
  filledSections,
  outline,
  parseDocument,
  renderDocument,
  stampFrontMatter,
  upsertSection,
} from '../src/docs/markdown.ts'

const LEGACY_ENTRY_DOC_SECTIONS: readonly string[] = ['Contexto', 'Qué se hizo', 'Decisiones', 'Hallazgos', 'Verificación', 'Pendiente', 'Tocado']
const LEGACY_ENTRY_DOC_SECTIONS_REQUIRED: readonly string[] = ['Contexto', 'Qué se hizo', 'Pendiente']

const canonical = `---
bita: 1
entryId: 128
title: Ajustar el pipeline
project: Apartados
jira:
---

# Ajustar el pipeline

## Contexto

El worker bloqueaba la API.

## Qué se hizo

- El endpoint responde 202.

## Pendiente

- Falta la alarma de la cola muerta.
`

test('round-trips a canonical document byte for byte', () => {
  assert.equal(renderDocument(parseDocument(canonical)), canonical)
})

test('reads the front matter, the title and the sections', () => {
  const doc = parseDocument(canonical)
  assert.equal(doc.frontMatterValid, true)
  assert.equal(doc.frontMatter.get('entryId'), '128')
  assert.equal(doc.frontMatter.get('jira'), '')
  assert.equal(doc.title, 'Ajustar el pipeline')
  assert.deepEqual(
    doc.sections.map((section) => section.heading),
    ['Contexto', 'Qué se hizo', 'Pendiente'],
  )
})

test('rewriting a section with the same body changes nothing', () => {
  const doc = parseDocument(canonical)
  const again = upsertSection(doc, 'Contexto', 'El worker bloqueaba la API.')
  assert.equal(again.changed, false)
  assert.equal(again.created, false)
  assert.equal(renderDocument(again.doc), canonical)
})

test('rewriting a section with a new body replaces it in place', () => {
  const doc = parseDocument(canonical)
  const edited = upsertSection(doc, 'Contexto', 'Otro contexto.')
  assert.equal(edited.changed, true)
  assert.equal(edited.created, false)
  assert.deepEqual(
    edited.doc.sections.map((section) => section.heading),
    ['Contexto', 'Qué se hizo', 'Pendiente'],
  )
  assert.match(renderDocument(edited.doc), /## Contexto\n\nOtro contexto\./)
})

test('a new canonical section lands in its canonical place when an order is given', () => {
  const doc = parseDocument(canonical)
  const withFindings = upsertSection(
    doc,
    'Hallazgos',
    'El SDK devuelve 200 con cuerpo vacío.',
    LEGACY_ENTRY_DOC_SECTIONS,
  )
  assert.equal(withFindings.created, true)
  assert.deepEqual(
    withFindings.doc.sections.map((section) => section.heading),
    ['Contexto', 'Qué se hizo', 'Hallazgos', 'Pendiente'],
  )
})

test('a section outside the given order goes to the end', () => {
  const doc = parseDocument(canonical)
  const extra = upsertSection(doc, 'Resumen', 'Nota antigua en prosa.', LEGACY_ENTRY_DOC_SECTIONS)
  assert.equal(extra.doc.sections.at(-1)?.heading, 'Resumen')
})

test('without an order a new section appends and never reorders what is already there', () => {
  const doc = parseDocument(canonical)
  const before = doc.sections.map((section) => section.heading)
  const added = upsertSection(doc, 'Hallazgos', 'El SDK devuelve 200 con cuerpo vacío.')

  assert.equal(added.created, true)
  assert.deepEqual(added.doc.sections.map((section) => section.heading), [...before, 'Hallazgos'])
})

test('text written by hand outside the sections survives', () => {
  const withPreamble = canonical.replace(
    '# Ajustar el pipeline\n',
    '# Ajustar el pipeline\n\nUna nota suelta que escribí a mano.\n',
  )
  const doc = parseDocument(withPreamble)
  assert.equal(doc.preamble, 'Una nota suelta que escribí a mano.')
  assert.match(renderDocument(doc), /Una nota suelta que escribí a mano\./)
})

test('a corrupt front matter is reported instead of being rewritten', () => {
  const broken = '---\nentryId 128\n  indented: yes\n---\n\n# Título\n\n## Contexto\n\nAlgo.\n'
  const doc = parseDocument(broken)
  assert.equal(doc.frontMatterValid, false)
  assert.equal(doc.frontMatter.size, 0)
  assert.equal(doc.title, 'Título')
})

test('a document with no front matter still parses', () => {
  const doc = parseDocument('# Solo título\n\n## Contexto\n\nAlgo.\n')
  assert.equal(doc.frontMatterValid, false)
  assert.equal(doc.title, 'Solo título')
  assert.equal(doc.sections.length, 1)
})

test('a fresh document carries no sections at all', () => {
  const doc = emptyDocument(new Map([['entryId', '7']]), 'Algo nuevo')
  assert.deepEqual(doc.sections, [])
  assert.equal(renderDocument(doc).includes('## '), false)
  assert.equal(renderDocument(doc).includes('# Algo nuevo'), true)
})

test('a seeded document carries the headings it was seeded with', () => {
  const doc = emptyDocument(new Map([['entryId', '7']]), 'Algo nuevo', LEGACY_ENTRY_DOC_SECTIONS_REQUIRED)
  assert.deepEqual(
    doc.sections.map((section) => section.heading),
    ['Contexto', 'Qué se hizo', 'Pendiente'],
  )
  assert.equal(filledSections(doc).length, 0)
  assert.equal(renderDocument(doc).includes('## Contexto\n'), true)
})

test('stamping adds and overwrites front matter keys without dropping the rest', () => {
  const doc = stampFrontMatter(parseDocument(canonical), { jira: 'DD-1896', duration: '1h 12m' })
  assert.equal(doc.frontMatter.get('jira'), 'DD-1896')
  assert.equal(doc.frontMatter.get('duration'), '1h 12m')
  assert.equal(doc.frontMatter.get('entryId'), '128')
})

test('the body leaves out the front matter, the title and the empty sections', () => {
  const doc = upsertSection(parseDocument(canonical), 'Hallazgos', '').doc
  const body = documentBody(doc)
  assert.equal(body.includes('entryId'), false)
  assert.equal(body.includes('# Ajustar el pipeline'), false)
  assert.equal(body.includes('## Hallazgos'), false)
  assert.equal(body.startsWith('## Contexto'), true)
})

test('the checksum changes with the contents', () => {
  assert.equal(checksumOf('a'), checksumOf('a'))
  assert.notEqual(checksumOf('a'), checksumOf('b'))
  assert.match(checksumOf('a'), /^sha256:[0-9a-f]{64}$/)
})
