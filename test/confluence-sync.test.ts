import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openMemoryDatabase } from '../src/db/open.ts'
import { findSpaceById as findProjectById, insertSpace as insertProject, updateSpace } from '../src/db/spaces.ts'
import { insertPage, listPages, requirePage } from '../src/db/pages.ts'
import { findMapByPage, mapsOfSpace as mapsOfProject } from '../src/db/confluence-map.ts'
import { recordPageDoc } from '../src/docs/page-record.ts'
import { resolveDocPath } from '../src/docs/paths.ts'
import { demoteTitledHeadings, resolveConflict, syncProject, syncStatus } from '../src/confluence/sync.ts'
import { FakeConfluence } from './helpers/fake-confluence.ts'

const SITE = 'https://acme.atlassian.net'
const NOW = '2026-10-06T12:00:00.000Z'

async function setup() {
  const db = openMemoryDatabase()
  const docsRoot = mkdtempSync(join(tmpdir(), 'inkwell-sync-'))
  const ctx = { db, docsRoot, timezone: 'America/Mazatlan', now: new Date(NOW) }
  const created = insertProject(db, { name: 'Apartados', createdAt: NOW })
  updateSpace(db, created.id, {
    site: SITE,
    confluence: { ref: `${SITE}/wiki/spaces/K/pages/100/Apartados`, kind: 'page' },
    syncPull: true,
    syncPush: true,
  })

  const fake = new FakeConfluence(SITE)
  fake.add({ id: '100', title: 'Apartados', parentId: null, storage: 'root' })
  fake.add({ id: '101', title: 'Arquitectura', parentId: '100', storage: '## Estado\n\nuno' })
  fake.add({ id: '102', title: 'WAF', parentId: '101', storage: '# Reglas\n\nbloquea admin' })

  const runbookId = insertPage(db, {
    spaceId: created.id,
    parentId: null,
    slug: 'runbook',
    title: 'Runbook',
    relPath: 'apartados/runbook.md',
    depth: 0,
    source: 'cli',
    now: NOW,
  })
  await recordPageDoc(ctx, requirePage(db, runbookId), { body: '## Pasos\n\n- reiniciar' })

  const client = fake
  const project = () => findProjectById(db, created.id)!
  return { db, docsRoot, ctx, fake, client, project, runbookId }
}

function byTitle(db: ReturnType<typeof openMemoryDatabase>, title: string) {
  const page = listPages(db).find((candidate) => candidate.title === title)
  assert.ok(page, `page ${title}`)
  return page
}

test('a dry run reports what the first sync would do and writes nothing', async () => {
  const { db, docsRoot, ctx, fake, client, project, runbookId } = await setup()
  const report = await syncProject(ctx, client, project(), SITE, { dryRun: true })

  assert.deepEqual(report, {
    project: 'Apartados',
    pulled: [],
    pushed: [],
    created: [
      { confluenceId: '101', title: 'Arquitectura', reason: 'from Confluence' },
      { confluenceId: '102', title: 'WAF', reason: 'from Confluence' },
      { pageId: runbookId, title: 'Runbook', reason: 'from inkwell' },
    ],
    conflicts: [],
    skipped: [],
  })
  assert.equal(fake.writes().length, 0)
  assert.equal(listPages(db).length, 1)
  assert.equal(project().lastSyncAt, null)
  rmSync(docsRoot, { recursive: true, force: true })
})

