import { strict as assert } from 'node:assert'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { emptyDocument, parseDocument, upsertSection } from '../src/docs/markdown.ts'
import { readDocument, removeDocument, renameDocument, withDocLock, writeDocument } from '../src/docs/store.ts'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'inkwell-docs-'))
}

function frontMatter(): Map<string, string> {
  return new Map([
    ['bita', '1'],
    ['entryId', '1'],
  ])
}

test('writes a document into a directory that does not exist yet', async () => {
  const dir = scratch()
  const path = join(dir, 'project', '2026', '09', '20-1-thing.md')

  const result = await writeDocument(path, emptyDocument(frontMatter(), 'Thing'))
  assert.equal(result.created, true)
  assert.equal(result.changed, true)
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)

  const back = await readDocument(path)
  assert.equal(back?.title, 'Thing')
  rmSync(dir, { recursive: true, force: true })
})

test('a missing document reads as nothing instead of throwing', async () => {
  const dir = scratch()
  assert.equal(await readDocument(join(dir, 'nope.md')), null)
  rmSync(dir, { recursive: true, force: true })
})

test('writing the same contents twice reports no change', async () => {
  const dir = scratch()
  const path = join(dir, 'a.md')
  const doc = emptyDocument(frontMatter(), 'Thing')

  await writeDocument(path, doc)
  const again = await writeDocument(path, doc)
  assert.equal(again.changed, false)
  assert.equal(again.created, false)
  rmSync(dir, { recursive: true, force: true })
})

test('leaves no staging file behind', async () => {
  const dir = scratch()
  await writeDocument(join(dir, 'a.md'), emptyDocument(frontMatter(), 'Thing'))
  assert.deepEqual(readdirSync(dir), ['a.md'])
  rmSync(dir, { recursive: true, force: true })
})

test('serialises concurrent writers so every section survives', async () => {
  const dir = scratch()
  const path = join(dir, 'a.md')
  await writeDocument(path, emptyDocument(frontMatter(), 'Thing'))

  await Promise.all(
    Array.from({ length: 8 }, (_unused, index) =>
      withDocLock(path, async () => {
        const doc = await readDocument(path)
        assert.notEqual(doc, null)
        if (!doc) return
        await writeDocument(path, upsertSection(doc, `Paso ${index}`, `Cuerpo ${index}`).doc)
      }),
    ),
  )

  const final = await readDocument(path)
  const headings = final?.sections.map((section) => section.heading) ?? []
  for (let index = 0; index < 8; index += 1) {
    assert.equal(headings.includes(`Paso ${index}`), true, `missing Paso ${index}`)
  }
  assert.equal(final?.frontMatterValid, true)
  rmSync(dir, { recursive: true, force: true })
})

test('a fresh lock held by someone else makes the write give up instead of guessing', async () => {
  const dir = scratch()
  const path = join(dir, 'a.md')
  writeFileSync(`${path}.lock`, '{"pid":1}')

  await assert.rejects(
    withDocLock(path, async () => undefined),
    /Another process is writing/,
  )
  rmSync(dir, { recursive: true, force: true })
})

test('a lock nobody released in half a minute is taken over', async () => {
  const dir = scratch()
  const path = join(dir, 'a.md')
  const lockPath = `${path}.lock`
  writeFileSync(lockPath, '{"pid":1}')
  const longAgo = new Date(Date.now() - 120_000)
  utimesSync(lockPath, longAgo, longAgo)

  let ran = false
  await withDocLock(path, async () => {
    ran = true
  })
  assert.equal(ran, true)
  rmSync(dir, { recursive: true, force: true })
})

test('releases the lock even when the work throws', async () => {
  const dir = scratch()
  const path = join(dir, 'a.md')

  await assert.rejects(
    withDocLock(path, async () => {
      throw new Error('boom')
    }),
    /boom/,
  )

  let ran = false
  await withDocLock(path, async () => {
    ran = true
  })
  assert.equal(ran, true)
  rmSync(dir, { recursive: true, force: true })
})

test('renames a document and reports when there is nothing to rename', async () => {
  const dir = scratch()
  const from = join(dir, 'a.md')
  const to = join(dir, 'sub', 'b.md')
  await writeDocument(from, emptyDocument(frontMatter(), 'Thing'))

  assert.equal(await renameDocument(from, to), true)
  assert.notEqual(await readDocument(to), null)
  assert.equal(await renameDocument(from, to), false)
  rmSync(dir, { recursive: true, force: true })
})

test('removes a document and says whether there was one', async () => {
  const dir = scratch()
  const path = join(dir, 'a.md')
  await writeDocument(path, emptyDocument(frontMatter(), 'Thing'))

  assert.equal(await removeDocument(path), true)
  assert.equal(await removeDocument(path), false)
  rmSync(dir, { recursive: true, force: true })
})

test('never leaves a half written document where a reader can see it', async () => {
  const dir = scratch()
  const path = join(dir, 'a.md')
  const big = 'x'.repeat(200_000)
  await writeDocument(path, upsertSection(parseDocument('# T\n'), 'Contexto', big).doc)

  const raw = await readDocument(path)
  assert.equal(raw?.sections[0]?.body.length, big.length)
  rmSync(dir, { recursive: true, force: true })
})
