import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { openMemoryDatabase } from '../src/db/open.ts'
import { insertSpace } from '../src/db/spaces.ts'
import { insertPage } from '../src/db/pages.ts'
import { addRefToPage, refsOfPage, removeRefFromPage } from '../src/db/page-refs.ts'
import { classifyUrl } from '../src/domain/refs.ts'

const NOW = '2026-09-27T20:00:00.000Z'
const SITE = 'https://gruposti.atlassian.net'

function setup(): { db: DatabaseSync; pageId: number } {
  const db = openMemoryDatabase()
  const space = insertSpace(db, { name: 'Apartados', createdAt: NOW })
  const pageId = insertPage(db, {
    spaceId: space.id,
    parentId: null,
    slug: 'estimacion',
    title: 'Estimación',
    relPath: 'apartados/estimacion.md',
    depth: 0,
    source: 'test',
    now: NOW,
  })
  return { db, pageId }
}

test('urls are classified by where they point', () => {
  assert.equal(classifyUrl(`${SITE}/wiki/spaces/VB/pages/1`), 'confluence')
  assert.equal(classifyUrl(`${SITE}/browse/VBAA-1`), 'jira')
  assert.equal(classifyUrl('https://docs.google.com/spreadsheets/d/x'), 'drive')
  assert.equal(classifyUrl('https://example.com'), null)
  assert.equal(classifyUrl('no es url'), null)
})

test('a ref added twice keeps one row, the manual kind and the widest window', () => {
  const { db, pageId } = setup()
  addRefToPage(db, pageId, { url: `${SITE}/browse/VBAA-1`, title: 'Seguridad', kind: 'jira', source: 'manual', now: NOW })
  addRefToPage(db, pageId, { url: `${SITE}/browse/VBAA-1`, title: '', kind: 'link', source: 'hook', now: '2026-09-28T10:00:00.000Z' })

  const refs = refsOfPage(db, pageId)
  assert.equal(refs.length, 1)
  assert.equal(refs[0]?.title, 'Seguridad')
  assert.equal(refs[0]?.kind, 'jira')
  assert.equal(refs[0]?.source, 'manual')
  assert.equal(refs[0]?.firstSeenAt, NOW)
  assert.equal(refs[0]?.lastSeenAt, '2026-09-28T10:00:00.000Z')
})

test('a ref is removed by its url', () => {
  const { db, pageId } = setup()
  addRefToPage(db, pageId, { url: 'https://example.com/a', kind: 'link', source: 'manual', now: NOW })
  assert.equal(removeRefFromPage(db, pageId, 'https://example.com/a'), true)
  assert.equal(removeRefFromPage(db, pageId, 'https://example.com/a'), false)
  assert.equal(refsOfPage(db, pageId).length, 0)
})

test('only http urls are accepted', () => {
  const { db, pageId } = setup()
  assert.throws(() => addRefToPage(db, pageId, { url: 'file:///etc/passwd', kind: 'link', source: 'manual', now: NOW }), /CHECK/i)
})
