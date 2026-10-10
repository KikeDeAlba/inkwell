import { readdir, rmdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DOC_SCHEMA_VERSION, ENTRY_NOTE_SECTIONS, ENTRY_NOTE_SECTIONS_REQUIRED } from '../config/constants.ts'
import {
  deleteEntryNote,
  findNoteForEntry,
  listNotesForEntry,
  moveEntryNote,
  reassignEntryNote,
  upsertEntryNote,
  type EntryNoteRow,
} from '../db/entry-notes.ts'
import { bitaProjectRef, adoptBitaProject, findSpaceById, findSpaceByName, findSpaceForBitaProject, insertSpace, updateSpace } from '../db/spaces.ts'
import type { SpaceRow } from '../db/rows.ts'
import { formatDuration } from '../domain/duration.ts'
import { localDay } from '../domain/timezone.ts'
import { entryDuration, type BitaEntry } from '../integrations/bita.ts'
import type { DocsContext } from './context.ts'
import { commitDocs, docsSubject, prepareDocsRepo } from './git.ts'
import { execGit } from './git-exec.ts'
import { noteRelPath } from './layout.ts'
import { emptyDocument, parseDocument, stampFrontMatter, upsertSection, type ParsedDocument } from './markdown.ts'
import { resolveDocPath } from './paths.ts'
import { titleSlug } from './slug.ts'
import { readRaw, removeDocument, renameDocument, withDocLock, writeDocument } from './store.ts'

export interface RepoIdentity {
  slug: string
  branch?: string | undefined
  headSha?: string | undefined
}

export interface RecordedNote {
  entryId: number
  relPath: string
  path: string
  title: string
  created: boolean
  changed: boolean
  renamedFrom: string | null
  sectionCount: number
  byteSize: number
  checksum: string
  frontMatterValid: boolean
}

export interface RecordNoteOptions {
  source: string
  identity?: RepoIdentity | null
  create?: boolean
  section?: { heading: string; body: string } | undefined
  sections?: readonly { heading: string; body: string }[] | undefined
  preamble?: string | undefined
  commit?: false | { reason?: string | null; action?: string } | undefined
}

export function entryFromNote(row: EntryNoteRow): BitaEntry {
  return {
    id: row.entryId,
    description: row.title,
    kind: row.entryKind,
    projectId: row.projectId,
    projectName: row.projectName,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt,
    note: null,
    issueKey: row.issueKey,
    durationSeconds: null,
  }
}

export function peekSpaceForEntry(db: DatabaseSync, entry: Pick<BitaEntry, 'projectId' | 'projectName'>): SpaceRow | null {
  if (entry.projectId === null) return null
  const linked = findSpaceForBitaProject(db, entry.projectId)
  if (linked) return linked
  if (entry.projectName === null) return null
  const sameName = findSpaceByName(db, entry.projectName)
  return sameName && sameName.externalRef === null ? sameName : null
}

export function spaceForEntry(db: DatabaseSync, entry: Pick<BitaEntry, 'projectId' | 'projectName'>, adopt = true): SpaceRow | null {
  if (entry.projectId === null) return null
  const linked = findSpaceForBitaProject(db, entry.projectId)
  if (linked) return linked
  const adopted = adopt ? adoptBitaProject(db, String(entry.projectId)) : undefined
  if (adopted && (adopted.externalRef === null || adopted.externalRef === bitaProjectRef(entry.projectId))) return adopted
  if (entry.projectName === null) return null
  const sameName = findSpaceByName(db, entry.projectName)
  if (sameName && sameName.externalRef === null) return updateSpace(db, sameName.id, { externalRef: bitaProjectRef(entry.projectId) })
  const name = sameName ? `${entry.projectName} (${entry.projectId})` : entry.projectName
  return findSpaceByName(db, name) ?? insertSpace(db, { name, externalRef: bitaProjectRef(entry.projectId), createdAt: new Date().toISOString() })
}

function folderName(db: DatabaseSync, entry: BitaEntry, spaceId: number | null | undefined): string | null {
  if (spaceId !== null && spaceId !== undefined) return findSpaceById(db, spaceId)?.name ?? entry.projectName
  return entry.projectName
}

