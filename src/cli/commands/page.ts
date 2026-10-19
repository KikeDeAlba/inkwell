import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assetRelPath } from '../../docs/diagrams.ts'
import {
  ancestorsOf,
  childrenOf,
  deletePage,
  descendantsOf,
  listPages,
  movePage,
  renamePage,
  requirePage,
  uniqueSiblingSlug,
  type DocPageRow,
} from '../../db/pages.ts'
import {
  CATEGORIES,
  ROLES,
  entryIdOf,
  entryLinksOfPage,
  entryRef,
  issuesOfPage,
  linkDuration,
  linkEntryToPage,
  linkIssueToPage,
  linksOfRef,
  meetingsOfPage,
  talliesByPage,
  unlinkEntryFromPage,
  unlinkIssueFromPage,
  worklogIssuesOfPage,
  type PageIssueRole,
  type PageMeeting,
  type StatusCategory,
} from '../../db/page-links.ts'
import { formatDuration } from '../../domain/duration.ts'
import { issueUrl } from '../../domain/jira.ts'
import { localDay, toLocalIso } from '../../domain/timezone.ts'
import { inspectDocFile } from '../../docs/inspect.ts'
import { outline, parseDocument, type DocHeading, type ParsedDocument } from '../../docs/markdown.ts'
import { backlogHeadings } from '../../docs/backlog-extract.ts'
import { listBacklogItems } from '../../db/backlog.ts'
import { linkedSpaceFor } from '../../db/spaces.ts'
import { clearAutodocPending } from '../../db/autodoc-runs.ts'
import { PAGE_SPLIT_BYTES, PAGE_SPLIT_SECTIONS } from '../../config/constants.ts'
import { insertNewPage, newPageRelPath } from '../../docs/page-create.ts'
import { recordPageDoc, movePageFile, pageCommitIntent, pageFilePaths } from '../../docs/page-record.ts'
import {
  commitDocs,
  pageHistory,
  pathAtRev,
  prepareDocsRepo,
  readBlob,
  requireDocsRepo,
  resolveRev,
  revisionDiff,
  worktreeDiff,
} from '../../docs/git.ts'
import { resolveDocPath } from '../../docs/paths.ts'
import { projectSlug, titleSlug } from '../../docs/slug.ts'
import { readRaw } from '../../docs/store.ts'
import { NotFoundError, UsageError } from '../../errors.ts'
import { findBita, requireEntry, snapshotOf, type BitaEntry } from '../../integrations/bita.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readInteger, readString, splitPositionals, type ParsedArgs } from '../args.ts'
import { createLocalContext, type LocalContext } from '../context.ts'
import { successEnvelope, writeErr, writeJson, writeOut } from '../output.ts'
import { briefBody } from '../brief.ts'
import { siteUrlFor, spaceIdArg, spaceNameOf } from '../spaces.ts'
import { addRefToPage, refsOfPage, removeRefFromPage, REF_KINDS, type RefKind } from '../../db/page-refs.ts'
import { classifyUrl } from '../../domain/refs.ts'

const SUBCOMMANDS = new Set([
  'ls',
  'show',
  'new',
  'write',
  'rename',
  'move',
  'link',
  'unlink',
  'rm',
  'ref',
  'asset',
  'history',
  'diff',
  'restore',
])

const OPTIONS = {
  project: { type: 'string' as const },
  parent: { type: 'string' as const },
  position: { type: 'string' as const },
  slug: { type: 'string' as const },
  path: { type: 'string' as const },
  md: { type: 'string' as const },
  body: { type: 'string' as const },
  section: { type: 'string' as const },
  entry: { type: 'string' as const },
  issue: { type: 'string' as const },
  role: { type: 'string' as const },
  summary: { type: 'string' as const },
  status: { type: 'string' as const },
  'status-category': { type: 'string' as const },
  url: { type: 'string' as const },
  title: { type: 'string' as const },
  kind: { type: 'string' as const },
  'from-entries': { type: 'boolean' as const, default: false },
  site: { type: 'string' as const },
  'from-entry': { type: 'string' as const },
  recursive: { type: 'boolean' as const, default: false },
  'keep-doc': { type: 'boolean' as const, default: false },
  'no-markdown': { type: 'boolean' as const, default: false },
  brief: { type: 'boolean' as const, default: false },
  create: { type: 'boolean' as const, default: false },
  tree: { type: 'boolean' as const, default: false },
  rev: { type: 'string' as const },
  limit: { type: 'string' as const },
}

