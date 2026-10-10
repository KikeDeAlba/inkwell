import { readFile } from 'node:fs/promises'
import { ENTRY_NOTE_SECTIONS } from '../../config/constants.ts'
import { appendixCounts, findNoteByRelPath, findNoteForEntry, listNotes, listNotesForEntry, type EntryNoteRow, type NoteFilter } from '../../db/entry-notes.ts'
import { bitaProjectRef, resolveSpaceArg } from '../../db/spaces.ts'
import { RANGE_PRESETS, resolveDateRange, type RangePreset, type ResolvedRange } from '../../domain/date-range.ts'
import { formatDuration } from '../../domain/duration.ts'
import { localDay, toLocalIso } from '../../domain/timezone.ts'
import { currentRepoIdentity, entryFromNote, notePathFor, readNoteFile, recordEntryNote } from '../../docs/entry-note.ts'
import { commitDocs, docsSubject } from '../../docs/git.ts'
import { inspectDocFile, type DocFileState } from '../../docs/inspect.ts'
import { parseDocument, sectionStates, type DocSectionState } from '../../docs/markdown.ts'
import { scanFiles, type ScanOptions } from '../../docs/search.ts'
import { projectSlug } from '../../docs/slug.ts'
import { readRaw } from '../../docs/store.ts'
import { NotFoundError, UsageError } from '../../errors.ts'
import { entryDuration, findBita, type BitaEntry } from '../../integrations/bita.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readInteger, readString, type ParsedArgs } from '../args.ts'
import { withLocalContext, type LocalContext } from '../context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'

const OPTIONS = {
  entry: { type: 'string' as const },
  draft: { type: 'boolean' as const, default: false },
  create: { type: 'boolean' as const, default: false },
  raw: { type: 'boolean' as const, default: false },
  md: { type: 'string' as const },
  'note-md': { type: 'string' as const },
  'note-json': { type: 'string' as const },
  section: { type: 'string' as const },
  file: { type: 'string' as const, multiple: true },
  command: { type: 'string' as const, multiple: true },
  resource: { type: 'string' as const, multiple: true },
  project: { type: 'string' as const },
  from: { type: 'string' as const },
  to: { type: 'string' as const },
  'last-days': { type: 'string' as const },
  'with-doc': { type: 'boolean' as const, default: false },
  limit: { type: 'string' as const },
  offset: { type: 'string' as const },
  'no-sections': { type: 'boolean' as const, default: false },
  'no-verify': { type: 'boolean' as const, default: false },
  'no-markdown': { type: 'boolean' as const, default: false },
  path: { type: 'string' as const },
  context: { type: 'string' as const },
  'max-matches': { type: 'string' as const },
  'case-sensitive': { type: 'boolean' as const, default: false },
  'max-scan-docs': { type: 'string' as const },
  'max-scan-bytes': { type: 'string' as const },
}

const SUBCOMMANDS = new Set(['path', 'save', 'set', 'get', 'show', 'ls', 'search'])
const DEFAULT_LIST_LIMIT = 50
const DEFAULT_SEARCH_LIMIT = 30
const DEFAULT_SAVE_SECTION = 'Qué se hizo'

export const NOTE_USAGE = 'Usage: inkwell note <path|show|get|save|ls|search> <entryId|--entry ID|--draft>'

