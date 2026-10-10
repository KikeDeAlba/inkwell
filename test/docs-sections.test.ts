import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseDocument, sectionStates } from '../src/docs/markdown.ts'

const LEGACY_ENTRY_DOC_SECTIONS: readonly string[] = ['Contexto', 'Qué se hizo', 'Decisiones', 'Hallazgos', 'Verificación', 'Pendiente', 'Tocado']

const mixed = `---
bita: 1
entryId: 735
---

# Cognito dev para ejecución local

## Contexto

## Qué se hizo

Se portó el mecanismo de credenciales temporales.

## Pendiente

## Tocado

### Comandos

- \`terraform validate\`
`

test('always returns the seven canonical sections in order', () => {
  const states = sectionStates(parseDocument(mixed), LEGACY_ENTRY_DOC_SECTIONS)
  assert.deepEqual(
    states.filter((section) => section.canonical).map((section) => section.heading),
    [...LEGACY_ENTRY_DOC_SECTIONS],
  )
})

test('tells written, empty and absent apart', () => {
  const states = sectionStates(parseDocument(mixed), LEGACY_ENTRY_DOC_SECTIONS)
  const byHeading = new Map(states.map((section) => [section.heading, section.state]))

  assert.equal(byHeading.get('Contexto'), 'empty')
  assert.equal(byHeading.get('Qué se hizo'), 'written')
  assert.equal(byHeading.get('Decisiones'), 'absent')
  assert.equal(byHeading.get('Hallazgos'), 'absent')
  assert.equal(byHeading.get('Verificación'), 'absent')
  assert.equal(byHeading.get('Pendiente'), 'empty')
  assert.equal(byHeading.get('Tocado'), 'written')
})

test('appends a non canonical heading without reordering the seven', () => {
  const states = sectionStates(parseDocument('# Título\n\n## Notas sueltas\n\nAlgo.\n\n## Contexto\n\nOtra cosa.\n'), LEGACY_ENTRY_DOC_SECTIONS)

  assert.equal(states.length, LEGACY_ENTRY_DOC_SECTIONS.length + 1)
  assert.deepEqual(
    states.slice(0, LEGACY_ENTRY_DOC_SECTIONS.length).map((section) => section.heading),
    [...LEGACY_ENTRY_DOC_SECTIONS],
  )
  assert.deepEqual(states[LEGACY_ENTRY_DOC_SECTIONS.length], {
    heading: 'Notas sueltas',
    state: 'written',
    canonical: false,
  })
})

test('the first of two identical headings wins', () => {
  const states = sectionStates(parseDocument('## Contexto\n\nLa primera.\n\n## Contexto\n'), LEGACY_ENTRY_DOC_SECTIONS)
  const contexto = states.filter((section) => section.heading === 'Contexto')

  assert.equal(contexto.length, 1)
  assert.equal(contexto[0]?.state, 'written')
})

test('a document without any section is seven times absent', () => {
  const states = sectionStates(parseDocument('# Solo un título\n\nUn párrafo suelto.\n'), LEGACY_ENTRY_DOC_SECTIONS)

  assert.equal(states.length, LEGACY_ENTRY_DOC_SECTIONS.length)
  assert.ok(states.every((section) => section.state === 'absent' && section.canonical))
})
