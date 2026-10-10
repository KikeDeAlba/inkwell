import { listPages } from '../../db/pages.ts'
import { talliesByPage } from '../../db/page-links.ts'
import { listSpaces } from '../../db/spaces.ts'
import type { SpaceRow } from '../../db/rows.ts'
import { localDay } from '../../domain/timezone.ts'
import { searchPages } from '../../docs/page-search.ts'
import type { ScanOptions } from '../../docs/search.ts'
import { projectSlug } from '../../docs/slug.ts'
import { confluenceRefView, type ConfluenceRefView } from '../../confluence/refs.ts'
import { UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readInteger, readString, type ParsedArgs } from '../args.ts'
import { createLocalContext, type LocalContext } from '../context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { defaultSiteUrl, selectedSpace } from '../spaces.ts'
import { pageTree, pageView, runPage, type PageView } from './page.ts'

const OPTIONS = {
  project: { type: 'string' as const },
  months: { type: 'boolean' as const, default: false },
  pages: { type: 'boolean' as const, default: false },
  all: { type: 'boolean' as const, default: false },
  limit: { type: 'string' as const },
  offset: { type: 'string' as const },
  section: { type: 'string' as const },
  context: { type: 'string' as const },
  'max-matches': { type: 'string' as const },
  'case-sensitive': { type: 'boolean' as const, default: false },
  'max-scan-docs': { type: 'string' as const },
  'max-scan-bytes': { type: 'string' as const },
}

const DEFAULT_LIST_LIMIT = 50
const DEFAULT_SEARCH_LIMIT = 30