export type PageContext = LocalContext

export async function runPage(argv: string[]): Promise<number> {
  const first = argv[0] ?? 'ls'
  if (!SUBCOMMANDS.has(first)) {
    throw new UsageError(`Usage: inkwell page <${[...SUBCOMMANDS].join('|')}>`)
  }

  const { positional, flags } = splitPositionals(argv.slice(1))
  const args = parseCommandArgs(flags, OPTIONS, BASE_OPTIONS)
  positional.push(...args.positionals)
  const json = readBoolean(args, 'json')
  const ctx: PageContext = createLocalContext(args)

  try {
    if (first === 'ls') return runList(ctx, args, json)
    if (first === 'show') return await runShow(ctx, args, positional, json)
    if (first === 'new') return await runNew(ctx, args, positional, json)
    if (first === 'write') return await runWrite(ctx, args, positional, json)
    if (first === 'rename') return await runRename(ctx, args, positional, json)
    if (first === 'move') return await runMove(ctx, args, positional, json)
    if (first === 'link') return await runLink(ctx, args, positional, json)
    if (first === 'unlink') return await runUnlink(ctx, args, positional, json)
    if (first === 'ref') return await runRef(ctx, args, positional, json)
    if (first === 'asset') return await runAsset(ctx, args, positional, json)
    if (first === 'history') return await runHistory(ctx, args, positional, json)
    if (first === 'diff') return await runPageDiff(ctx, args, positional, json)
    if (first === 'restore') return await runRestore(ctx, args, positional, json)
    return await runRemove(ctx, args, positional, json)
  } finally {
    ctx.db.close()
  }
}

function pageIdArg(positional: string[], args: ParsedArgs, ctx: PageContext): DocPageRow {
  const raw = positional[0]
  if (raw !== undefined) {
    const id = Number(raw)
    if (!Number.isInteger(id) || id <= 0) throw new UsageError(`"${raw}" is not a page id.`)
    return requirePage(ctx.db, id)
  }

  const path = readString(args, 'path')
  if (path === undefined) throw new UsageError('Name the page by id, or pass --path.')

  const page = listPages(ctx.db).find((candidate) => candidate.relPath === path)
  if (!page) throw new NotFoundError(`No page at "${path}".`, 'PAGE_NOT_FOUND')
  return page
}

function parentArg(ctx: PageContext, args: ParsedArgs): DocPageRow | null {
  const raw = readString(args, 'parent')
  if (raw === undefined || raw === '-') return null

  const id = Number(raw)
  if (Number.isInteger(id) && id > 0) return requirePage(ctx.db, id)

  const page = listPages(ctx.db).find((candidate) => candidate.relPath === raw)
  if (!page) throw new NotFoundError(`No page "${raw}".`, 'PAGE_NOT_FOUND')
  return page
}

async function bodyFrom(args: ParsedArgs): Promise<string | undefined> {
  const file = readString(args, 'md')
  if (file !== undefined) return await readFile(file, 'utf8')
  return readString(args, 'body')
}

function projectNameOf(ctx: PageContext, spaceId: number | null): string | null {
  return spaceNameOf(ctx.db, spaceId)
}

function relPathFor(ctx: PageContext, spaceId: number | null, parent: DocPageRow | null, slug: string): string {
  return newPageRelPath(ctx.db, spaceId, parent, slug)
}

export interface PageView {
  pageId: number
  parentId: number | null
  projectId: number | null
  spaceId: number | null
  projectName: string | null
  projectSlug: string
  slug: string
  title: string
  relPath: string
  depth: number
  position: number
  status: string
  entryCount: number
  durationSeconds: number
  durationHuman: string
  issues: ReturnType<typeof issueViews>
  sectionCount: number
  headingCount: number
  byteSize: number
  recordedAt: string
  childCount: number
  meetings: PageMeeting[]
  children?: PageView[]
}

