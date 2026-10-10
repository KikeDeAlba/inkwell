import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { entryRef } from './page-links.ts'
import { queryAll, queryOne } from './query.ts'

export type NoteKind = 'note' | 'appendix'

export interface EntryNoteRow {
  ref: string
  entryId: number
  relPath: string
  kind: NoteKind
  spaceId: number | null
  title: string
  titleSlug: string
  source: string
  sectionCount: number
  byteSize: number
  checksum: string
  repoSlug: string | null
  branch: string | null
  headSha: string | null
  projectId: number | null
  projectName: string | null
  entryKind: string | null
  startedAt: string
  stoppedAt: string | null
  issueKey: string | null
  createdAt: string
  recordedAt: string
}

interface RawNote {
  ref: string
  entry_id: number
  rel_path: string
  kind: NoteKind
  space_id: number | null
  title: string
  title_slug: string
  source: string
  section_count: number
  byte_size: number
  checksum: string
  repo_slug: string | null
  branch: string | null
  head_sha: string | null
  project_id: number | null
  project_name: string | null
  entry_kind: string | null
  started_at: string
  stopped_at: string | null
  issue_key: string | null
  created_at: string
  recorded_at: string
}

export interface NewEntryNote {
  entryId: number
  relPath: string
  kind?: NoteKind
  spaceId: number | null
  title: string
  titleSlug: string
  source: string
  sectionCount: number
  byteSize: number
  checksum: string
  repoSlug?: string | null
  branch?: string | null
  headSha?: string | null
  projectId: number | null
  projectName: string | null
  entryKind: string | null
  startedAt: string
  stoppedAt: string | null
  issueKey: string | null
  createdAt?: string
  now: string
}

function toRow(raw: RawNote): EntryNoteRow {
  return {
    ref: raw.ref,
    entryId: raw.entry_id,
    relPath: raw.rel_path,
    kind: raw.kind,
    spaceId: raw.space_id,
    title: raw.title,
    titleSlug: raw.title_slug,
    source: raw.source,
    sectionCount: raw.section_count,
    byteSize: raw.byte_size,
    checksum: raw.checksum,
    repoSlug: raw.repo_slug,
    branch: raw.branch,
    headSha: raw.head_sha,
    projectId: raw.project_id,
    projectName: raw.project_name,
    entryKind: raw.entry_kind,
    startedAt: raw.started_at,
    stoppedAt: raw.stopped_at,
    issueKey: raw.issue_key,
    createdAt: raw.created_at,
    recordedAt: raw.recorded_at,
  }
}

export function upsertEntryNote(db: DatabaseSync, note: NewEntryNote): void {
  db.prepare(
    `INSERT INTO entry_notes (rel_path, ref, entry_id, kind, space_id, title, title_slug, source, section_count, byte_size, checksum,
                              repo_slug, branch, head_sha, project_id, project_name, entry_kind, started_at, stopped_at, issue_key, created_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (rel_path) DO UPDATE SET
       space_id = excluded.space_id,
       title = excluded.title,
       title_slug = excluded.title_slug,
       source = excluded.source,
       section_count = excluded.section_count,
       byte_size = excluded.byte_size,
       checksum = excluded.checksum,
       repo_slug = COALESCE(excluded.repo_slug, entry_notes.repo_slug),
       branch = COALESCE(excluded.branch, entry_notes.branch),
       head_sha = COALESCE(excluded.head_sha, entry_notes.head_sha),
       project_id = excluded.project_id,
       project_name = excluded.project_name,
       entry_kind = excluded.entry_kind,
       started_at = excluded.started_at,
       stopped_at = excluded.stopped_at,
       issue_key = excluded.issue_key,
       recorded_at = excluded.recorded_at`,
  ).run(
    note.relPath,
    entryRef(note.entryId),
    note.entryId,
    note.kind ?? 'note',
    note.spaceId,
    note.title,
    note.titleSlug,
    note.source,
    note.sectionCount,
    note.byteSize,
    note.checksum,
    note.repoSlug ?? null,
    note.branch ?? null,
    note.headSha ?? null,
    note.projectId,
    note.projectName,
    note.entryKind,
    note.startedAt,
    note.stoppedAt,
    note.issueKey,
    note.createdAt ?? note.now,
    note.now,
  )
}