export async function runDocs(command: string, argv: string[]): Promise<number> {
  if (command === 'show') return await runPage(['show', ...argv])
  const args = parseCommandArgs(argv, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const ctx = createLocalContext(args)
  try {
    if (command === 'tree') return runTree(ctx, args, json)
    if (command === 'ls') return runList(ctx, args, json)
    return await runSearch(ctx, args, json)
  } finally {
    ctx.db.close()
  }
}

function boundedInteger(args: ParsedArgs, name: string, fallback: number): number {
  const value = readInteger(args, name)
  if (value === undefined) return fallback
  if (value < 0) throw new UsageError(`Invalid value for --${name}: "${value}". Expected zero or more.`)
  return value
}

export interface SpaceAtlassianView {
  site: string | null
  via: 'cli'
  confluence: ConfluenceRefView | null
  sync: { pull: boolean; push: boolean; lastSyncAt: string | null }
}

export function atlassianOf(space: SpaceRow, defaultSite: string | null): SpaceAtlassianView {
  const effectiveSite = space.atlassianSite ?? defaultSite
  return {
    site: space.atlassianSite,
    via: 'cli',
    confluence: space.confluenceRef !== null && space.confluenceKind !== null ? confluenceRefView(space.confluenceKind, space.confluenceRef, effectiveSite) : null,
    sync: { pull: space.syncPull, push: space.syncPush, lastSyncAt: space.lastSyncAt },
  }
}

function countPages(list: readonly PageView[]): number {
  return list.reduce((total, page) => total + 1 + countPages(page.children ?? []), 0)
}

function runTree(ctx: LocalContext, args: ParsedArgs, json: boolean): number {
  const wantsMonths = readBoolean(args, 'months')
  const includesEmpty = readBoolean(args, 'all')
  const spaces = listSpaces(ctx.db)
  const pages = listPages(ctx.db)
  const tallies = talliesByPage(ctx.db, ctx.now)
  const roots = pageTree(ctx)
  const site = defaultSiteUrl(ctx.db) ?? null

  const byProject = new Map<number | null, PageView[]>()
  for (const page of roots) byProject.set(page.projectId, [...(byProject.get(page.projectId) ?? []), page])

  const ids: (number | null)[] = []
  for (const space of spaces) if (includesEmpty || byProject.has(space.id)) ids.push(space.id)
  if (byProject.has(null)) ids.push(null)

  const projects = ids.map((id) => {
    const space = id === null ? undefined : spaces.find((candidate) => candidate.id === id)
    const own = pages.filter((page) => page.spaceId === id)
    const entryCount = own.reduce((sum, page) => sum + (tallies.get(page.id)?.entryCount ?? 0), 0)
    const created = own.map((page) => page.createdAt).sort()
    const recorded = own.map((page) => page.recordedAt).sort()
    const months = new Map<string, number>()
    for (const page of own) {
      const month = localDay(page.recordedAt, ctx.timezone).slice(0, 7)
      months.set(month, (months.get(month) ?? 0) + 1)
    }
    return {
      projectId: id,
      projectName: space?.name ?? null,
      projectSlug: projectSlug(space?.name ?? null),
      projectKey: space?.key ?? null,
      active: space?.active ?? true,
      entryCount,
      docCount: own.length,
      appendixCount: 0,
      firstDay: created[0] === undefined ? null : localDay(created[0], ctx.timezone),
      lastDay: recorded.at(-1) === undefined ? null : localDay(recorded.at(-1) as string, ctx.timezone),
      lastDocAt: recorded.at(-1) ?? null,
      ...(wantsMonths
        ? {
            months: [...months.entries()]
              .map(([month, count]) => ({ month, entryCount: count, docCount: count }))
              .sort((left, right) => right.month.localeCompare(left.month)),
          }
        : {}),
    }
  })

  const spaceViews = projects.map((project) => {
    const space = project.projectId === null ? undefined : spaces.find((candidate) => candidate.id === project.projectId)
    const list = byProject.get(project.projectId) ?? []
    return {
      projectId: project.projectId,
      projectName: project.projectName,
      projectSlug: project.projectSlug,
      projectKey: project.projectKey,
      active: project.active,
      entryCount: project.entryCount,
      pageCount: countPages(list),
      atlassian: space ? atlassianOf(space, site) : null,
      pages: list,
    }
  })

  const meta = {
    root: ctx.docsRoot,
    timezone: ctx.timezone,
    includesEmpty,
    layout: 'hierarchical',
    totals: {
      projectCount: projects.length,
      pageCount: pages.length,
      entryCount: projects.reduce((sum, project) => sum + project.entryCount, 0),
      docCount: pages.length,
      appendixCount: 0,
    },
  }

  if (json) {
    writeJson(successEnvelope('tree', { projects, spaces: spaceViews }, meta))
    return 0
  }

  if (spaceViews.length === 0) {
    writeOut('No pages yet. Create one with "inkwell page new <title> --project <space>".')
    return 0
  }
  for (const space of spaceViews) {
    writeOut(`${space.projectName ?? 'sin espacio'} (${space.pageCount})`)
    const walk = (list: readonly PageView[], depth: number): void => {
      for (const page of list) {
        writeOut(`${String(page.pageId).padStart(5)}  ${'  '.repeat(depth)}${page.title}`)
        walk(page.children ?? [], depth + 1)
      }
    }
    walk(space.pages, 1)
  }
  return 0
}

function runList(ctx: LocalContext, args: ParsedArgs, json: boolean): number {
  const project = selectedSpace(ctx.db, readString(args, 'project'))
  const limit = boundedInteger(args, 'limit', DEFAULT_LIST_LIMIT)
  const offset = boundedInteger(args, 'offset', 0)
  const tallies = talliesByPage(ctx.db, ctx.now)
  const all = listPages(ctx.db, project === null ? undefined : project.id).sort(
    (left, right) => right.recordedAt.localeCompare(left.recordedAt) || right.id - left.id,
  )
  const slice = limit > 0 ? all.slice(offset, offset + limit) : all.slice(offset)
  const data = slice.map((page) => pageView(ctx, page, tallies))

  const meta = {
    root: ctx.docsRoot,
    timezone: ctx.timezone,
    project: project === null ? null : { id: project.id, name: project.name, slug: projectSlug(project.name) },
    page: { limit, offset, returned: data.length, total: all.length, hasMore: limit > 0 && offset + data.length < all.length },
  }

  if (json) {
    writeJson(successEnvelope('ls', data, meta))
    return 0
  }
  if (data.length === 0) {
    writeOut('No pages for that filter.')
    return 0
  }
  for (const page of data) writeOut(`${localDay(page.recordedAt, ctx.timezone)}  #${page.pageId}  ${page.relPath}`)
  return 0
}

function searchScanOptions(args: ParsedArgs, section: string | undefined): ScanOptions {
  return {
    caseSensitive: readBoolean(args, 'case-sensitive'),
    ...(section !== undefined ? { section } : {}),
    ...(readInteger(args, 'context') !== undefined ? { context: boundedInteger(args, 'context', 120) } : {}),
    ...(readInteger(args, 'max-matches') !== undefined ? { max: boundedInteger(args, 'max-matches', 5) } : {}),
    ...(readInteger(args, 'max-scan-docs') !== undefined ? { maxScanDocs: boundedInteger(args, 'max-scan-docs', 5000) } : {}),
    ...(readInteger(args, 'max-scan-bytes') !== undefined ? { maxScanBytes: boundedInteger(args, 'max-scan-bytes', 33_554_432) } : {}),
  }
}

async function runSearch(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  const query = args.positionals[0]
  if (query === undefined || query.trim().length === 0) throw new UsageError('Usage: inkwell search "<text>" [--project X]')

  const project = selectedSpace(ctx.db, readString(args, 'project'))
  const section = readString(args, 'section')
  const limit = boundedInteger(args, 'limit', DEFAULT_SEARCH_LIMIT)
  const offset = boundedInteger(args, 'offset', 0)
  const result = await searchPages(ctx.db, ctx.docsRoot, query, {
    ...searchScanOptions(args, section),
    ...(project !== null ? { projectId: project.id } : {}),
  })

  const data = limit > 0 ? result.hits.slice(offset, offset + limit) : result.hits.slice(offset)
  const meta = {
    root: ctx.docsRoot,
    query,
    caseSensitive: readBoolean(args, 'case-sensitive'),
    section: section ?? null,
    project: project === null ? null : { id: project.id, name: project.name, slug: projectSlug(project.name) },
    page: { limit, offset, returned: data.length, hasMore: limit > 0 && offset + data.length < result.hits.length },
    pagesWithMatches: result.hits.length,
    totalMatches: result.hits.reduce((sum, hit) => sum + hit.matchCount, 0),
    scanned: result.scanned,
    truncated: result.truncated,
    warnings: result.scanned.missing > 0 ? [`${result.scanned.missing} recorded document(s) are gone from disk.`] : [],
  }

  if (json) {
    writeJson(successEnvelope('search', data, meta))
    return 0
  }
  if (data.length === 0) {
    writeOut(`No page matches "${query}".`)
    return 0
  }
  for (const hit of data) {
    const trail = [...hit.ancestors.map((ancestor) => ancestor.title), hit.title].join(' / ')
    writeOut(`#${hit.pageId}  ${hit.matchCount}x  ${trail}`)
    for (const match of hit.matches) writeOut(`    ${`${match.prefix}${match.match}${match.suffix}`.replace(/\n/g, ' ')}`)
  }
  return 0
}
