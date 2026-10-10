import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { DocFileRef } from '../src/docs/inspect.ts'
import { findMatches, foldForSearch, scanFiles, type ScanOptions } from '../src/docs/search.ts'

interface SearchCandidateRow {
  doc: DocFileRef
  entryId: number
  projectName: string | null
}

function scanDocuments(docsRoot: string, candidates: SearchCandidateRow[], needle: string, options: ScanOptions = {}) {
  return scanFiles(docsRoot, candidates, (candidate) => candidate.doc, needle, options)
}

const document = `---
bita: 1
entryId: 735
---

# Cognito dev para ejecución local

## Qué se hizo

Se portó el mecanismo de credenciales temporales de AWS.

## Hallazgos

El pool de conexiones se agotaba al cabo de una hora.

## Tocado

### Comandos

- \`./scripts/cognito-user.sh list\`
`

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'inkwell-search-'))
}

function candidate(relPath: string, entryId: number, projectName: string | null): SearchCandidateRow {
  const doc: DocFileRef = { relPath, checksum: 'sha256:stale', byteSize: 0 }
  return { doc, entryId, projectName }
}

function write(docsRoot: string, relPath: string, contents: string): void {
  const path = join(docsRoot, relPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, 'utf8')
}

test('folding never changes the length of the string', () => {
  for (const sample of ['Verificación', 'Qué se hizo', 'añadir', 'ñ', 'Ñ', '🙂', 'İstanbul', 'straße', '']) {
    assert.equal(foldForSearch(sample).length, sample.length, sample)
  }
})

test('an unaccented query finds the accented word', () => {
  const { total, matches } = findMatches('## Verificación\n\nTodo en verde.\n', 'verificacion')
  assert.equal(total, 1)
  assert.equal(matches[0]?.match, 'Verificación')
})

test('case folds by default and stops folding when asked', () => {
  assert.equal(findMatches(document, 'POOL').total, 1)
  assert.equal(findMatches(document, 'POOL', { caseSensitive: true }).total, 0)
  assert.equal(findMatches(document, 'pool', { caseSensitive: true }).total, 1)
})

test('offsets computed on the folded text still address the raw text', () => {
  const { matches } = findMatches(document, 'cognito', { max: 10 })
  assert.ok(matches.length >= 2)
  for (const found of matches) {
    assert.equal(document.slice(found.offset, found.offset + found.length).toLowerCase(), 'cognito')
    assert.equal(`${found.prefix}${found.match}${found.suffix}`, found.snippet)
  }
})

test('counts every occurrence but materialises only the asked for snippets', () => {
  const repeated = 'cognito '.repeat(9)
  const { total, matches } = findMatches(repeated, 'cognito', { max: 3 })
  assert.equal(total, 9)
  assert.equal(matches.length, 3)
})

test('attributes a match to the section above it, and to nothing before the first one', () => {
  const { matches } = findMatches(document, 'se agotaba')
  assert.equal(matches[0]?.section, 'Hallazgos')

  const inTitle = findMatches(document, 'ejecución local')
  assert.equal(inTitle.matches[0]?.section, null)
})

test('the section filter drops documents whose matches are elsewhere', () => {
  assert.equal(findMatches(document, 'cognito', { section: 'Hallazgos' }).total, 0)
  assert.equal(findMatches(document, 'se agotaba', { section: 'Hallazgos' }).total, 1)
})

test('ellipsis appears only where the snippet was actually cut', () => {
  const { matches } = findMatches('cognito al principio', 'cognito', { context: 4 })
  const found = matches[0]
  assert.ok(found)
  assert.equal(found.prefix, '')
  assert.ok(found.suffix.endsWith('…'))
})

test('a candidate whose file is gone is counted and skipped, not fatal', async () => {
  const docsRoot = scratch()
  write(docsRoot, 'arsm/2026/09/20-735-cognito.md', document)

  const result = await scanDocuments(
    docsRoot,
    [candidate('arsm/2026/09/20-735-cognito.md', 735, 'ARSM'), candidate('arsm/2026/09/19-733-gone.md', 733, 'ARSM')],
    'cognito',
  )

  assert.equal(result.documents.length, 1)
  assert.equal(result.scanned.documents, 2)
  assert.equal(result.scanned.missing, 1)
  assert.equal(result.truncated, false)
  assert.equal(result.documents[0]?.file.status, 'changed')

  rmSync(docsRoot, { recursive: true, force: true })
})

test('the scan keeps the order it was given', async () => {
  const docsRoot = scratch()
  write(docsRoot, 'a.md', '## Hallazgos\n\ncognito aquí.\n')
  write(docsRoot, 'b.md', '## Hallazgos\n\nnada que ver.\n')
  write(docsRoot, 'c.md', '## Hallazgos\n\ncognito también.\n')

  const result = await scanDocuments(
    docsRoot,
    [candidate('a.md', 1, 'A'), candidate('b.md', 2, 'B'), candidate('c.md', 3, 'C')],
    'cognito',
    { concurrency: 3 },
  )

  assert.deepEqual(
    result.documents.map((found) => found.candidate.doc.relPath),
    ['a.md', 'c.md'],
  )

  rmSync(docsRoot, { recursive: true, force: true })
})

test('the byte budget stops the scan and says so', async () => {
  const docsRoot = scratch()
  for (let index = 0; index < 6; index += 1) write(docsRoot, `${index}.md`, `cognito ${'x'.repeat(200)}\n`)

  const result = await scanDocuments(
    docsRoot,
    Array.from({ length: 6 }, (_unused, index) => candidate(`${index}.md`, index, 'A')),
    'cognito',
    { concurrency: 1, maxScanBytes: 300 },
  )

  assert.equal(result.truncated, true)
  assert.ok(result.scanned.documents < 6)

  rmSync(docsRoot, { recursive: true, force: true })
})
