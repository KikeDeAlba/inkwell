import type { DatabaseSync } from 'node:sqlite'
import { queryOne } from '../db/query.ts'

export function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]
  return new Set(rows.map((row) => row.name))
}

export function hasTable(db: DatabaseSync, table: string): boolean {
  return queryOne<{ name: string }>(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`), table) !== undefined
}
