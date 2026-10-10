import type { DatabaseSync } from 'node:sqlite'
import { ancestorsOf, listPages, type DocPageRow } from '../db/pages.ts'
import { listSpaces } from '../db/spaces.ts'
import { projectSlug } from './slug.ts'
import { scanFiles, type Match, type ScanOptions } from './search.ts'

export const DEFAULT_PAGE_MATCHES = 8

export interface PageMatch {
  source: 'page' | 'entry'
  entryId?: number
  section: string | null
  line: number
  prefix: string
  match: string
  suffix: string
}

export interface PageSearchHit {
  pageId: number
  title: string
  projectId: number | null
  projectName: string | null
  projectSlug: string
  relPath: string
  ancestors: { pageId: number; title: string }[]
  matchCount: number
  sources: { page: number; entries: number }
  matches: PageMatch[]
}

export interface PageSearchResult {
  hits: PageSearchHit[]
  scanned: { documents: number; bytes: number; missing: number; elapsedMs: number }
  truncated: boolean
}

export interface PageSearchOptions extends ScanOptions {
  projectId?: number | null
  maxPerPage?: number
}

interface Tally {
  page: DocPageRow
  pageCount: number
  entryCount: number
  pageMatches: PageMatch[]
  entryMatches: PageMatch[]
  recency: string
}

function toPageMatch(match: Match, source: 'page' | 'entry', entryId?: number): PageMatch {
  return {
    source,
    ...(entryId !== undefined ? { entryId } : {}),
    section: match.section,
    line: match.line,
    prefix: match.prefix,
    match: match.match,
    suffix: match.suffix,
  }
}

export async function searchPages(
  db: DatabaseSync,
  docsRoot: string,
  query: string,
  options: PageSearchOptions = {},
): Promise<PageSearchResult> {
  const pages = listPages(db, options.projectId)

  const scanOptions: ScanOptions = { ...options, skipFrontMatter: true, max: options.maxPerPage ?? options.max ?? DEFAULT_PAGE_MATCHES }
  const pageScan = await scanFiles(docsRoot, pages, (page) => page, query, scanOptions)

  const tallies = new Map<number, Tally>()
  const tallyOf = (page: DocPageRow): Tally => {
    const existing = tallies.get(page.id)
    if (existing) return existing
    const created: Tally = { page, pageCount: 0, entryCount: 0, pageMatches: [], entryMatches: [], recency: page.recordedAt }
    tallies.set(page.id, created)
    return created
  }

  for (const found of pageScan.documents) {
    const tally = tallyOf(found.candidate)
    tally.pageCount += found.matchCount
    tally.pageMatches.push(...found.matches.map((match) => toPageMatch(match, 'page')))
  }

  const projectNames = new Map(listSpaces(db, true).map((space) => [space.id, space.name]))
  const limit = scanOptions.max ?? DEFAULT_PAGE_MATCHES

  const ranked = [...tallies.values()].sort(
    (left, right) =>
      right.pageCount + right.entryCount - (left.pageCount + left.entryCount) ||
      right.recency.localeCompare(left.recency) ||
      left.page.id - right.page.id,
  )

  const hits = ranked.map((tally): PageSearchHit => {
    const projectName = tally.page.spaceId === null ? null : (projectNames.get(tally.page.spaceId) ?? null)
    return {
      pageId: tally.page.id,
      title: tally.page.title,
      projectId: tally.page.spaceId,
      projectName,
      projectSlug: projectSlug(projectName),
      relPath: tally.page.relPath,
      ancestors: ancestorsOf(db, tally.page.id).map((row) => ({ pageId: row.id, title: row.title })),
      matchCount: tally.pageCount + tally.entryCount,
      sources: { page: tally.pageCount, entries: tally.entryCount },
      matches: [...tally.pageMatches, ...tally.entryMatches].slice(0, limit),
    }
  })

  return {
    hits,
    scanned: pageScan.scanned,
    truncated: pageScan.truncated,
  }
}
