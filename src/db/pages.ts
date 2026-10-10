import type { DatabaseSync } from 'node:sqlite'
import { ConflictError, NotFoundError } from '../errors.ts'
import { MAX_PAGE_DEPTH } from '../docs/layout.ts'
import { queryAll, queryOne } from './query.ts'

export type PageStatus = 'active' | 'archived'

export interface DocPageRow {
  id: number
  spaceId: number | null
  parentId: number | null
  slug: string
  title: string
  relPath: string
  depth: number
  position: number
  status: PageStatus
  source: string
  sectionCount: number
  headingCount: number
  byteSize: number
  checksum: string
  repoSlug: string | null
  branch: string | null
  headSha: string | null
  createdAt: string
  recordedAt: string
}

interface PageRow {
  id: number
  space_id: number | null
  parent_id: number | null
  slug: string
  title: string
  rel_path: string
  depth: number
  position: number
  status: PageStatus
  source: string
  section_count: number
  heading_count: number
  byte_size: number
  checksum: string
  repo_slug: string | null
  branch: string | null
  head_sha: string | null
  created_at: string
  recorded_at: string
}

export interface NewDocPage {
  spaceId: number | null
  parentId: number | null
  slug: string
  title: string
  relPath: string
  depth: number
  position?: number
  source: string
  repoSlug?: string | null
  branch?: string | null
  headSha?: string | null
  now: string
}

const COLUMNS = `id, space_id, parent_id, slug, title, rel_path, depth, position, status, source,
                 section_count, heading_count, byte_size, checksum, repo_slug, branch, head_sha,
                 created_at, recorded_at`

function toRow(row: PageRow): DocPageRow {
  return {
    id: row.id,
    spaceId: row.space_id,
    parentId: row.parent_id,
    slug: row.slug,
    title: row.title,
    relPath: row.rel_path,
    depth: row.depth,
    position: row.position,
    status: row.status,
    source: row.source,
    sectionCount: row.section_count,
    headingCount: row.heading_count,
    byteSize: row.byte_size,
    checksum: row.checksum,
    repoSlug: row.repo_slug,
    branch: row.branch,
    headSha: row.head_sha,
    createdAt: row.created_at,
    recordedAt: row.recorded_at,
  }
}

export function findPage(db: DatabaseSync, id: number): DocPageRow | undefined {
  const row = queryOne<PageRow>(db.prepare(`SELECT ${COLUMNS} FROM pages WHERE id = ?`), id)
  return row ? toRow(row) : undefined
}

export function requirePage(db: DatabaseSync, id: number): DocPageRow {
  const page = findPage(db, id)
  if (!page) throw new NotFoundError(`No page #${id}.`, 'PAGE_NOT_FOUND')
  return page
}

export function findPageByRelPath(db: DatabaseSync, relPath: string): DocPageRow | undefined {
  const row = queryOne<PageRow>(db.prepare(`SELECT ${COLUMNS} FROM pages WHERE rel_path = ?`), relPath)
  return row ? toRow(row) : undefined
}

export function listPages(db: DatabaseSync, spaceId?: number | null): DocPageRow[] {
  const statement =
    spaceId === undefined
      ? db.prepare(`SELECT ${COLUMNS} FROM pages ORDER BY IFNULL(space_id, 0), depth, position, id`)
      : db.prepare(
          `SELECT ${COLUMNS} FROM pages
           WHERE IFNULL(space_id, 0) = IFNULL(?, 0)
           ORDER BY depth, position, id`,
        )
  const rows = spaceId === undefined ? queryAll<PageRow>(statement) : queryAll<PageRow>(statement, spaceId)
  return rows.map(toRow)
}

export function childrenOf(db: DatabaseSync, parentId: number | null): DocPageRow[] {
  const statement =
    parentId === null
      ? db.prepare(`SELECT ${COLUMNS} FROM pages WHERE parent_id IS NULL ORDER BY position, id`)
      : db.prepare(`SELECT ${COLUMNS} FROM pages WHERE parent_id = ? ORDER BY position, id`)
  const rows = parentId === null ? queryAll<PageRow>(statement) : queryAll<PageRow>(statement, parentId)
  return rows.map(toRow)
}

export function ancestorsOf(db: DatabaseSync, id: number): DocPageRow[] {
  const rows = queryAll<PageRow>(
    db.prepare(
      `WITH RECURSIVE up (id) AS (
         SELECT parent_id FROM pages WHERE id = ?
         UNION ALL
         SELECT p.parent_id FROM pages p JOIN up ON p.id = up.id WHERE p.parent_id IS NOT NULL
       )
       SELECT ${COLUMNS} FROM pages WHERE id IN (SELECT id FROM up WHERE id IS NOT NULL)
       ORDER BY depth`,
    ),
    id,
  )
  return rows.map(toRow)
}

export function descendantsOf(db: DatabaseSync, id: number): DocPageRow[] {
  const rows = queryAll<PageRow>(
    db.prepare(
      `WITH RECURSIVE down (id) AS (
         SELECT id FROM pages WHERE parent_id = ?
         UNION ALL
         SELECT p.id FROM pages p JOIN down ON p.parent_id = down.id
       )
       SELECT ${COLUMNS} FROM pages WHERE id IN (SELECT id FROM down) ORDER BY depth, position, id`,
    ),
    id,
  )
  return rows.map(toRow)
}

export function siblingSlugs(db: DatabaseSync, spaceId: number | null, parentId: number | null): Set<string> {
  const rows = queryAll<{ slug: string }>(
    db.prepare(
      `SELECT slug FROM pages
       WHERE IFNULL(space_id, 0) = IFNULL(?, 0) AND IFNULL(parent_id, 0) = IFNULL(?, 0)`,
    ),
    spaceId,
    parentId,
  )
  return new Set(rows.map((row) => row.slug))
}