function issueViews(ctx: PageContext, pageId: number, siteUrl: string | undefined) {
  return issuesOfPage(ctx.db, pageId).map((issue) => ({
    issueKey: issue.issueKey,
    role: issue.role,
    summary: issue.summary,
    status: issue.status,
    statusCategory: issue.statusCategory,
    url: issue.url ?? issueUrl(siteUrl, issue.issueKey),
    refreshedAt: issue.refreshedAt,
  }))
}

export function pageView(ctx: PageContext, page: DocPageRow, tallies: ReturnType<typeof talliesByPage>): PageView {
  const tally = tallies.get(page.id)
  const seconds = tally?.durationSeconds ?? 0
  const siteUrl = siteUrlFor(ctx.db, page.spaceId)
  return {
    pageId: page.id,
    parentId: page.parentId,
    projectId: page.spaceId,
    spaceId: page.spaceId,
    projectName: projectNameOf(ctx, page.spaceId),
    projectSlug: projectSlug(projectNameOf(ctx, page.spaceId)),
    slug: page.slug,
    title: page.title,
    relPath: page.relPath,
    depth: page.depth,
    position: page.position,
    status: page.status,
    entryCount: tally?.entryCount ?? 0,
    durationSeconds: seconds,
    durationHuman: formatDuration(seconds),
    issues: issueViews(ctx, page.id, siteUrl),
    sectionCount: page.sectionCount,
    headingCount: page.headingCount,
    byteSize: page.byteSize,
    recordedAt: page.recordedAt,
    childCount: childrenOf(ctx.db, page.id).length,
    meetings: meetingsOfPage(ctx.db, page.id, ctx.now),
  }
}

export function pageTree(ctx: PageContext, spaceId?: number | null): PageView[] {
  const tallies = talliesByPage(ctx.db, ctx.now)
  const all = listPages(ctx.db, spaceId)
  const views = new Map<number, PageView>()
  for (const page of all) views.set(page.id, { ...pageView(ctx, page, tallies), children: [] })

  const roots: PageView[] = []
  for (const page of all) {
    const view = views.get(page.id)
    if (!view) continue
    const parent = page.parentId === null ? undefined : views.get(page.parentId)
    if (parent) parent.children?.push(view)
    else roots.push(view)
  }
  return roots
}

function runList(ctx: PageContext, args: ParsedArgs, json: boolean): number {
  const projectRaw = readString(args, 'project')
  const spaceId = projectRaw === undefined ? undefined : spaceIdArg(ctx.db, projectRaw)
  const asTree = readBoolean(args, 'tree')
  const entryRaw = readString(args, 'entry')
  const linked = entryRaw === undefined ? null : new Set(linksOfRef(ctx.db, entryRef(readEntryId(entryRaw))).map((link) => link.pageId))

  const tallies = talliesByPage(ctx.db, ctx.now)
  const data = asTree && linked === null
    ? { pages: pageTree(ctx, spaceId) }
    : {
        pages: listPages(ctx.db, spaceId)
          .filter((page) => linked === null || linked.has(page.id))
          .map((page) => pageView(ctx, page, tallies)),
      }

  if (json) {
    writeJson(successEnvelope('page ls', data, { root: ctx.docsRoot, timezone: ctx.timezone }))
    return 0
  }

  const flat = asTree && linked === null ? flatten(data.pages) : data.pages
  if (flat.length === 0) {
    writeOut('No pages yet.')
    return 0
  }
  for (const page of flat) {
    const indent = '  '.repeat(page.depth)
    writeOut(`${String(page.pageId).padStart(5)}  ${indent}${page.title}  (${page.durationHuman})`)
  }
  return 0
}

function flatten(pages: PageView[]): PageView[] {
  const out: PageView[] = []
  const walk = (list: PageView[]): void => {
    for (const page of list) {
      out.push(page)
      if (page.children) walk(page.children)
    }
  }
  walk(pages)
  return out
}

