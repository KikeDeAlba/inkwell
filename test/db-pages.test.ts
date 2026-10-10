import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { openMemoryDatabase } from '../src/db/open.ts'
import {
  ancestorsOf,
  childrenOf,
  descendantsOf,
  findPage,
  insertPage,
  movePage,
  uniqueSiblingSlug,
} from '../src/db/pages.ts'
import {
  entryLinksOfPage,
  issuesOfPage,
  linkEntryToPage,
  linkIssueToPage,
  mergeEntryLinks,
  pagesOfEntry,
  removeEntryLinks,
  talliesByPage,
  worklogIssuesOfPage,
} from '../src/db/page-links.ts'

const NOW = '2026-09-21T10:00:00.000Z'

function seedProject(db: DatabaseSync, id: number, name: string): void {
  db.prepare('INSERT INTO spaces (id, name, active, created_at) VALUES (?, ?, 1, ?)').run(id, name, NOW)
}

function snapshot(id: number, seconds = 3600, issues: string[] = []) {
  const started = '2026-09-21T08:00:00.000Z'
  const stopped = new Date(Date.parse(started) + seconds * 1000).toISOString()
  return { title: `bloque ${id}`, entryKind: null, startedAt: started, stoppedAt: stopped, durationSeconds: seconds, worklogIssues: issues }
}

function page(db: DatabaseSync, title: string, slug: string, parentId: number | null, depth = 0): number {
  return insertPage(db, {
    spaceId: 1,
    parentId,
    slug,
    title,
    relPath: `pharma-sti/${parentId === null ? '' : `${parentId}/`}${slug}.md`,
    depth,
    source: 'test',
    now: NOW,
  })
}

test('a page tree keeps its ancestors and descendants straight', () => {
  const db = openMemoryDatabase()
  seedProject(db, 1, 'Pharma STI')

  const root = page(db, 'Bootstrap', 'bootstrap', null, 0)
  const child = page(db, 'Credenciales', 'credenciales', root, 1)
  const grandchild = page(db, 'Rotación', 'rotacion', child, 2)

  assert.deepEqual(
    ancestorsOf(db, grandchild).map((row) => row.slug),
    ['bootstrap', 'credenciales'],
  )
  assert.deepEqual(
    descendantsOf(db, root).map((row) => row.slug),
    ['credenciales', 'rotacion'],
  )
  assert.deepEqual(
    childrenOf(db, root).map((row) => row.slug),
    ['credenciales'],
  )
  db.close()
})

test('a page cannot be moved under one of its own descendants', () => {
  const db = openMemoryDatabase()
  seedProject(db, 1, 'Pharma STI')

  const root = page(db, 'Bootstrap', 'bootstrap', null, 0)
  const child = page(db, 'Credenciales', 'credenciales', root, 1)

  assert.throws(() => movePage(db, root, { parentId: child }), /descendants/i)
  assert.throws(() => movePage(db, root, { parentId: root }), /own parent/i)
  db.close()
})

test('moving a page carries the depth of everything under it', () => {
  const db = openMemoryDatabase()
  seedProject(db, 1, 'Pharma STI')

  const first = page(db, 'Bootstrap', 'bootstrap', null, 0)
  const second = page(db, 'Despliegue', 'despliegue', null, 0)
  const child = page(db, 'Credenciales', 'credenciales', first, 1)
  const grandchild = page(db, 'Rotación', 'rotacion', child, 2)

  movePage(db, child, { parentId: second })

  assert.equal(findPage(db, child)?.depth, 1)
  assert.equal(findPage(db, grandchild)?.depth, 2)
  assert.equal(findPage(db, child)?.parentId, second)
  db.close()
})