export function plannedNotePath(ctx: DocsContext, entry: BitaEntry, spaceId?: number | null): string {
  return noteRelPath({
    entryId: entry.id,
    startedAt: entry.startedAt,
    timezone: ctx.timezone,
    spaceName: folderName(ctx.db, entry, spaceId),
    description: entry.description,
  })
}

function durationOf(entry: BitaEntry): string {
  if (entry.stoppedAt === null) return ''
  return formatDuration(entryDuration(entry))
}

function ownedFrontMatter(entry: BitaEntry, timezone: string, identity: RepoIdentity | null, previous: Map<string, string>): Record<string, string> {
  return {
    inkwell: String(DOC_SCHEMA_VERSION),
    entryId: String(entry.id),
    title: entry.description,
    project: entry.projectName ?? '',
    day: localDay(entry.startedAt, timezone),
    startedAt: entry.startedAt,
    endedAt: entry.stoppedAt ?? '',
    duration: durationOf(entry),
    repo: identity?.slug ?? previous.get('repo') ?? '',
    branch: identity?.branch ?? previous.get('branch') ?? '',
    jira: entry.issueKey ?? previous.get('jira') ?? '',
    kind: entry.kind ?? '',
  }
}

function withoutLegacyKeys(doc: ParsedDocument): ParsedDocument {
  if (!doc.frontMatter.has('bita')) return doc
  const frontMatter = new Map(doc.frontMatter)
  frontMatter.delete('bita')
  return { ...doc, frontMatter }
}

export async function pruneEmptyDirs(root: string, dir: string): Promise<void> {
  const base = resolve(root)
  let current = resolve(dir)
  while (current !== base && current.startsWith(base)) {
    try {
      if ((await readdir(current)).length > 0) return
      await rmdir(current)
    } catch {
      return
    }
    current = dirname(current)
  }
}

async function place(ctx: DocsContext, stored: EntryNoteRow | undefined, wanted: string): Promise<{ relPath: string; renamedFrom: string | null }> {
  if (!stored || stored.relPath === wanted) return { relPath: stored?.relPath ?? wanted, renamedFrom: null }
  const from = resolveDocPath(ctx.docsRoot, stored.relPath)
  const to = resolveDocPath(ctx.docsRoot, wanted)
  if ((await readRaw(to)) !== null) return { relPath: stored.relPath, renamedFrom: null }
  if ((await readRaw(from)) === null) {
    moveEntryNote(ctx.db, stored.relPath, wanted)
    return { relPath: wanted, renamedFrom: stored.relPath }
  }
  if (!(await renameDocument(from, to))) return { relPath: stored.relPath, renamedFrom: null }
  moveEntryNote(ctx.db, stored.relPath, wanted)
  await pruneEmptyDirs(ctx.docsRoot, dirname(from))
  return { relPath: wanted, renamedFrom: stored.relPath }
}

