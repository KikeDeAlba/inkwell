import type { DatabaseSync } from 'node:sqlite'
import { queryAll, queryOne } from './query.ts'

export function autodocCursor(db: DatabaseSync, sessionId: string): number {
  const row = queryOne<{ lines: number }>(db.prepare('SELECT lines FROM autodoc_runs WHERE session_id = ?'), sessionId)
  return row?.lines ?? 0
}

export function advanceAutodocCursor(db: DatabaseSync, sessionId: string, lines: number, at: string): void {
  db.prepare(
    `INSERT INTO autodoc_runs (session_id, lines, at) VALUES (?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET lines = MAX(lines, excluded.lines), at = excluded.at`,
  ).run(sessionId, lines, at)
}

export function markAutodocPending(db: DatabaseSync, pageId: number, sessionId: string, at: string): void {
  db.prepare(
    `INSERT INTO autodoc_pending (page_id, session_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT (page_id) DO NOTHING`,
  ).run(pageId, sessionId, at)
}

export function clearAutodocPending(db: DatabaseSync, pageId: number): boolean {
  return Number(db.prepare('DELETE FROM autodoc_pending WHERE page_id = ?').run(pageId).changes) > 0
}

export function isAutodocPending(db: DatabaseSync, pageId: number): boolean {
  return queryOne<{ found: number }>(db.prepare('SELECT 1 AS found FROM autodoc_pending WHERE page_id = ?'), pageId) !== undefined
}

export interface PendingAutodocPage {
  pageId: number
  sessionId: string
  createdAt: string
}

export function pendingAutodocPages(db: DatabaseSync): PendingAutodocPage[] {
  return queryAll<{ page_id: number; session_id: string; created_at: string }>(
    db.prepare('SELECT page_id, session_id, created_at FROM autodoc_pending ORDER BY created_at, page_id'),
  ).map((row) => ({ pageId: row.page_id, sessionId: row.session_id, createdAt: row.created_at }))
}