export function uniqueSiblingSlug(
  db: DatabaseSync,
  spaceId: number | null,
  parentId: number | null,
  slug: string,
  exceptId?: number,
): string {
  if (exceptId !== undefined) return uniqueSiblingSlugExcluding(db, spaceId, parentId, slug, exceptId)
  const taken = siblingSlugs(db, spaceId, parentId)
  if (!taken.has(slug)) return slug

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${slug}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  throw new ConflictError(`Too many pages named "${slug}" side by side.`, 'SLUG_EXHAUSTED')
}

export function nextPosition(db: DatabaseSync, spaceId: number | null, parentId: number | null): number {
  const row = queryOne<{ next: number | null }>(
    db.prepare(
      `SELECT MAX(position) + 1 AS next FROM pages
       WHERE IFNULL(space_id, 0) = IFNULL(?, 0) AND IFNULL(parent_id, 0) = IFNULL(?, 0)`,
    ),
    spaceId,
    parentId,
  )
  return row?.next ?? 0
}

export function insertPage(db: DatabaseSync, page: NewDocPage): number {
  const position = page.position ?? nextPosition(db, page.spaceId, page.parentId)
  const result = db
    .prepare(
      `INSERT INTO pages
         (space_id, parent_id, slug, title, rel_path, depth, position, source,
          repo_slug, branch, head_sha, created_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      page.spaceId,
      page.parentId,
      page.slug,
      page.title,
      page.relPath,
      page.depth,
      position,
      page.source,
      page.repoSlug ?? null,
      page.branch ?? null,
      page.headSha ?? null,
      page.now,
      page.now,
    )
  return Number(result.lastInsertRowid)
}

export interface PageFileStats {
  sectionCount: number
  headingCount: number
  byteSize: number
  checksum: string
  recordedAt: string
}

export function recordPageFile(db: DatabaseSync, id: number, stats: PageFileStats): void {
  db.prepare(
    `UPDATE pages
     SET section_count = ?, heading_count = ?, byte_size = ?, checksum = ?, recorded_at = ?
     WHERE id = ?`,
  ).run(stats.sectionCount, stats.headingCount, stats.byteSize, stats.checksum, stats.recordedAt, id)
}

export function renamePage(db: DatabaseSync, id: number, title: string, slug: string, now: string): void {
  db.prepare(`UPDATE pages SET title = ?, slug = ?, recorded_at = ? WHERE id = ?`).run(title, slug, now, id)
}

export function repointPage(db: DatabaseSync, id: number, relPath: string): void {
  db.prepare(`UPDATE pages SET rel_path = ? WHERE id = ?`).run(relPath, id)
}

export function deletePage(db: DatabaseSync, id: number): void {
  db.prepare(`DELETE FROM pages WHERE id = ?`).run(id)
}

export function movePage(
  db: DatabaseSync,
  id: number,
  target: { parentId: number | null; spaceId?: number | null; position?: number },
): void {
  const page = requirePage(db, id)
  const parentId = target.parentId

  if (parentId === id) throw new ConflictError('A page cannot be its own parent.', 'PAGE_CYCLE')

  let spaceId = target.spaceId === undefined ? page.spaceId : target.spaceId
  let depth = 0

  if (parentId !== null) {
    const parent = findPage(db, parentId)
    if (!parent) throw new NotFoundError(`No page #${parentId}.`, 'PAGE_NOT_FOUND')
    if (descendantsOf(db, id).some((child) => child.id === parentId)) {
      throw new ConflictError('A page cannot be moved under one of its own descendants.', 'PAGE_CYCLE')
    }
    spaceId = parent.spaceId
    depth = parent.depth + 1
  }

  const subtree = descendantsOf(db, id)
  const deepest = subtree.reduce((most, child) => Math.max(most, child.depth - page.depth), 0)
  if (depth + deepest > MAX_PAGE_DEPTH) {
    throw new ConflictError(`A page tree cannot go deeper than ${MAX_PAGE_DEPTH + 1} levels.`, 'PAGE_TOO_DEEP')
  }

  const slug = uniqueSiblingSlugExcluding(db, spaceId, parentId, page.slug, id)
  const position = target.position ?? nextPosition(db, spaceId, parentId)

  db.prepare(
    `UPDATE pages SET parent_id = ?, space_id = ?, slug = ?, depth = ?, position = ? WHERE id = ?`,
  ).run(parentId, spaceId, slug, depth, position, id)

  const shift = depth - page.depth
  if (shift !== 0 || spaceId !== page.spaceId) {
    for (const child of subtree) {
      db.prepare(`UPDATE pages SET depth = ?, space_id = ? WHERE id = ?`).run(
        child.depth + shift,
        spaceId,
        child.id,
      )
    }
  }
}

function uniqueSiblingSlugExcluding(
  db: DatabaseSync,
  spaceId: number | null,
  parentId: number | null,
  slug: string,
  exceptId: number,
): string {
  const rows = queryAll<{ slug: string }>(
    db.prepare(
      `SELECT slug FROM pages
       WHERE IFNULL(space_id, 0) = IFNULL(?, 0) AND IFNULL(parent_id, 0) = IFNULL(?, 0) AND id <> ?`,
    ),
    spaceId,
    parentId,
    exceptId,
  )
  const taken = new Set(rows.map((row) => row.slug))
  if (!taken.has(slug)) return slug

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${slug}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  throw new ConflictError(`Too many pages named "${slug}" side by side.`, 'SLUG_EXHAUSTED')
}