export async function recordEntryNote(ctx: DocsContext, entry: BitaEntry, options: RecordNoteOptions): Promise<RecordedNote | null> {
  const identity = options.identity ?? null
  const stored = findNoteForEntry(ctx.db, entry.id)
  const sections = [...(options.sections ?? []), ...(options.section ? [options.section] : [])]
  if (!stored && options.create !== true && sections.length === 0) return null

  const space = spaceForEntry(ctx.db, entry)
  const wanted = plannedNotePath(ctx, entry, space?.id ?? null)
  await prepareDocsRepo(ctx.docsRoot)

  return withDocLock(resolveDocPath(ctx.docsRoot, wanted), async () => {
    const current = findNoteForEntry(ctx.db, entry.id)
    const currentRaw = current ? await readRaw(resolveDocPath(ctx.docsRoot, current.relPath)) : null
    if (currentRaw === null && options.create !== true && sections.length === 0) return null
    const placement = await place(ctx, current, wanted)
    const absolutePath = resolveDocPath(ctx.docsRoot, placement.relPath)
    const raw = await readRaw(absolutePath)

    let doc: ParsedDocument = raw === null ? emptyDocument(new Map(), entry.description || '(sin título)', ENTRY_NOTE_SECTIONS_REQUIRED) : parseDocument(raw)
    for (const section of sections) doc = upsertSection(doc, section.heading, section.body, ENTRY_NOTE_SECTIONS).doc
    if (options.preamble !== undefined && options.preamble.trim().length > 0) doc = { ...doc, preamble: mergeBodies(doc.preamble, options.preamble) }

    if (doc.frontMatterValid || raw === null) {
      doc = stampFrontMatter(withoutLegacyKeys(doc), ownedFrontMatter(entry, ctx.timezone, identity, doc.frontMatter))
      if (entry.description.length > 0 && doc.title !== entry.description) doc = { ...doc, title: entry.description }
    }

    const written = await writeDocument(absolutePath, doc)
    const now = ctx.now.toISOString()
    upsertEntryNote(ctx.db, {
      entryId: entry.id,
      relPath: placement.relPath,
      spaceId: space?.id ?? null,
      title: entry.description,
      titleSlug: titleSlug(entry.description),
      source: options.source,
      sectionCount: written.sectionCount,
      byteSize: written.byteSize,
      checksum: written.checksum,
      repoSlug: identity?.slug ?? null,
      branch: identity?.branch ?? null,
      headSha: identity?.headSha ?? null,
      projectId: entry.projectId,
      projectName: entry.projectName,
      entryKind: entry.kind,
      startedAt: entry.startedAt,
      stoppedAt: entry.stoppedAt,
      issueKey: entry.issueKey,
      now,
    })

    if (options.commit !== false && (written.changed || placement.renamedFrom !== null)) {
      const action = options.commit?.action ?? (written.created ? 'create note' : placement.renamedFrom !== null ? 'move note' : 'update note')
      await commitDocs(ctx.docsRoot, [placement.relPath, ...(placement.renamedFrom !== null ? [placement.renamedFrom] : [])], {
        source: 'note',
        subject: docsSubject(placement.relPath, action, entry.description || `#${entry.id}`),
        entryId: entry.id,
        reason: options.commit?.reason ?? null,
      })
    }

    return {
      entryId: entry.id,
      relPath: placement.relPath,
      path: absolutePath,
      title: entry.description,
      created: written.created,
      changed: written.changed,
      renamedFrom: placement.renamedFrom,
      sectionCount: written.sectionCount,
      byteSize: written.byteSize,
      checksum: written.checksum,
      frontMatterValid: doc.frontMatterValid || raw === null,
    }
  })
}

export function notePathFor(ctx: DocsContext, entry: BitaEntry): { relPath: string; path: string } {
  const stored = findNoteForEntry(ctx.db, entry.id)
  const relPath = stored?.relPath ?? plannedNotePath(ctx, entry, peekSpaceForEntry(ctx.db, entry)?.id ?? null)
  return { relPath, path: resolveDocPath(ctx.docsRoot, relPath) }
}

export async function readNoteFile(ctx: DocsContext, row: EntryNoteRow): Promise<{ path: string; markdown: string | null }> {
  const path = resolveDocPath(ctx.docsRoot, row.relPath)
  return { path, markdown: await readRaw(path) }
}

async function dropFiles(ctx: DocsContext, rows: readonly EntryNoteRow[]): Promise<string[]> {
  const removed: string[] = []
  for (const row of rows) {
    const path = resolveDocPath(ctx.docsRoot, row.relPath)
    await removeDocument(path)
    await pruneEmptyDirs(ctx.docsRoot, dirname(path))
    deleteEntryNote(ctx.db, row.relPath)
    removed.push(row.relPath)
  }
  return removed
}

export async function removeEntryNotes(ctx: DocsContext, entryId: number, reason: string): Promise<string[]> {
  const rows = listNotesForEntry(ctx.db, entryId)
  if (rows.length === 0) return []
  const removed = await dropFiles(ctx, rows)
  const title = rows.find((row) => row.kind === 'note')?.title || `#${entryId}`
  await commitDocs(ctx.docsRoot, removed, {
    source: 'note',
    subject: docsSubject(removed[0] ?? '', 'remove note', title),
    entryId,
    reason,
  })
  return removed
}

