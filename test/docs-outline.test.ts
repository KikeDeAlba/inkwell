import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { outline, parseDocument, renderDocument } from '../src/docs/markdown.ts'

const lines = (...parts: string[]): string => parts.join('\n')

test('the outline follows the order of the document, not a fixed list', () => {
  const doc = parseDocument(
    lines('# Credenciales', '', '## Dónde viven', '', 'Un secreto.', '', '## Rotación', '', 'Cada 90 días.', ''),
  )

  assert.deepEqual(
    outline(doc).map((heading) => [heading.heading, heading.level, heading.order]),
    [
      ['Dónde viven', 2, 0],
      ['Rotación', 2, 1],
    ],
  )
})

test('two headings with the same text get different anchors', () => {
  const doc = parseDocument(lines('# T', '', '## Notas', '', 'Una.', '', '## Notas', '', 'Otra.', ''))

  assert.deepEqual(
    outline(doc).map((heading) => heading.anchor),
    ['notas', 'notas-2'],
  )
})

test('a document without headings has an empty outline', () => {
  assert.deepEqual(outline(parseDocument(lines('# Solo un título', '', 'Un párrafo.', ''))), [])
})

test('a heading with nothing under it is empty', () => {
  const doc = parseDocument(lines('# T', '', '## Vacía', '', '   ', '', '## Escrita', '', 'Algo.', ''))

  assert.deepEqual(
    outline(doc).map((heading) => [heading.heading, heading.empty]),
    [
      ['Vacía', true],
      ['Escrita', false],
    ],
  )
})

test('subheadings come out at level three, under their section', () => {
  const doc = parseDocument(
    lines('# T', '', '## Arranque', '', 'Intro.', '', '### Dev', '', 'Detalle.', '', '### Test', '', '## Otra', ''),
  )

  assert.deepEqual(
    outline(doc).map((heading) => [heading.heading, heading.level, heading.empty]),
    [
      ['Arranque', 2, false],
      ['Dev', 3, false],
      ['Test', 3, true],
      ['Otra', 2, true],
    ],
  )
})

test('a heading inside a fenced block is not a section', () => {
  const doc = parseDocument(
    lines('# T', '', '## Contexto', '', 'Así no:', '', '```md', '## Esto no es una sección', '```', '', 'Fin.', ''),
  )

  assert.deepEqual(
    doc.sections.map((section) => section.heading),
    ['Contexto'],
  )
  assert.equal(doc.sections[0]?.body.includes('## Esto no es una sección'), true)
  assert.deepEqual(
    outline(doc).map((heading) => heading.heading),
    ['Contexto'],
  )
})

test('a subheading inside a fenced block is not a subheading', () => {
  const doc = parseDocument(lines('# T', '', '## Contexto', '', '~~~md', '### Tampoco esta', '~~~', '', 'Fin.', ''))

  assert.deepEqual(
    outline(doc).map((heading) => heading.heading),
    ['Contexto'],
  )
})

test('a fenced block survives the round trip untouched', () => {
  const source = lines('# T', '', '## Diagrama', '', '```mermaid', 'flowchart LR', '  A --> B', '```', '')

  assert.equal(renderDocument(parseDocument(source)).includes('```mermaid\nflowchart LR\n  A --> B\n```'), true)
})