test('a tree cannot be pushed past the depth limit', () => {
  const db = openMemoryDatabase()
  seedProject(db, 1, 'Pharma STI')

  let parent: number | null = null
  const chain: number[] = []
  for (let depth = 0; depth <= 4; depth += 1) {
    parent = page(db, `Nivel ${depth}`, `nivel-${depth}`, parent, depth)
    chain.push(parent)
  }

  const deepest = chain.at(-1) as number
  const other = page(db, 'Otra', 'otra', chain[0] as number, 1)

  assert.throws(() => movePage(db, chain[1] as number, { parentId: other }), /deeper/i)
  assert.equal(findPage(db, deepest)?.depth, 4)
  db.close()
})

test('two siblings cannot share a slug, but cousins can', () => {
  const db = openMemoryDatabase()
  seedProject(db, 1, 'Pharma STI')

  const first = page(db, 'Bootstrap', 'bootstrap', null, 0)
  const second = page(db, 'Despliegue', 'despliegue', null, 0)

  page(db, 'Notas', 'notas', first, 1)
  assert.doesNotThrow(() => page(db, 'Notas', 'notas', second, 1))

  assert.equal(uniqueSiblingSlug(db, 1, first, 'notas'), 'notas-2')
  assert.throws(() => page(db, 'Notas otra vez', 'notas', first, 1), /UNIQUE/i)
  db.close()
})

test('two root pages of the same project cannot share a slug either', () => {
  const db = openMemoryDatabase()
  seedProject(db, 1, 'Pharma STI')

  page(db, 'Bootstrap', 'bootstrap', null, 0)
  assert.throws(() => page(db, 'Bootstrap otra vez', 'bootstrap', null, 0), /UNIQUE/i)
  db.close()
})

test('an entry can belong to several pages, each with its own summary', () => {
  const db = openMemoryDatabase()
  seedProject(db, 1, 'Pharma STI')
  const first = page(db, 'Bootstrap', 'bootstrap', null, 0)
  const second = page(db, 'Despliegue', 'despliegue', null, 0)

  linkEntryToPage(db, first, 10, 'Se movieron las credenciales.', NOW, snapshot(10))
  assert.equal(pagesOfEntry(db, 10)[0]?.pageId, first)
  assert.equal(entryLinksOfPage(db, first)[0]?.summary, 'Se movieron las credenciales.')
  assert.equal(entryLinksOfPage(db, first)[0]?.ref, 'bita:entry:10')

  linkEntryToPage(db, second, 10, 'Se desplegó.', NOW, snapshot(10))
  assert.deepEqual(
    pagesOfEntry(db, 10).map((row) => [row.pageId, row.summary]),
    [
      [first, 'Se movieron las credenciales.'],
      [second, 'Se desplegó.'],
    ],
  )
  assert.equal(entryLinksOfPage(db, first).length, 1)
  db.close()
})

test('linking again without a summary keeps the one it had', () => {
  const db = openMemoryDatabase()
  seedProject(db, 1, 'Pharma STI')
  const id = page(db, 'Bootstrap', 'bootstrap', null, 0)

  linkEntryToPage(db, id, 10, 'Lo que pasó.', NOW, snapshot(10))
  linkEntryToPage(db, id, 10, '', NOW)

  assert.equal(entryLinksOfPage(db, id)[0]?.summary, 'Lo que pasó.')
  assert.equal(entryLinksOfPage(db, id)[0]?.title, 'bloque 10')
  db.close()
})

test('the tally of a page adds up the measured time of its entries', () => {
  const db = openMemoryDatabase()
  seedProject(db, 1, 'Pharma STI')
  const id = page(db, 'Bootstrap', 'bootstrap', null, 0)
  linkEntryToPage(db, id, 10, '', NOW, snapshot(10, 3600))
  linkEntryToPage(db, id, 11, '', NOW, snapshot(11, 1800))
  linkIssueToPage(db, { pageId: id, issueKey: 'PSTI-1', now: NOW })

  assert.deepEqual(talliesByPage(db).get(id), { pageId: id, entryCount: 2, durationSeconds: 5400, issueCount: 1 })
  db.close()
})