async function runShow(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  const siteUrl = siteUrlFor(ctx.db, page.spaceId)
  const absolutePath = resolveDocPath(ctx.docsRoot, page.relPath)
  const raw = await readRaw(absolutePath)
  const revision = await revisionText(ctx, page, readString(args, 'rev'))
  const section = readString(args, 'section')
  if (readBoolean(args, 'brief') || section !== undefined) {
    const source = revision ? revision.markdown : raw
    if (source === null) throw new NotFoundError(`The page file ${page.relPath} is missing.`, 'DOC_MISSING', `Run "inkwell page show ${page.id}" for the file state.`)
    const body = briefBody(source, section)
    const data = {
      pageId: page.id,
      title: page.title,
      space: projectNameOf(ctx, page.spaceId),
      relPath: page.relPath,
      ...(revision ? { rev: revision.sha } : {}),
      ...body,
    }
    if (json) writeJson(successEnvelope('page show', data))
    else writeOut(body.markdown ?? '')
    return 0
  }
  const parsed = raw === null ? null : parseDocument(raw)
  const headings: DocHeading[] = parsed === null ? [] : outline(parsed)
  const inspected = await inspectDocFile(ctx.docsRoot, page)
  const file = inspected.state

  const entries = entryLinksOfPage(ctx.db, page.id).map((link) => {
    const seconds = linkDuration(link, ctx.now)
    return {
      entryId: entryIdOf(link.ref),
      ref: link.ref,
      title: link.title,
      summary: link.summary,
      kind: link.entryKind,
      localDay: link.startedAt === null ? null : localDay(link.startedAt, ctx.timezone),
      startLocal: link.startedAt === null ? null : toLocalIso(link.startedAt, ctx.timezone),
      durationSeconds: seconds,
      durationHuman: formatDuration(seconds),
      running: link.startedAt !== null && link.stoppedAt === null,
      registered: link.worklogIssues.length > 0,
      issueKey: link.worklogIssues[0] ?? null,
      segments: [],
      refreshedAt: link.refreshedAt,
    }
  })

  const data = {
    ...pageView(ctx, page, talliesByPage(ctx.db, ctx.now)),
    ancestors: ancestorsOf(ctx.db, page.id).map((row) => ({
      pageId: row.id,
      title: row.title,
      slug: row.slug,
    })),
    children: childrenOf(ctx.db, page.id).map((row) => ({
      pageId: row.id,
      title: row.title,
      slug: row.slug,
      relPath: row.relPath,
    })),
    doc: {
      path: absolutePath,
      relPath: page.relPath,
      markdown: readBoolean(args, 'no-markdown') ? null : raw,
      frontMatter: parsed === null ? {} : Object.fromEntries(parsed.frontMatter),
      frontMatterValid: parsed?.frontMatterValid ?? false,
      preamble: parsed?.preamble ?? '',
      outline: headings,
      file,
    },
    entries,
    worklogIssues: worklogIssuesOfPage(ctx.db, page.id),
    refs: refViews(ctx, page.id),
    backlog: listBacklogItems(ctx.db, { pageId: page.id, status: 'all' }).map((item) => ({
      id: item.id,
      key: item.key,
      kind: item.kind,
      status: item.status,
      title: item.title,
      body: item.body,
      resolution: item.resolution,
      createdAt: item.createdAt,
      resolvedAt: item.resolvedAt,
    })),
    ...(revision ? { rev: revision.sha, revPath: revision.path, markdown: revision.markdown } : {}),
  }

  if (json) {
    writeJson(
      successEnvelope('page show', data, {
        root: ctx.docsRoot,
        timezone: ctx.timezone,
        jira: { siteUrl: siteUrl ?? null },
      }),
    )
    return 0
  }

  if (revision) {
    writeOut(revision.markdown)
    return 0
  }
  writeOut(`#${page.id}  ${page.title}`)
  writeOut(page.relPath)
  if (headings.length > 0) writeOut(headings.map((heading) => `  ${'  '.repeat(heading.level - 2)}${heading.heading}`).join('\n'))
  return 0
}

function refViews(ctx: PageContext, pageId: number) {
  return refsOfPage(ctx.db, pageId).map((ref) => ({
    url: ref.url,
    title: ref.title,
    kind: ref.kind,
    source: ref.source,
    firstSeenAt: ref.firstSeenAt,
    lastSeenAt: ref.lastSeenAt,
  }))
}

