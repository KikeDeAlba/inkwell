import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { findNoteByRelPath, findNoteForEntry, upsertEntryNote, type NoteKind } from '../db/entry-notes.ts'
import { inTransaction } from '../db/open.ts'
import { queryAll } from '../db/query.ts'
import { spaceForEntry } from '../docs/entry-note.ts'
import { commitDocs, prepareDocsRepo } from '../docs/git.ts'
import { checksumOf, filledSections, parseDocument } from '../docs/markdown.ts'
import { resolveDocPath } from '../docs/paths.ts'
import { titleSlug } from '../docs/slug.ts'
import { readRaw } from '../docs/store.ts'
import { NotFoundError } from '../errors.ts'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { columns, hasTable } from './bita-schema.ts'
import type { BitaLocation } from './from-bita.ts'

export const NOTES_IMPORT_SUBJECT = 'chore: import entry notes from bita'

export type NoteImportAction = 'import' | 'already' | 'missing' | 'conflict'

export interface NoteImportItem {
  entryId: number
  relPath: string
  kind: NoteKind
  action: NoteImportAction
  reason: string | null
}

export interface NotesImportReport {
  dryRun: boolean
  bitaDatabase: string
  bitaDocs: string
  docsRoot: string
  counts: { scanned: number; imported: number; already: number; missing: number; conflicts: number }
  commit: string | null
  items: NoteImportItem[]
}

interface BitaNote {
  entry_id: number
  rel_path: string
  kind: NoteKind
  title: string
  source: string
  repo_slug: string | null
  branch: string | null
  head_sha: string | null
  created_at: string
  recorded_at: string
  description: string | null
  entry_kind: string | null
  project_id: number | null
  project_name: string | null
  started_at: string | null
  stopped_at: string | null
  issue_key: string | null
}

export function readBitaNotes(path: string): BitaNote[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    if (!hasTable(db, 'entry_docs')) return []
    const docCols = columns(db, 'entry_docs')
    const entryCols = hasTable(db, 'entries') ? columns(db, 'entries') : new Set<string>()
    const hasEntries = entryCols.size > 0
    const hasProjects = hasEntries && hasTable(db, 'projects')
    const hasJira = hasEntries && hasTable(db, 'jira_links')
    const col = (name: string, fallback: string) => (docCols.has(name) ? `d.${name}` : fallback)
    return queryAll<BitaNote>(
      db.prepare(
        `SELECT d.entry_id, d.rel_path, ${col('kind', `'note'`)} AS kind, ${col('title', `''`)} AS title, ${col('source', `'import'`)} AS source,
                ${col('repo_slug', 'NULL')} AS repo_slug, ${col('branch', 'NULL')} AS branch, ${col('head_sha', 'NULL')} AS head_sha,
                d.created_at, d.recorded_at,
                ${hasEntries ? 'e.description' : 'NULL'} AS description,
                ${entryCols.has('kind') ? 'e.kind' : 'NULL'} AS entry_kind,
                ${hasEntries ? 'e.project_id' : 'NULL'} AS project_id,
                ${hasProjects ? 'p.name' : 'NULL'} AS project_name,
                ${hasEntries ? 'e.started_at' : 'NULL'} AS started_at,
                ${hasEntries ? 'e.stopped_at' : 'NULL'} AS stopped_at,
                ${hasJira ? '(SELECT j.issue_key FROM jira_links j WHERE j.entry_id = d.entry_id AND j.issue_key IS NOT NULL LIMIT 1)' : 'NULL'} AS issue_key
         FROM entry_docs d
         ${hasEntries ? 'LEFT JOIN entries e ON e.id = d.entry_id' : ''}
         ${hasProjects ? 'LEFT JOIN projects p ON p.id = e.project_id' : ''}
         ORDER BY d.entry_id, ${docCols.has('kind') ? `CASE d.kind WHEN 'note' THEN 0 ELSE 1 END,` : ''} d.rel_path`,
      ),
    )
  } finally {
    db.close()
  }
}

export interface ImportNotesOptions {
  dryRun: boolean
  location: BitaLocation
  docsRoot: string
  now: Date
}

interface Planned {
  note: BitaNote
  raw: string
  write: boolean
}