test('deleting an entry in bita takes its links and leaves the page standing', () => {
  const db = openMemoryDatabase()
  seedProject(db, 1, 'Pharma STI')
  const id = page(db, 'Bootstrap', 'bootstrap', null, 0)
  linkEntryToPage(db, id, 10, 'Algo.', NOW, snapshot(10))

  assert.deepEqual(removeEntryLinks(db, 10), [id])
  assert.equal(entryLinksOfPage(db, id).length, 0)
  assert.ok(findPage(db, id))
  db.close()
})

test('merging entries moves their links to the survivor and joins the summaries', () => {
  const db = openMemoryDatabase()
  seedProject(db, 1, 'Pharma STI')
  const id = page(db, 'Bootstrap', 'bootstrap', null, 0)
  linkEntryToPage(db, id, 10, 'Primero.', NOW, snapshot(10, 600, ['PSTI-1']))
  linkEntryToPage(db, id, 11, 'Después.', NOW, snapshot(11, 600, ['PSTI-2']))

  assert.deepEqual(mergeEntryLinks(db, [11], 10, NOW), [id])
  const links = entryLinksOfPage(db, id)
  assert.equal(links.length, 1)
  assert.equal(links[0]?.ref, 'bita:entry:10')
  assert.equal(links[0]?.summary, 'Primero. / Después.')
  assert.deepEqual(links[0]?.worklogIssues, ['PSTI-1', 'PSTI-2'])
  db.close()
})

test('a page keeps the issue key, its cached fields and its url', () => {
  const db = openMemoryDatabase()
  seedProject(db, 1, 'Pharma STI')
  const id = page(db, 'Bootstrap', 'bootstrap', null, 0)

  linkIssueToPage(db, {
    pageId: id,
    issueKey: 'PSTI-142',
    role: 'task',
    summary: 'Credenciales a Secrets Manager',
    status: 'Cerrada',
    statusCategory: 'done',
    url: 'https://x.atlassian.net/browse/PSTI-142',
    now: NOW,
  })

  const [issue] = issuesOfPage(db, id)
  assert.equal(issue?.summary, 'Credenciales a Secrets Manager')
  assert.equal(issue?.statusCategory, 'done')
  assert.equal(issue?.url, 'https://x.atlassian.net/browse/PSTI-142')

  linkIssueToPage(db, { pageId: id, issueKey: 'PSTI-142', now: NOW })
  assert.equal(issuesOfPage(db, id)[0]?.summary, 'Credenciales a Secrets Manager')
  db.close()
})

test('an issue key that is not one is refused', () => {
  const db = openMemoryDatabase()
  seedProject(db, 1, 'Pharma STI')
  const id = page(db, 'Bootstrap', 'bootstrap', null, 0)

  assert.throws(() => linkIssueToPage(db, { pageId: id, issueKey: 'no es una clave', now: NOW }), /not a Jira issue key/i)
  db.close()
})

test('the worklog issues of a page come from the entries, not from the page', () => {
  const db = openMemoryDatabase()
  seedProject(db, 1, 'Pharma STI')
  const id = page(db, 'Bootstrap', 'bootstrap', null, 0)

  linkEntryToPage(db, id, 10, '', NOW, snapshot(10, 3600, ['PSTI-142']))
  linkEntryToPage(db, id, 11, '', NOW, snapshot(11))

  assert.deepEqual(worklogIssuesOfPage(db, id), ['PSTI-142'])
  assert.deepEqual(issuesOfPage(db, id), [])
  db.close()
})

test('a space with pages cannot be deleted out from under them', () => {
  const db = openMemoryDatabase()
  seedProject(db, 1, 'Pharma STI')
  page(db, 'Bootstrap', 'bootstrap', null, 0)

  assert.throws(() => db.prepare('DELETE FROM spaces WHERE id = ?').run(1), /FOREIGN KEY/i)
  db.close()
})