const REF_ACTIONS = new Set(['add', 'ls', 'rm'])

function readRefUrl(args: ParsedArgs): string {
  const url = readString(args, 'url')?.trim()
  if (url === undefined || url.length === 0) throw new UsageError('Pass --url <https://...>.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UsageError(`"${url}" is not a URL.`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UsageError(`"${url}" is not an http(s) URL.`)
  }
  return url
}

async function runRef(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const [action, ...rest] = positional
  if (action === undefined || !REF_ACTIONS.has(action)) {
    throw new UsageError('Usage: inkwell page ref <add|ls|rm> <pageId> [--url U] [--title T] [--kind K]')
  }
  const page = pageIdArg(rest, args, ctx)

  if (action === 'add') {
    const url = readRefUrl(args)
    const kindRaw = readString(args, 'kind')
    if (kindRaw !== undefined && !REF_KINDS.includes(kindRaw as RefKind)) {
      throw new UsageError(`Unknown kind "${kindRaw}". Use one of ${REF_KINDS.join(', ')}.`)
    }
    const kind = (kindRaw as RefKind | undefined) ?? classifyUrl(url) ?? 'link'
    addRefToPage(ctx.db, page.id, {
      url,
      title: readString(args, 'title')?.trim() ?? '',
      kind,
      source: 'manual',
      now: ctx.now.toISOString(),
    })
  }

  let removed = false
  if (action === 'rm') removed = removeRefFromPage(ctx.db, page.id, readRefUrl(args))

  const refs = refViews(ctx, page.id)
  if (json) {
    writeJson(
      successEnvelope(`page ref ${action}`, { pageId: page.id, title: page.title, refs, ...(action === 'rm' ? { removed } : {}) }),
    )
    return 0
  }
  if (action === 'rm' && !removed) writeOut('That link was not on the page.')
  if (refs.length === 0) {
    writeOut(`#${page.id} ${page.title} has no links.`)
    return 0
  }
  for (const ref of refs) writeOut(`${ref.kind.padEnd(10)} ${ref.title ? `${ref.title}  ` : ''}${ref.url}`)
  return 0
}

async function runAsset(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const [action, ...rest] = positional
  const name = rest[1]
  if (action !== 'path' || name === undefined) {
    throw new UsageError('Usage: inkwell page asset path <pageId> <file> [--create]')
  }
  const page = pageIdArg(rest.slice(0, 1), args, ctx)
  const relPath = assetRelPath(page.relPath, name)
  const path = resolveDocPath(ctx.docsRoot, relPath)
  if (readBoolean(args, 'create')) await mkdir(dirname(path), { recursive: true, mode: 0o700 })

  const data = { pageId: page.id, title: page.title, relPath, path, exists: existsSync(path) }
  if (json) {
    writeJson(successEnvelope('page asset path', data, { root: ctx.docsRoot }))
    return 0
  }
  writeOut(path)
  return 0
}

async function runNew(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const title = positional[0]
  if (title === undefined || title.trim().length === 0) throw new UsageError('A page needs a title.')

  const parent = parentArg(ctx, args)
  const fromEntryRaw = readString(args, 'from-entry')
  const fromEntry = fromEntryRaw === undefined ? null : await entryFromBita(readEntryId(fromEntryRaw))

  const projectRaw = readString(args, 'project')
  const projectId = parent
    ? parent.spaceId
    : projectRaw !== undefined
      ? spaceIdArg(ctx.db, projectRaw)
      : fromEntry?.projectId != null
        ? (linkedSpaceFor(ctx.db, fromEntry.projectId, fromEntry.projectName)?.id ?? null)
        : null

  const page = insertNewPage(ctx, { title, spaceId: projectId, parent, slug: readString(args, 'slug'), source: 'cli' })
  const id = page.id
  if (fromEntry) linkEntryToPage(ctx.db, id, fromEntry.id, '', ctx.now.toISOString(), snapshotOf(fromEntry, ctx.now))
  const recorded = await recordPageDoc(ctx, page)

  return report(ctx, 'page new', requirePage(ctx.db, id), json, { path: recorded.path })
}