export function findNoteForEntry(db: DatabaseSync, entryId: number, kind: NoteKind = 'note'): EntryNoteRow | undefined {
  const raw = queryOne<RawNote>(db.prepare('SELECT * FROM entry_notes WHERE entry_id = ? AND kind = ? ORDER BY rel_path LIMIT 1'), entryId, kind)
  return raw ? toRow(raw) : undefined
}

export function findNoteByRelPath(db: DatabaseSync, relPath: string): EntryNoteRow | undefined {
  const raw = queryOne<RawNote>(db.prepare('SELECT * FROM entry_notes WHERE rel_path = ?'), relPath)
  return raw ? toRow(raw) : undefined
}

export function listNotesForEntry(db: DatabaseSync, entryId: number): EntryNoteRow[] {
  return queryAll<RawNote>(db.prepare('SELECT * FROM entry_notes WHERE entry_id = ? ORDER BY kind DESC, rel_path'), entryId).map(toRow)
}

export function moveEntryNote(db: DatabaseSync, fromRelPath: string, toRelPath: string): boolean {
  const result = db.prepare('UPDATE entry_notes SET rel_path = ? WHERE rel_path = ?').run(toRelPath, fromRelPath)
  return Number(result.changes) > 0
}

export function reassignEntryNote(db: DatabaseSync, relPath: string, entryId: number): boolean {
  const result = db.prepare('UPDATE entry_notes SET entry_id = ?, ref = ? WHERE rel_path = ?').run(entryId, entryRef(entryId), relPath)
  return Number(result.changes) > 0
}

export function deleteEntryNote(db: DatabaseSync, relPath: string): boolean {
  const result = db.prepare('DELETE FROM entry_notes WHERE rel_path = ?').run(relPath)
  return Number(result.changes) > 0
}

export interface NoteFilter {
  projectId?: number | null
  spaceId?: number | null
  fromUtc?: string
  toUtc?: string
}

function where(filter: NoteFilter): { sql: string; params: SQLInputValue[] } {
  const clauses = ["kind = 'note'"]
  const params: SQLInputValue[] = []
  if (filter.projectId === null && filter.spaceId === undefined) clauses.push('project_id IS NULL')
  else if (filter.projectId !== undefined || filter.spaceId !== undefined) {
    const parts: string[] = []
    if (filter.projectId !== undefined) {
      if (filter.projectId === null) parts.push('project_id IS NULL')
      else {
        parts.push('project_id = ?')
        params.push(filter.projectId)
      }
    }
    if (filter.spaceId !== undefined) {
      if (filter.spaceId === null) parts.push('space_id IS NULL')
      else {
        parts.push('space_id = ?')
        params.push(filter.spaceId)
      }
    }
    clauses.push(`(${parts.join(' OR ')})`)
  }
  if (filter.fromUtc !== undefined) {
    clauses.push('started_at >= ?')
    params.push(filter.fromUtc)
  }
  if (filter.toUtc !== undefined) {
    clauses.push('started_at < ?')
    params.push(filter.toUtc)
  }
  return { sql: clauses.join(' AND '), params }
}

export function listNotes(db: DatabaseSync, filter: NoteFilter = {}): EntryNoteRow[] {
  const { sql, params } = where(filter)
  return queryAll<RawNote>(db.prepare(`SELECT * FROM entry_notes WHERE ${sql} ORDER BY started_at DESC, entry_id DESC`), ...params).map(toRow)
}

export function appendixCounts(db: DatabaseSync): Map<number, number> {
  const rows = queryAll<{ entry_id: number; total: number }>(db.prepare(`SELECT entry_id, COUNT(*) AS total FROM entry_notes WHERE kind = 'appendix' GROUP BY entry_id`))
  return new Map(rows.map((row) => [row.entry_id, row.total]))
}

export function countEntryNotes(db: DatabaseSync): number {
  return queryOne<{ total: number }>(db.prepare('SELECT COUNT(*) AS total FROM entry_notes'))?.total ?? 0
}