export async function runNote(argv: string[]): Promise<number> {
  const first = argv[0] ?? 'get'
  const subcommand = SUBCOMMANDS.has(first) ? first : 'get'
  const rest = SUBCOMMANDS.has(first) ? argv.slice(1) : argv
  const args = parseCommandArgs(rest, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')

  return withLocalContext(args, async (ctx) => {
    if (subcommand === 'search') return runSearch(ctx, args, json)
    if (subcommand === 'show') return runShow(ctx, args, json)
    if (subcommand === 'ls' && !mentionsEntry(args)) return runList(ctx, args, json)

    const entryId = await resolveEntryId(args, `Usage: inkwell note ${subcommand} <entryId|--entry ID|--draft>`)
    if (subcommand === 'ls') return runEntryList(ctx, entryId, json)
    const entry = await loadEntry(ctx, entryId)
    if (subcommand === 'path') return runPath(ctx, entry, args, json)
    if (subcommand === 'save' || subcommand === 'set') return runSave(ctx, entry, args, json)
    return runGet(ctx, entry, args, json)
  })
}

function mentionsEntry(args: ParsedArgs): boolean {
  if (readString(args, 'entry') !== undefined || readBoolean(args, 'draft')) return true
  const first = args.positionals[0]
  return first !== undefined && /^\d+$/.test(first)
}

function parseEntryId(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

async function resolveEntryId(args: ParsedArgs, usage: string): Promise<number> {
  if (readBoolean(args, 'draft')) {
    const bita = await findBita()
    const drafts = bita === null ? [] : (await bita.running()).filter((entry) => entry.description.length === 0)
    const only = drafts[0]
    if (!only) throw new UsageError('No running draft. Start one with "bita start".')
    if (drafts.length > 1) throw new UsageError(`${drafts.length} running drafts (${drafts.map((entry) => `#${entry.id}`).join(', ')}); name the one you mean.`)
    return only.id
  }
  const id = parseEntryId(readString(args, 'entry') ?? args.positionals[0])
  if (id === null) throw new UsageError(usage)
  return id
}

export async function loadEntry(ctx: LocalContext, entryId: number): Promise<BitaEntry> {
  const bita = await findBita()
  const fresh = bita === null ? null : await bita.entry(entryId).catch(() => null)
  if (fresh) return fresh
  const stored = findNoteForEntry(ctx.db, entryId) ?? listNotesForEntry(ctx.db, entryId)[0]
  if (stored) return entryFromNote(stored)
  throw new NotFoundError(
    `No entry #${entryId}: bita does not know it${bita === null ? ' (bita is not installed)' : ''} and inkwell has no note for it.`,
    'ENTRY_NOT_FOUND',
    'Run "bita ls --json" to see the entries.',
  )
}

async function runPath(ctx: LocalContext, entry: BitaEntry, args: ParsedArgs, json: boolean): Promise<number> {
  if (readBoolean(args, 'create')) {
    const recorded = await recordEntryNote(ctx, entry, { source: 'manual', identity: await currentRepoIdentity(), create: true })
    if (!recorded) throw new UsageError(`Could not create the note for entry #${entry.id}.`)
    if (json) writeJson(successEnvelope('note path', recorded))
    else writeOut(recorded.path)
    return 0
  }
  const located = notePathFor(ctx, entry)
  if (json) writeJson(successEnvelope('note path', { entryId: entry.id, ...located, exists: (await readRaw(located.path)) !== null }))
  else writeOut(located.path)
  return 0
}

async function readSource(path: string): Promise<string> {
  try {
    return path === '-' ? await readStdin() : await readFile(path, 'utf8')
  } catch (error) {
    throw new UsageError(`Could not read the markdown at ${path}: ${String(error)}`)
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}

async function readLegacyNote(path: string): Promise<string> {
  let raw: unknown
  try {
    raw = JSON.parse(await readSource(path))
  } catch (error) {
    if (error instanceof UsageError) throw error
    throw new UsageError(`Could not read the note at ${path}: ${String(error)}`)
  }
  const body = (raw as { body?: unknown } | null)?.body
  if (typeof body !== 'string') throw new UsageError('The note needs a "body" string.')
  return body
}

function list(args: ParsedArgs, name: string): string[] {
  const value = args.values[name]
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
}

function artifactSection(files: string[], commands: string[], resources: string[]): string {
  const parts: string[] = []
  const block = (title: string, lines: string[]) => {
    if (lines.length === 0) return
    if (parts.length > 0) parts.push('')
    parts.push(`### ${title}`, '', ...lines)
  }
  block('Archivos', files.map((file) => `- \`${file}\``))
  block('Comandos', commands.map((command) => `- \`${command}\``))
  block('Recursos', resources.map((resource) => `- ${resource}`))
  return parts.join('\n')
}

async function runSave(ctx: LocalContext, entry: BitaEntry, args: ParsedArgs, json: boolean): Promise<number> {
  const markdownPath = readString(args, 'md') ?? readString(args, 'note-md')
  const jsonPath = readString(args, 'note-json')
  if (readString(args, 'md') !== undefined && readString(args, 'note-md') !== undefined) throw new UsageError('Pass --md or --note-md, not both.')

  const sections: { heading: string; body: string }[] = []
  if (markdownPath !== undefined) sections.push({ heading: readString(args, 'section') ?? DEFAULT_SAVE_SECTION, body: await readSource(markdownPath) })
  else if (jsonPath !== undefined) sections.push({ heading: readString(args, 'section') ?? 'Resumen', body: await readLegacyNote(jsonPath) })
  else if (readString(args, 'section') !== undefined) throw new UsageError('--section needs the text: pass --md <file> or --md - to read it from stdin.')

  const artifacts = artifactSection(list(args, 'file'), list(args, 'command'), list(args, 'resource'))
  if (artifacts.length > 0) sections.push({ heading: 'Tocado', body: artifacts })

  const recorded = await recordEntryNote(ctx, entry, { source: 'manual', identity: await currentRepoIdentity(), create: true, sections, commit: false })
  if (!recorded) throw new UsageError(`No note for entry #${entry.id}.`)
  await commitDocs(ctx.docsRoot, [recorded.relPath, ...(recorded.renamedFrom !== null ? [recorded.renamedFrom] : [])], {
    source: 'note',
    subject: docsSubject(recorded.relPath, recorded.created ? 'create note' : 'update note', entry.description || `#${entry.id}`),
    entryId: entry.id,
  })

  if (json) writeJson(successEnvelope('note save', recorded))
  else {
    writeOut(`Saved ${recorded.relPath}`)
    writeOut(`Sections: ${recorded.sectionCount}, ${recorded.byteSize} bytes`)
    if (!recorded.frontMatterValid) writeOut('The front matter could not be read, so it was left untouched.')
  }
  return 0
}

function runEntryList(ctx: LocalContext, entryId: number, json: boolean): number {
  const notes = listNotesForEntry(ctx.db, entryId)
  if (json) {
    writeJson(successEnvelope('note ls', notes, { entryId, root: ctx.docsRoot }))
    return 0
  }
  if (notes.length === 0) writeOut(`No note recorded for entry #${entryId}.`)
  for (const note of notes) writeOut(`${note.kind === 'note' ? ' ' : '+'} ${note.relPath}`)
  return 0
}

async function runGet(ctx: LocalContext, entry: BitaEntry, args: ParsedArgs, json: boolean): Promise<number> {
  const notes = listNotesForEntry(ctx.db, entry.id)
  const primary = notes.find((note) => note.kind === 'note') ?? notes[0]
  if (!primary) {
    if (json) writeJson(successEnvelope('note get', null, { entryId: entry.id }))
    else writeOut(`No note recorded for entry #${entry.id}.`)
    return 0
  }
  const { path, markdown } = await readNoteFile(ctx, primary)
  if (json) {
    writeJson(successEnvelope('note get', { ...primary, path, markdown }, { entryId: entry.id, root: ctx.docsRoot }))
    return 0
  }
  if (markdown === null) writeOut(`The note was recorded at ${path}, but the file is gone.`)
  else if (readBoolean(args, 'raw')) writeOut(markdown)
  else writeOut(`${path}\n\n${markdown}`)
  return 0
}

function entryView(ctx: LocalContext, entry: BitaEntry, spaceId: number | null): Record<string, unknown> {
  const day = localDay(entry.startedAt, ctx.timezone)
  const duration = entryDuration(entry, ctx.now)
  return {
    entryId: entry.id,
    projectId: entry.projectId,
    projectName: entry.projectName,
    projectSlug: projectSlug(entry.projectName),
    spaceId,
    title: entry.description,
    localDay: day,
    month: day.slice(0, 7),
    startLocal: toLocalIso(entry.startedAt, ctx.timezone),
    durationSeconds: duration,
    durationHuman: formatDuration(duration),
    running: entry.stoppedAt === null,
    registered: entry.issueKey !== null,
    issueKey: entry.issueKey,
  }
}

interface FileTally {
  verified: number
  ok: number
  changed: number
  missing: number
  unverified: number
}

function emptyTally(): FileTally {
  return { verified: 0, ok: 0, changed: 0, missing: 0, unverified: 0 }
}

function tally(counts: FileTally, state: DocFileState): void {
  counts[state.status] += 1
  if (state.status !== 'unverified') counts.verified += 1
}

function warningsFor(counts: FileTally): string[] {
  const warnings: string[] = []
  if (counts.missing > 0) warnings.push(`${counts.missing} note${counts.missing === 1 ? ' is' : 's are'} recorded but the file is gone.`)
  if (counts.changed > 0) warnings.push(`${counts.changed} note${counts.changed === 1 ? ' was' : 's were'} edited outside inkwell.`)
  return warnings
}

function boundedInteger(args: ParsedArgs, name: string, fallback: number): number {
  const value = readInteger(args, name)
  if (value === undefined) return fallback
  if (value < 0) throw new UsageError(`Invalid value for --${name}: "${value}". Expected zero or more.`)
  return value
}

interface SelectedProject {
  id: number | null
  name: string | null
  filter: NoteFilter
}

function selectedProject(ctx: LocalContext, args: ParsedArgs): SelectedProject | null {
  const raw = readString(args, 'project')
  if (raw === undefined) return null
  if (raw === '_no-project' || raw === '-') return { id: null, name: null, filter: { projectId: null } }
  const space = resolveSpaceArg(ctx.db, raw)
  const match = /^bita:project:(\d+)$/.exec(space.externalRef ?? '')
  const projectId = match?.[1] !== undefined ? Number(match[1]) : undefined
  return { id: space.id, name: space.name, filter: { spaceId: space.id, ...(projectId !== undefined && space.externalRef === bitaProjectRef(projectId) ? { projectId } : {}) } }
}

function rangeFor(ctx: LocalContext, args: ParsedArgs): ResolvedRange | null {
  const first = args.positionals[0]
  if (first !== undefined && !RANGE_PRESETS.includes(first as RangePreset)) {
    throw new UsageError(`Unknown range preset "${first}". Valid presets: ${RANGE_PRESETS.join(', ')}.`)
  }
  const preset = first as RangePreset | undefined
  const from = readString(args, 'from')
  const to = readString(args, 'to')
  const lastDays = readInteger(args, 'last-days')
  if (preset === undefined && from === undefined && to === undefined && lastDays === undefined) return null
  return resolveDateRange(
    { ...(preset !== undefined ? { preset } : {}), ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), ...(lastDays !== undefined ? { lastDays } : {}) },
    { timezone: ctx.timezone, beginningOfWeek: 1, now: ctx.now },
  )
}

function notesIn(ctx: LocalContext, project: SelectedProject | null, range: ResolvedRange | null): EntryNoteRow[] {
  const filter: NoteFilter = {
    ...(project ? project.filter : {}),
    ...(range ? { fromUtc: `${range.queryStartDate}T00:00:00.000Z`, toUtc: `${range.queryEndDate}T00:00:00.000Z` } : {}),
  }
  const rows = listNotes(ctx.db, filter)
  if (range === null) return rows
  return rows.filter((row) => {
    const day = localDay(row.startedAt, ctx.timezone)
    return day >= range.fromDay && day <= range.toDay
  })
}

interface NoteView {
  relPath: string
  path: string
  docTitle: string
  kind: string
  source: string
  sectionCount: number
  byteSize: number
  createdAt: string
  recordedAt: string
  repoSlug: string | null
  branch: string | null
  headSha: string | null
  appendixCount: number
  sections: DocSectionState[] | null
  file: DocFileState
}

async function viewOf(ctx: LocalContext, row: EntryNoteRow, appendixCount: number, options: { verify: boolean; sections: boolean }): Promise<NoteView> {
  const { state, raw } = await inspectDocFile(ctx.docsRoot, row, { verify: options.verify })
  const parsed = raw === null ? null : parseDocument(raw)
  return {
    relPath: row.relPath,
    path: state.path,
    docTitle: row.title,
    kind: row.kind,
    source: row.source,
    sectionCount: parsed === null ? row.sectionCount : sectionStates(parsed, ENTRY_NOTE_SECTIONS).filter((section) => section.state === 'written').length,
    byteSize: state.byteSize ?? row.byteSize,
    createdAt: row.createdAt,
    recordedAt: row.recordedAt,
    repoSlug: row.repoSlug,
    branch: row.branch,
    headSha: row.headSha,
    appendixCount,
    sections: options.sections && parsed !== null ? sectionStates(parsed, ENTRY_NOTE_SECTIONS) : null,
    file: state,
  }
}

function projectMeta(project: SelectedProject | null) {
  return project === null ? null : { id: project.id, name: project.name, slug: projectSlug(project.name) }
}

async function runList(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  const project = selectedProject(ctx, args)
  const range = rangeFor(ctx, args)
  const verify = !readBoolean(args, 'no-verify')
  const wantsSections = !readBoolean(args, 'no-sections')
  const limit = boundedInteger(args, 'limit', DEFAULT_LIST_LIMIT)
  const offset = boundedInteger(args, 'offset', 0)

  const all = notesIn(ctx, project, range)
  const rows = limit > 0 ? all.slice(offset, offset + limit) : all.slice(offset)
  const appendices = appendixCounts(ctx.db)
  const counts = emptyTally()
  const months = new Map<string, number>()
  const data: Record<string, unknown>[] = []
  for (const row of rows) {
    const entry = entryView(ctx, entryFromNote(row), row.spaceId)
    const month = String(entry['month'])
    months.set(month, (months.get(month) ?? 0) + 1)
    const view = await viewOf(ctx, row, appendices.get(row.entryId) ?? 0, { verify, sections: wantsSections })
    tally(counts, view.file)
    data.push({ ...entry, doc: view })
  }

  const meta = {
    root: ctx.docsRoot,
    timezone: ctx.timezone,
    project: projectMeta(project),
    range: range === null ? null : { fromDay: range.fromDay, toDay: range.toDay, preset: range.preset },
    page: { limit, offset, returned: data.length, total: all.length, hasMore: limit > 0 && offset + data.length < all.length },
    counts: { withDoc: data.length, withoutDoc: 0 },
    files: counts,
    months: [...months.entries()].map(([month, count]) => ({ month, count })).sort((left, right) => right.month.localeCompare(left.month)),
    warnings: warningsFor(counts),
  }
  if (json) {
    writeJson(successEnvelope('note ls', data, meta))
    return 0
  }
  if (data.length === 0) writeOut('No notes.')
  for (const row of data) writeOut(`${String(row['localDay'])}  #${String(row['entryId'])}  ${(row['doc'] as NoteView).relPath}`)
  return 0
}

async function runShow(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  const relPath = readString(args, 'path')
  const verify = !readBoolean(args, 'no-verify')
  const wantsMarkdown = !readBoolean(args, 'no-markdown')

  let primary: EntryNoteRow | undefined
  let entry: BitaEntry
  if (relPath !== undefined) {
    primary = findNoteByRelPath(ctx.db, relPath)
    if (!primary) throw new NotFoundError(`No note at "${relPath}".`, 'DOC_NOT_FOUND', 'Run "inkwell note ls" to see them.')
    entry = entryFromNote(primary)
  } else {
    const entryId = parseEntryId(readString(args, 'entry') ?? args.positionals[0])
    if (entryId === null) throw new UsageError('Usage: inkwell note show <entryId> | --path <relPath>')
    const notes = listNotesForEntry(ctx.db, entryId)
    primary = notes.find((note) => note.kind === 'note') ?? notes[0]
    entry = primary ? entryFromNote(primary) : await loadEntry(ctx, entryId)
  }

  if (primary === undefined) {
    const data = { ...entryView(ctx, entry, null), doc: null, appendices: [] }
    if (json) writeJson(successEnvelope('note show', data, { root: ctx.docsRoot, timezone: ctx.timezone, warnings: [] }))
    else writeOut(`No note recorded for entry #${entry.id}.`)
    return 0
  }

  const { state, raw } = await inspectDocFile(ctx.docsRoot, primary, { verify })
  const parsed = raw === null ? null : parseDocument(raw)
  const appendixViews = []
  for (const appendix of listNotesForEntry(ctx.db, entry.id).filter((note) => note.kind === 'appendix')) {
    const inspected = await inspectDocFile(ctx.docsRoot, appendix, { verify })
    appendixViews.push({
      relPath: appendix.relPath,
      path: inspected.state.path,
      title: appendix.title,
      sectionCount: appendix.sectionCount,
      byteSize: inspected.state.byteSize ?? appendix.byteSize,
      file: inspected.state,
    })
  }
  const counts = emptyTally()
  tally(counts, state)

  const data = {
    ...entryView(ctx, entry, primary.spaceId),
    doc: {
      kind: primary.kind,
      relPath: primary.relPath,
      path: state.path,
      docTitle: parsed?.title ?? primary.title,
      frontMatter: parsed === null ? {} : Object.fromEntries(parsed.frontMatter),
      frontMatterValid: parsed?.frontMatterValid ?? false,
      preamble: parsed?.preamble ?? '',
      sections: parsed === null ? null : sectionStates(parsed, ENTRY_NOTE_SECTIONS),
      sectionCount: primary.sectionCount,
      byteSize: state.byteSize ?? primary.byteSize,
      markdown: wantsMarkdown ? raw : null,
      source: primary.source,
      createdAt: primary.createdAt,
      recordedAt: primary.recordedAt,
      repoSlug: primary.repoSlug,
      branch: primary.branch,
      headSha: primary.headSha,
      file: state,
    },
    appendices: appendixViews,
  }
  const meta = { root: ctx.docsRoot, timezone: ctx.timezone, sections: [...ENTRY_NOTE_SECTIONS], warnings: warningsFor(counts) }
  if (json) {
    writeJson(successEnvelope('note show', data, meta))
    return 0
  }
  writeOut(raw === null ? `The note was recorded at ${state.path}, but the file is gone.` : raw)
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
  if (query === undefined || query.trim().length === 0) throw new UsageError('Usage: inkwell note search "<text>" [--project X] [--section H2]')
  const project = selectedProject(ctx, args)
  const section = readString(args, 'section')
  const limit = boundedInteger(args, 'limit', DEFAULT_SEARCH_LIMIT)
  const offset = boundedInteger(args, 'offset', 0)

  const candidates = listNotes(ctx.db, project ? project.filter : {})
  const result = await scanFiles(ctx.docsRoot, candidates, (row) => row, query, searchScanOptions(args, section))
  const page = limit > 0 ? result.documents.slice(offset, offset + limit) : result.documents.slice(offset)
  const data = page.map((found) => {
    const row = found.candidate
    const day = localDay(row.startedAt, ctx.timezone)
    return {
      entryId: row.entryId,
      projectId: row.projectId,
      projectName: row.projectName,
      projectSlug: projectSlug(row.projectName),
      spaceId: row.spaceId,
      title: row.title,
      docTitle: row.title,
      localDay: day,
      month: day.slice(0, 7),
      relPath: row.relPath,
      path: found.file.path,
      matchCount: found.matchCount,
      matches: found.matches,
      byteSize: found.file.byteSize ?? row.byteSize,
      recordedAt: row.recordedAt,
      file: found.file,
    }
  })
  const meta = {
    root: ctx.docsRoot,
    timezone: ctx.timezone,
    query,
    caseSensitive: readBoolean(args, 'case-sensitive'),
    section: section ?? null,
    project: projectMeta(project),
    page: { limit, offset, returned: data.length, hasMore: limit > 0 && offset + data.length < result.documents.length },
    documentsWithMatches: result.documents.length,
    totalMatches: result.documents.reduce((sum, found) => sum + found.matchCount, 0),
    scanned: result.scanned,
    truncated: result.truncated,
    warnings: result.scanned.missing > 0 ? [`${result.scanned.missing} recorded note(s) are gone from disk.`] : [],
  }
  if (json) {
    writeJson(successEnvelope('note search', data, meta))
    return 0
  }
  if (data.length === 0) writeOut(`Nothing matches "${query}".`)
  for (const found of data) {
    writeOut(`${found.localDay}  #${found.entryId}  ${found.matchCount}x  ${found.relPath}`)
    for (const match of found.matches) writeOut(`    ${match.snippet.replace(/\n/g, ' ')}`)
  }
  return 0
}