function mergeBodies(current: string, incoming: string): string {
  const a = current.trim()
  const b = incoming.trim()
  if (a.length === 0) return b
  if (b.length === 0 || a.includes(b)) return a
  return `${a}\n\n${b}`
}

export interface MergedNotes {
  target: RecordedNote | null
  absorbed: string[]
}

export async function mergeEntryNotes(ctx: DocsContext, sources: readonly number[], target: BitaEntry): Promise<MergedNotes> {
  const sourceRows = sources.flatMap((id) => listNotesForEntry(ctx.db, id))
  const notes = sourceRows.filter((row) => row.kind === 'note')
  const appendices = sourceRows.filter((row) => row.kind === 'appendix')
  if (sourceRows.length === 0) return { target: null, absorbed: [] }

  const stored = findNoteForEntry(ctx.db, target.id)
  const existing = stored ? parseDocument((await readRaw(resolveDocPath(ctx.docsRoot, stored.relPath))) ?? '') : null
  const bodies = new Map<string, string>()
  for (const section of existing?.sections ?? []) bodies.set(section.heading.normalize('NFC'), section.body)
  const order: string[] = (existing?.sections ?? []).map((section) => section.heading.normalize('NFC'))
  let preamble = ''
  for (const row of notes) {
    const raw = await readRaw(resolveDocPath(ctx.docsRoot, row.relPath))
    if (raw === null) continue
    const parsed = parseDocument(raw)
    preamble = mergeBodies(preamble, parsed.preamble)
    for (const section of parsed.sections) {
      const heading = section.heading.normalize('NFC')
      if (section.body.trim().length === 0 && bodies.has(heading)) continue
      if (!bodies.has(heading)) order.push(heading)
      bodies.set(heading, mergeBodies(bodies.get(heading) ?? '', section.body))
    }
  }
  const sections = order.map((heading) => ({ heading, body: bodies.get(heading) ?? '' }))

  const recorded = await recordEntryNote(ctx, target, { source: 'merge', create: true, sections, preamble, commit: false })
  for (const appendix of appendices) reassignEntryNote(ctx.db, appendix.relPath, target.id)
  const absorbed = await dropFiles(ctx, notes)
  const paths = [...absorbed, ...(recorded ? [recorded.relPath, ...(recorded.renamedFrom ? [recorded.renamedFrom] : [])] : [])]
  await commitDocs(ctx.docsRoot, paths, {
    source: 'note',
    subject: docsSubject(recorded?.relPath ?? paths[0] ?? '', 'merge notes into', target.description || `#${target.id}`),
    entryId: target.id,
    reason: `merged ${sources.map((id) => `#${id}`).join(', ')}`,
  })
  return { target: recorded, absorbed }
}

function repoSlugFromRemote(url: string): string | null {
  const cleaned = url.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  const match = /[:/]([^/:]+\/[^/]+)$/.exec(cleaned)
  return match?.[1] ?? null
}

export async function currentRepoIdentity(cwd: string = process.cwd()): Promise<RepoIdentity | null> {
  const top = await execGit(['rev-parse', '--show-toplevel'], { cwd })
  if (top.code !== 0) return null
  const toplevel = top.stdout.trim()
  const [remote, branch, head] = await Promise.all([
    execGit(['config', '--get', 'remote.origin.url'], { cwd }),
    execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }),
    execGit(['rev-parse', 'HEAD'], { cwd }),
  ])
  const slug = (remote.code === 0 ? repoSlugFromRemote(remote.stdout) : null) ?? basename(toplevel)
  const branchName = branch.code === 0 ? branch.stdout.trim() : ''
  const sha = head.code === 0 ? head.stdout.trim() : ''
  return {
    slug,
    ...(branchName.length > 0 && branchName !== 'HEAD' ? { branch: branchName } : {}),
    ...(sha.length > 0 ? { headSha: sha } : {}),
  }
}
