import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { openMemoryDatabase } from '../src/db/open.ts'
import { insertSpace } from '../src/db/spaces.ts'
import { insertPage, requirePage } from '../src/db/pages.ts'
import { linkEntryToPage, meetingsOfPage } from '../src/db/page-links.ts'
import { recordPageDoc } from '../src/docs/page-record.ts'
import { searchPages } from '../src/docs/page-search.ts'

const NOW = '2026-10-06T12:00:00.000Z'

function write(root: string, relPath: string, contents: string): void {
  const path = join(root, relPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, 'utf8')
}

async function seed() {
  const db = openMemoryDatabase()
  const root = mkdtempSync(join(tmpdir(), 'inkwell-page-search-'))
  const ctx = { db, docsRoot: root, timezone: 'America/Mazatlan', now: new Date(NOW) }
  const project = insertSpace(db, { name: 'Apartados', createdAt: NOW })
  const other = insertSpace(db, { name: 'Otro', createdAt: NOW })

  const page = (title: string, slug: string, parentId: number | null, projectId: number, depth: number) =>
    insertPage(db, { spaceId: projectId, parentId, slug, title, relPath: `${slug}.md`, depth, source: 'cli', now: NOW })

  const infra = page('Infraestructura', 'infra', null, project.id, 0)
  const waf = page('Reglas del WAF', 'waf', infra, project.id, 1)
  const quiet = page('Sin coincidencias', 'quiet', null, project.id, 0)
  const elsewhere = page('WAF ajeno', 'ajeno', null, other.id, 0)

  await recordPageDoc(ctx, requirePage(db, waf), { body: '## Estado\n\nEl WAF bloquea las IPs de admin.\n\nOtra regla del waf.' })
  await recordPageDoc(ctx, requirePage(db, infra), { body: '## Resumen\n\nRed y balanceadores.' })
  await recordPageDoc(ctx, requirePage(db, quiet), { body: 'Nada que ver.' })
  await recordPageDoc(ctx, requirePage(db, elsewhere), { body: 'waf de otro proyecto' })

  const meeting = (id: number, start: string) => ({
    title: 'ajustar waf',
    entryKind: 'remote-meeting',
    startedAt: start,
    stoppedAt: new Date(Date.parse(start) + 3_600_000).toISOString(),
    durationSeconds: 3600,
  })
  const survivor = { id: 41 }
  const segment = { id: 42 }
  linkEntryToPage(db, waf, survivor.id, '', NOW, meeting(survivor.id, '2026-10-01T15:00:00.000Z'))
  linkEntryToPage(db, waf, segment.id, '', NOW, meeting(segment.id, '2026-10-02T15:00:00.000Z'))
  linkEntryToPage(db, quiet, survivor.id, '', NOW, meeting(survivor.id, '2026-10-01T15:00:00.000Z'))
  write(root, 'unrelated.md', 'waf suelto que no es página')

  return { db, root, project, infra, waf, quiet, survivor, segment }
}

test('page search ranks the pages that match and names where each match is', async () => {
  const { db, root, project, infra, waf, survivor, segment } = await seed()
  const result = await searchPages(db, root, 'waf', { projectId: project.id })

  assert.deepEqual(
    result.hits.map((hit) => [hit.pageId, hit.matchCount, hit.sources]),
    [
      [waf, 3, { page: 3, entries: 0 }],
    ],
  )
  const top = result.hits[0]!
  assert.equal(top.title, 'Reglas del WAF')
  assert.equal(top.projectName, 'Apartados')
  assert.equal(top.projectSlug, 'apartados')
  assert.deepEqual(top.ancestors, [{ pageId: infra, title: 'Infraestructura' }])
  assert.equal(top.matches[0]?.source, 'page')
  assert.equal(top.matches[0]?.section, null)
  assert.equal(top.matches[1]?.section, 'Estado')
  assert.equal(top.matches[1]?.match, 'WAF')
  assert.equal('entryId' in top.matches[1]!, false)
  assert.equal(top.matches.every((match) => match.source === 'page'), true)

  const everywhere = await searchPages(db, root, 'waf')
  assert.equal(everywhere.hits.length, 2)

  assert.deepEqual(
    meetingsOfPage(db, waf).map((meeting) => meeting.entryId),
    [survivor.id, segment.id],
  )
  db.close()
  rmSync(root, { recursive: true, force: true })
})
