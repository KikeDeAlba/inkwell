import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inspectDocFile, type DocFileRef } from '../src/docs/inspect.ts'
import { emptyDocument } from '../src/docs/markdown.ts'
import { writeDocument } from '../src/docs/store.ts'

const REL_PATH = 'arsm/2026/09/20-735-cognito-dev.md'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'inkwell-inspect-'))
}

function row(overrides: Partial<DocFileRef> = {}): DocFileRef {
  return { relPath: REL_PATH, checksum: '', byteSize: 0, ...overrides }
}

async function seed(docsRoot: string): Promise<DocFileRef> {
  const doc = emptyDocument(new Map([['bita', '1']]), 'Cognito dev')
  const written = await writeDocument(join(docsRoot, REL_PATH), doc)
  return row({ checksum: written.checksum, byteSize: written.byteSize })
}

test('the stored checksum is the checksum of the written bytes', async () => {
  const docsRoot = scratch()
  const stored = await seed(docsRoot)

  const { state, raw } = await inspectDocFile(docsRoot, stored)
  assert.equal(state.status, 'ok')
  assert.equal(state.checksum, stored.checksum)
  assert.equal(state.byteSize, stored.byteSize)
  assert.ok(state.mtime)
  assert.ok(raw?.includes('# Cognito dev'))

  rmSync(docsRoot, { recursive: true, force: true })
})

test('a file edited outside inkwell reads as changed, not as an error', async () => {
  const docsRoot = scratch()
  const stored = await seed(docsRoot)
  writeFileSync(join(docsRoot, REL_PATH), '---\nbita: 1\n---\n\n# Otra cosa\n', 'utf8')

  const { state } = await inspectDocFile(docsRoot, stored)
  assert.equal(state.status, 'changed')
  assert.equal(state.recordedChecksum, stored.checksum)
  assert.ok(state.checksum)
  assert.notEqual(state.checksum, state.recordedChecksum)

  rmSync(docsRoot, { recursive: true, force: true })
})

test('a file that is gone reads as missing without throwing', async () => {
  const docsRoot = scratch()
  const stored = await seed(docsRoot)
  unlinkSync(join(docsRoot, REL_PATH))

  const { state, raw } = await inspectDocFile(docsRoot, stored)
  assert.equal(state.status, 'missing')
  assert.equal(state.checksum, null)
  assert.equal(state.byteSize, null)
  assert.equal(raw, null)

  rmSync(docsRoot, { recursive: true, force: true })
})

test('skipping verification opens no file at all', async () => {
  const docsRoot = scratch()

  const { state, raw } = await inspectDocFile(docsRoot, row({ checksum: 'sha256:abc', byteSize: 42 }), {
    verify: false,
  })
  assert.equal(state.status, 'unverified')
  assert.equal(state.checksum, null)
  assert.equal(state.recordedChecksum, 'sha256:abc')
  assert.equal(state.recordedByteSize, 42)
  assert.equal(raw, null)

  rmSync(docsRoot, { recursive: true, force: true })
})

test('a path that escapes the docs root is refused', async () => {
  const docsRoot = scratch()

  await assert.rejects(() => inspectDocFile(docsRoot, row({ relPath: '../escape.md' })), /escapes the docs root/)

  rmSync(docsRoot, { recursive: true, force: true })
})