async function runWrite(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  const body = await bodyFrom(args)
  if (body === undefined) throw new UsageError('Pass --md <file> or --body <text>.')

  const heading = readString(args, 'section')
  const write = heading === undefined ? { body } : { section: { heading, body } }
  const recorded = await recordPageDoc(ctx, page, write)
  if (heading === undefined) clearAutodocPending(ctx.db, page.id)
  const written = await readRaw(recorded.path)
  const warnings = written === null ? [] : pageWarnings(parseDocument(written), Buffer.byteLength(written))

  if (!json) for (const warning of warnings) writeErr(`Warning: ${warning.message}`)
  return report(ctx, 'page write', requirePage(ctx.db, page.id), json, {
    path: recorded.path,
    changed: recorded.changed,
    warnings,
    sha: recorded.sha,
  })
}

export function pageWarnings(doc: ParsedDocument, bytes: number): { code: string; message: string }[] {
  const warnings: { code: string; message: string }[] = []
  const backlog = backlogHeadings(doc)
  if (backlog.length > 0) {
    warnings.push({
      code: 'BACKLOG_SECTION_IN_PAGE',
      message: `The page carries ${backlog.map((heading) => `"${heading}"`).join(', ')}. A page describes the current state only: move those items with "inkwell backlog add" (or "inkwell backlog extract --page <id>").`,
    })
  }
  const sections = doc.sections.filter((section) => section.body.trim().length > 0).length
  if (sections > PAGE_SPLIT_SECTIONS || bytes > PAGE_SPLIT_BYTES) {
    warnings.push({
      code: 'PAGE_SHOULD_SPLIT',
      message: `The page has ${sections} sections and ${Math.round(bytes / 1024)} KB. Split the parts that stand on their own into child pages with "inkwell page new --parent <id>" and leave this one as the overview.`,
    })
  }
  return warnings
}

async function runRename(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  const title = positional[1]
  if (title === undefined || title.trim().length === 0) throw new UsageError('A page needs a title.')

  const wanted = readString(args, 'slug') ?? titleSlug(title)
  const slug = uniqueSiblingSlug(ctx.db, page.spaceId, page.parentId, titleSlug(wanted), page.id)
  renamePage(ctx.db, page.id, title.trim(), slug, ctx.now.toISOString())

  const renamed = requirePage(ctx.db, page.id)
  const parent = renamed.parentId === null ? null : requirePage(ctx.db, renamed.parentId)
  const toRelPath = relPathFor(ctx, renamed.spaceId, parent, slug)
  await movePageFile(ctx, renamed, toRelPath, false)
  await recordPageDoc(ctx, requirePage(ctx.db, page.id), {}, false)
  await commitDocs(
    ctx.docsRoot,
    [...pageFilePaths(page.relPath), ...pageFilePaths(toRelPath)],
    pageCommitIntent(requirePage(ctx.db, page.id), toRelPath, 'rename', {}),
  )

  return report(ctx, 'page rename', requirePage(ctx.db, page.id), json)
}

async function runMove(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  const parent = readString(args, 'parent') === undefined ? (page.parentId === null ? null : requirePage(ctx.db, page.parentId)) : parentArg(ctx, args)
  const position = readInteger(args, 'position')
  const projectRaw = readString(args, 'project')

  movePage(ctx.db, page.id, {
    parentId: parent?.id ?? null,
    ...(projectRaw !== undefined ? { spaceId: spaceIdArg(ctx.db, projectRaw) } : {}),
    ...(position !== undefined ? { position } : {}),
  })

  const moved = requirePage(ctx.db, page.id)
  await movePageFile(ctx, moved, relPathFor(ctx, moved.spaceId, parent, moved.slug))

  return report(ctx, 'page move', requirePage(ctx.db, page.id), json)
}