test('the first sync mirrors both trees and maps every page', async () => {
  const { db, docsRoot, ctx, fake, client, project, runbookId } = await setup()
  const report = await syncProject(ctx, client, project(), SITE, { dryRun: false })

  const arquitectura = byTitle(db, 'Arquitectura')
  const waf = byTitle(db, 'WAF')
  assert.equal(arquitectura.depth, 0)
  assert.equal(waf.parentId, arquitectura.id)
  assert.equal(waf.depth, 1)
  assert.equal(waf.relPath, 'apartados/arquitectura/waf.md')

  const wafFile = readFileSync(resolveDocPath(docsRoot, waf.relPath), 'utf8')
  assert.match(wafFile, /## Reglas\n\nbloquea admin/)

  assert.equal(report.created.length, 3)
  const runbookRemote = findMapByPage(db, runbookId)
  assert.ok(runbookRemote)
  assert.equal(fake.pages.get(runbookRemote.confluenceId)?.parentId, '100')
  assert.match(fake.pages.get(runbookRemote.confluenceId)?.storage ?? '', /- reiniciar/)
  assert.equal(mapsOfProject(db, project().id).length, 3)
  assert.equal(project().lastSyncAt, NOW)

  const again = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.deepEqual([again.pulled, again.pushed, again.created, again.conflicts, again.skipped], [[], [], [], [], []])
  rmSync(docsRoot, { recursive: true, force: true })
})

test('one-sided changes travel, two-sided ones become conflicts that are never overwritten', async () => {
  const { db, docsRoot, ctx, fake, client, project } = await setup()
  await syncProject(ctx, client, project(), SITE, { dryRun: false })
  const arquitectura = byTitle(db, 'Arquitectura')
  const waf = byTitle(db, 'WAF')

  fake.edit('101', '## Estado\n\ndos')
  const pulled = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.deepEqual(pulled.pulled, [{ pageId: arquitectura.id, confluenceId: '101', title: 'Arquitectura' }])
  assert.match(readFileSync(resolveDocPath(docsRoot, arquitectura.relPath), 'utf8'), /## Estado\n\ndos/)

  await recordPageDoc(ctx, requirePage(db, waf.id), { body: '## Reglas\n\nbloquea admin y QA' })
  const pushed = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.deepEqual(pushed.pushed, [{ pageId: waf.id, confluenceId: '102', title: 'WAF' }])
  assert.equal(fake.pages.get('102')?.version, 2)
  assert.match(fake.pages.get('102')?.storage ?? '', /bloquea admin y QA/)

  fake.edit('102', '## Reglas\n\nremoto')
  await recordPageDoc(ctx, requirePage(db, waf.id), { body: '## Reglas\n\nlocal' })
  const writesBefore = fake.writes().length
  const clash = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.deepEqual(clash.conflicts, [{ pageId: waf.id, confluenceId: '102', title: 'WAF', reason: 'changed on both sides' }])
  assert.equal(findMapByPage(db, waf.id)?.state, 'conflict')
  assert.equal(fake.writes().length, writesBefore)
  assert.match(readFileSync(resolveDocPath(docsRoot, waf.relPath), 'utf8'), /## Reglas\n\nlocal/)

  const still = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.equal(still.conflicts[0]?.reason, 'unresolved conflict')

  const statuses = await syncStatus(ctx, client, project())
  assert.equal(statuses.find((status) => status.pageId === waf.id)?.direction, 'conflict')

  const resolved = await resolveConflict(ctx, client, waf.id, 'remote')
  assert.equal(resolved.reason, 'kept Confluence')
  assert.match(readFileSync(resolveDocPath(docsRoot, waf.relPath), 'utf8'), /## Reglas\n\nremoto/)
  assert.equal(findMapByPage(db, waf.id)?.state, 'synced')

  const settled = await syncStatus(ctx, client, project())
  assert.deepEqual(
    settled.map((status) => [status.title, status.confluenceTitle, status.state, status.direction]),
    [
      ['Runbook', 'Runbook', 'synced', 'none'],
      ['Arquitectura', 'Arquitectura', 'synced', 'none'],
      ['WAF', 'WAF', 'synced', 'none'],
    ],
  )
  rmSync(docsRoot, { recursive: true, force: true })
})

test('keeping the local side pushes it over the remote version', async () => {
  const { db, docsRoot, ctx, fake, client, project } = await setup()
  await syncProject(ctx, client, project(), SITE, { dryRun: false })
  const waf = byTitle(db, 'WAF')
  fake.edit('102', 'remoto')
  await recordPageDoc(ctx, requirePage(db, waf.id), { body: 'mio' })
  await syncProject(ctx, client, project(), SITE, { dryRun: false })

  await resolveConflict(ctx, client, waf.id, 'local')
  assert.equal(fake.pages.get('102')?.storage, 'mio')
  assert.equal(findMapByPage(db, waf.id)?.state, 'synced')
  assert.equal(findMapByPage(db, waf.id)?.confluenceVersion, fake.pages.get('102')?.version)
  rmSync(docsRoot, { recursive: true, force: true })
})

test('a direction that is off leaves the change where it is', async () => {
  const { db, docsRoot, ctx, fake, client, project } = await setup()
  await syncProject(ctx, client, project(), SITE, { dryRun: false })
  updateSpace(db, project().id, { syncPull: false })
  fake.edit('101', 'nuevo')
  fake.add({ id: '103', title: 'Nueva', parentId: '100', storage: 'x' })

  const report = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.deepEqual(report.skipped.map((skip) => [skip.title, skip.reason]), [['Arquitectura', 'changed in Confluence, but pull is off']])
  assert.equal(listPages(db).some((page) => page.title === 'Nueva'), false)
  rmSync(docsRoot, { recursive: true, force: true })
})

test('a space syncs under its home page, and a twin page is matched instead of duplicated', async () => {
  const { db, docsRoot, ctx, fake, client, project, runbookId } = await setup()
  updateSpace(db, project().id, { confluence: { ref: 'K', kind: 'space' } })
  fake.spaces.set('K', { id: 'S1', key: 'K', homepageId: '100' })
  fake.add({ id: '110', title: 'runbook', parentId: '100', storage: 'otra cosa' })

  const report = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.deepEqual(report.conflicts, [{ pageId: runbookId, confluenceId: '110', title: 'Runbook', reason: 'exists on both sides' }])
  assert.equal(report.created.some((created) => created.title === 'Runbook'), false)
  assert.equal(findMapByPage(db, runbookId)?.confluenceId, '110')
  rmSync(docsRoot, { recursive: true, force: true })
})

test('a remote document with a title heading is pushed down a level', () => {
  assert.equal(demoteTitledHeadings('# A\n\n## B\n\n```\n# not\n```'), '## A\n\n### B\n\n```\n# not\n```')
  assert.equal(demoteTitledHeadings('## A\n\ntext'), '## A\n\ntext')
})

test('an inkwell page titled like the Confluence root becomes the root, and its tree is matched instead of duplicated', async () => {
  const { db, docsRoot, ctx, fake, client, project, runbookId } = await setup()
  const page = (title: string, parentId: number | null, depth: number, slug: string, relPath: string) =>
    insertPage(db, { spaceId: project().id, parentId, slug, title, relPath, depth, source: 'cli', now: NOW })
  fake.pages.get('100')!.title = 'Apartados – Documentación'
  fake.add({ id: '103', title: 'Infra', parentId: '100', storage: '## Red\n\nVPC con NAT' })
  const rootId = page('Apartados - Documentación', null, 0, 'docs', 'apartados/docs.md')
  await recordPageDoc(ctx, requirePage(db, rootId), { body: 'root' })
  const arquitecturaId = page('Arquitectura', rootId, 1, 'arquitectura', 'apartados/docs/arquitectura.md')
  await recordPageDoc(ctx, requirePage(db, arquitecturaId), { body: '## Estado\n\nuno' })
  const infraId = page('Infra', rootId, 1, 'infra', 'apartados/docs/infra.md')
  await recordPageDoc(ctx, requirePage(db, infraId), { body: '## Red\n\n**VPC** con NAT' })
  const wafId = page('WAF', infraId, 2, 'waf', 'apartados/docs/infra/waf.md')
  await recordPageDoc(ctx, requirePage(db, wafId), { body: '## Reglas\n\nbloquea admin' })

  const report = await syncProject(ctx, client, project(), SITE, { dryRun: false })

  assert.deepEqual(report.created, [])
  assert.deepEqual(report.conflicts, [])
  assert.equal(listPages(db).length, 5)
  assert.equal(findMapByPage(db, rootId)?.confluenceId, '100')
  assert.equal(findMapByPage(db, arquitecturaId)?.confluenceId, '101')
  assert.equal(findMapByPage(db, infraId)?.confluenceId, '103')
  assert.equal(findMapByPage(db, wafId)?.confluenceId, '102')
  assert.equal(findMapByPage(db, runbookId), undefined)
  assert.equal(fake.writes().length, 0)

  const again = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.deepEqual([again.pulled, again.pushed, again.created, again.conflicts], [[], [], [], []])
  rmSync(docsRoot, { recursive: true, force: true })
})

test('with pull off, existing pages are still matched instead of pushed again', async () => {
  const { db, docsRoot, ctx, fake, client, project } = await setup()
  updateSpace(db, project().id, { syncPull: false })
  const arquitecturaId = insertPage(db, {
    spaceId: project().id, parentId: null, slug: 'arquitectura', title: 'Arquitectura',
    relPath: 'apartados/arquitectura.md', depth: 0, source: 'cli', now: NOW,
  })
  await recordPageDoc(ctx, requirePage(db, arquitecturaId), { body: '## Estado\n\nuno' })

  const report = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.equal(findMapByPage(db, arquitecturaId)?.confluenceId, '101')
  assert.equal(report.created.some((created) => created.title === 'Arquitectura'), false)
  assert.equal(listPages(db).some((page) => page.title === 'WAF'), false)
  rmSync(docsRoot, { recursive: true, force: true })
})

test('pages with diagrams are never overwritten on either side, and a conflict can keep both', async () => {
  const { db, docsRoot, ctx, fake, client, project } = await setup()
  const diagramId = insertPage(db, {
    spaceId: project().id, parentId: null, slug: 'arquitectura', title: 'Arquitectura',
    relPath: 'apartados/arquitectura.md', depth: 0, source: 'cli', now: NOW,
  })
  await recordPageDoc(ctx, requirePage(db, diagramId), { body: '## Estado\n\nuno\n\n```mermaid\ngraph TD\n  A-->B\n```' })
  fake.pages.get('101')!.storage = '## Estado\n\nuno\n\n![](a.png)'

  const first = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.deepEqual(first.conflicts, [])
  assert.equal(findMapByPage(db, diagramId)?.state, 'synced')

  await recordPageDoc(ctx, requirePage(db, diagramId), { body: '## Estado\n\ndos\n\n```mermaid\ngraph TD\n  A-->C\n```' })
  const pushed = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.deepEqual(pushed.pushed, [])
  assert.match(pushed.skipped.find((skipped) => skipped.pageId === diagramId)?.reason ?? '', /diagrams/)
  assert.match(fake.pages.get('101')?.storage ?? '', /uno/)

  fake.edit('101', '## Estado\n\ntres')
  const both = await syncProject(ctx, client, project(), SITE, { dryRun: false })
  assert.equal(both.conflicts[0]?.pageId, diagramId)
  await assert.rejects(resolveConflict(ctx, client, diagramId, 'local'), /diagrams/)
  const kept = await resolveConflict(ctx, client, diagramId, 'both')
  assert.equal(kept.reason, 'kept both as they are')
  assert.equal(findMapByPage(db, diagramId)?.state, 'synced')
  rmSync(docsRoot, { recursive: true, force: true })
})
