import type { DatabaseSync } from 'node:sqlite'
import { queryOne } from './query.ts'

export const TIMEZONE_KEY = 'timezone'

export function readSetting(db: DatabaseSync, key: string): string | undefined {
  const row = queryOne<{ value: string }>(db.prepare('SELECT value FROM settings WHERE key = ?'), key)
  return row?.value
}

export function writeSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(key, value)
}

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function resolveTimezone(db: DatabaseSync, override?: string): string {
  return override ?? readSetting(db, TIMEZONE_KEY) ?? systemTimezone()
}