async function runLink(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  const now = ctx.now.toISOString()
  const siteUrl = readString(args, 'site') ?? siteUrlFor(ctx.db, page.spaceId)
  const warnings: string[] = []

  const entryRaw = readString(args, 'entry')
  if (entryRaw !== undefined) {
    const ids = entryRaw.split(',').map((token) => readEntryId(token))
    const bita = await findBita()
    if (bita === null) warnings.push('bita is not installed, so the entries were linked without their title or duration.')
    for (const id of ids) {
      const entry = bita === null ? null : await requireEntry(bita, id)
      linkEntryToPage(ctx.db, page.id, id, readString(args, 'summary') ?? '', now, entry === null ? {} : snapshotOf(entry, ctx.now))
    }
  }

  const issueKey = readString(args, 'issue')
  if (issueKey !== undefined) {
    const role = readString(args, 'role') ?? 'task'
    if (!ROLES.includes(role as PageIssueRole)) throw new UsageError(`Unknown role "${role}".`)
    const category = readString(args, 'status-category') ?? ''
    if (!CATEGORIES.includes(category as StatusCategory)) {
      throw new UsageError(`Unknown status category "${category}".`)
    }
    linkIssueToPage(ctx.db, {
      pageId: page.id,
      issueKey,
      role: role as PageIssueRole,
      summary: readString(args, 'summary') ?? '',
      status: readString(args, 'status') ?? '',
      statusCategory: category as StatusCategory,
      url: readString(args, 'url') ?? issueUrl(siteUrl, issueKey),
      now,
    })
  }

  if (readBoolean(args, 'from-entries')) {
    for (const key of worklogIssuesOfPage(ctx.db, page.id)) {
      linkIssueToPage(ctx.db, { pageId: page.id, issueKey: key, url: issueUrl(siteUrl, key), now })
    }
  }

  if (entryRaw === undefined && issueKey === undefined && !readBoolean(args, 'from-entries')) {
    throw new UsageError('Pass --entry, --issue or --from-entries.')
  }

  if (issueKey !== undefined || readBoolean(args, 'from-entries')) await restampIssues(ctx, page)

  if (!json) for (const warning of warnings) writeErr(`Warning: ${warning}`)
  return report(ctx, 'page link', requirePage(ctx.db, page.id), json, warnings.length > 0 ? { warnings } : {})
}

async function runUnlink(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)

  const entryRaw = readString(args, 'entry')
  if (entryRaw !== undefined) {
    for (const token of entryRaw.split(',')) unlinkEntryFromPage(ctx.db, page.id, readEntryId(token))
  }

  const issueKey = readString(args, 'issue')
  if (issueKey !== undefined) unlinkIssueFromPage(ctx.db, page.id, issueKey)

  if (entryRaw === undefined && issueKey === undefined) throw new UsageError('Pass --entry or --issue.')

  if (issueKey !== undefined) await restampIssues(ctx, page)

  return report(ctx, 'page unlink', requirePage(ctx.db, page.id), json)
}

async function restampIssues(ctx: PageContext, page: DocPageRow): Promise<void> {
  const raw = await readRaw(resolveDocPath(ctx.docsRoot, page.relPath))
  if (raw === null) return
  await recordPageDoc(ctx, page)
}

async function runRemove(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  const children = descendantsOf(ctx.db, page.id)

  if (children.length > 0 && !readBoolean(args, 'recursive')) {
    throw new UsageError(
      `Page #${page.id} has ${children.length} page${children.length === 1 ? '' : 's'} under it. Pass --recursive.`,
    )
  }

  const doomed = [...children.reverse(), page]
  await prepareDocsRepo(ctx.docsRoot)
  const paths = doomed.flatMap((target) => pageFilePaths(target.relPath))
  for (const relPath of paths) await rm(resolveDocPath(ctx.docsRoot, relPath), { recursive: true, force: true })
  for (const target of doomed) deletePage(ctx.db, target.id)
  const sha = await commitDocs(ctx.docsRoot, paths, pageCommitIntent(page, page.relPath, 'remove', {}))

  const data = { removed: doomed.map((target) => ({ pageId: target.id, title: target.title, relPath: target.relPath })), sha }
  if (json) {
    writeJson(successEnvelope('page rm', data, { root: ctx.docsRoot }))
    return 0
  }
  writeOut(`Removed ${doomed.length} page${doomed.length === 1 ? '' : 's'} and ${doomed.length === 1 ? 'its file' : 'their files'}.`)
  return 0
}