export async function importNotesFromBita(db: DatabaseSync, options: ImportNotesOptions): Promise<NotesImportReport> {
  const { location, docsRoot } = options
  if (!existsSync(location.database)) {
    throw new NotFoundError(`There is no bita database at ${location.database}.`, 'BITA_DB_NOT_FOUND', 'Pass --bita-db <path> or set BITA_DB_PATH.')
  }
  const notes = readBitaNotes(location.database)
  const items: NoteImportItem[] = []
  const planned: Planned[] = []
  const seenPrimary = new Set<number>()

  for (const note of notes) {
    const item = (action: NoteImportAction, reason: string | null = null) => items.push({ entryId: note.entry_id, relPath: note.rel_path, kind: note.kind, action, reason })
    const stored = findNoteByRelPath(db, note.rel_path)
    if (stored && stored.entryId === note.entry_id) {
      item('already')
      if (note.kind === 'note') seenPrimary.add(note.entry_id)
      continue
    }
    if (stored) {
      item('conflict', `inkwell already has the note of entry #${stored.entryId} at this path`)
      continue
    }
    if (!/^[^/\\]/.test(note.rel_path) || note.rel_path.includes('..') || !note.rel_path.endsWith('.md')) {
      item('conflict', 'the path is not a valid note path')
      continue
    }
    if (note.kind === 'note' && (seenPrimary.has(note.entry_id) || findNoteForEntry(db, note.entry_id))) {
      item('already', 'inkwell already has a note for this entry')
      continue
    }
    let source: string | null
    let target: string | null
    try {
      source = await readRaw(resolveDocPath(location.docs, note.rel_path))
      target = await readRaw(resolveDocPath(docsRoot, note.rel_path))
    } catch (error) {
      item('conflict', error instanceof Error ? error.message : String(error))
      continue
    }
    if (source === null) {
      item('missing', 'the file is gone from the bita docs')
      continue
    }
    if (target !== null && target !== source) {
      item('conflict', 'a different file already sits at this path in inkwell')
      continue
    }
    if (note.kind === 'note') seenPrimary.add(note.entry_id)
    planned.push({ note, raw: source, write: target === null })
    item('import')
  }

  const counts = {
    scanned: notes.length,
    imported: items.filter((item) => item.action === 'import').length,
    already: items.filter((item) => item.action === 'already').length,
    missing: items.filter((item) => item.action === 'missing').length,
    conflicts: items.filter((item) => item.action === 'conflict').length,
  }
  const base = { bitaDatabase: location.database, bitaDocs: location.docs, docsRoot, counts, items }
  if (options.dryRun || planned.length === 0) return { ...base, dryRun: options.dryRun, commit: null }

  await prepareDocsRepo(docsRoot)
  const written: string[] = []
  const undo = async () => {
    for (const path of written) await rm(path, { force: true }).catch(() => undefined)
  }
  try {
    for (const plan of planned) {
      if (!plan.write) continue
      const path = resolveDocPath(docsRoot, plan.note.rel_path)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, plan.raw, { encoding: 'utf8', mode: 0o600 })
      written.push(path)
    }
  } catch (error) {
    await undo()
    throw error
  }

  const at = options.now.toISOString()
  try {
    inTransaction(db, () => {
      for (const { note, raw } of planned) {
        const space = spaceForEntry(db, { projectId: note.project_id, projectName: note.project_name }, false)
        const title = note.description ?? note.title
        upsertEntryNote(db, {
          entryId: note.entry_id,
          relPath: note.rel_path,
          kind: note.kind,
          spaceId: space?.id ?? null,
          title,
          titleSlug: titleSlug(title),
          source: note.source,
          sectionCount: filledSections(parseDocument(raw)).length,
          byteSize: Buffer.byteLength(raw),
          checksum: checksumOf(raw),
          repoSlug: note.repo_slug,
          branch: note.branch,
          headSha: note.head_sha,
          projectId: note.project_id,
          projectName: note.project_name,
          entryKind: note.entry_kind,
          startedAt: note.started_at ?? note.created_at,
          stoppedAt: note.started_at === null ? note.recorded_at : note.stopped_at,
          issueKey: note.issue_key,
          createdAt: note.created_at,
          now: note.recorded_at || at,
        })
      }
    })
  } catch (error) {
    await undo()
    throw error
  }

  const commit = await commitDocs(
    docsRoot,
    planned.map((plan) => plan.note.rel_path),
    { source: 'import', subject: NOTES_IMPORT_SUBJECT, reason: 'bita migration' },
  )
  return { ...base, dryRun: false, commit }
}