async function revisionText(
  ctx: PageContext,
  page: DocPageRow,
  rev: string | undefined,
): Promise<{ sha: string; path: string; markdown: string } | null> {
  if (rev === undefined) return null
  await requireDocsRepo(ctx.docsRoot)
  const sha = await resolveRev(ctx.docsRoot, rev)
  const { path } = await pathAtRev(ctx.docsRoot, page.relPath, sha)
  const markdown = await readBlob(ctx.docsRoot, sha, path)
  if (markdown === null) {
    throw new NotFoundError(`Page #${page.id} has no content at ${sha.slice(0, 7)}.`, 'REV_NOT_FOUND')
  }
  return { sha, path, markdown }
}

async function runHistory(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  const limit = readInteger(args, 'limit')
  if (limit !== undefined && limit <= 0) throw new UsageError('--limit must be a positive number.')
  const revisions = await pageHistory(ctx.docsRoot, page.relPath, limit)
  const data = { pageId: page.id, path: page.relPath, revisions }

  if (json) {
    writeJson(successEnvelope('page history', data, { root: ctx.docsRoot }))
    return 0
  }
  if (revisions.length === 0) {
    writeOut(`Page #${page.id} has no history yet.`)
    return 0
  }
  for (const revision of revisions) {
    writeOut(`${revision.sha.slice(0, 7)}  ${revision.date}  ${revision.source.padEnd(15)} ${revision.subject}`)
  }
  return 0
}

async function runPageDiff(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  await requireDocsRepo(ctx.docsRoot)
  const rev = positional[1] ?? readString(args, 'rev')
  const result = rev === undefined ? await worktreeDiff(ctx.docsRoot, page.relPath) : await revisionDiff(ctx.docsRoot, page.relPath, rev)
  const data = { pageId: page.id, from: result.from, to: result.to, diff: result.diff, hunks: result.hunks }

  if (json) {
    writeJson(successEnvelope('page diff', data, { root: ctx.docsRoot }))
    return 0
  }
  if (result.diff.length === 0) writeOut('No changes.')
  else process.stdout.write(result.diff)
  return 0
}

async function runRestore(ctx: PageContext, args: ParsedArgs, positional: string[], json: boolean): Promise<number> {
  const page = pageIdArg(positional, args, ctx)
  const rev = positional[1] ?? readString(args, 'rev')
  if (rev === undefined) throw new UsageError('Usage: inkwell page restore <pageId> <sha>')
  const revision = await revisionText(ctx, page, rev)
  if (revision === null) throw new UsageError('Usage: inkwell page restore <pageId> <sha>')

  const recorded = await recordPageDoc(
    ctx,
    page,
    { body: revision.markdown },
    { source: 'restore', action: `restore ${revision.sha.slice(0, 7)} of`, reason: `restore ${revision.sha.slice(0, 7)}` },
  )
  const written = await readRaw(recorded.path)
  const warnings = written === null ? [] : pageWarnings(parseDocument(written), Buffer.byteLength(written))

  return report(ctx, 'page restore', requirePage(ctx.db, page.id), json, {
    path: recorded.path,
    changed: recorded.changed,
    warnings,
    sha: recorded.sha,
    restoredFrom: revision.sha,
  })
}

function report(
  ctx: PageContext,
  command: string,
  page: DocPageRow,
  json: boolean,
  extra: Record<string, unknown> = {},
): number {
  const data = {
    page: pageView(ctx, page, talliesByPage(ctx.db, ctx.now)),
    ...extra,
  }
  if (json) {
    writeJson(successEnvelope(command, data, { root: ctx.docsRoot, timezone: ctx.timezone }))
    return 0
  }
  writeOut(`#${page.id}  ${page.title}`)
  writeOut(resolveDocPath(ctx.docsRoot, page.relPath))
  return 0
}

function readEntryId(raw: string): number {
  const id = Number(raw.trim())
  if (!Number.isInteger(id) || id <= 0) throw new UsageError(`"${raw}" is not an entry id.`)
  return id
}

async function entryFromBita(id: number): Promise<BitaEntry | null> {
  const bita = await findBita()
  if (bita === null) return null
  return await requireEntry(bita, id)
}
