import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../db/open.ts'
import { resolveTimezone } from '../db/settings.ts'
import { databasePath, docsRoot } from '../paths.ts'
import { readString, type ParsedArgs } from './args.ts'

export interface LocalContext {
  db: DatabaseSync
  timezone: string
  now: Date
  databasePath: string
  docsRoot: string
}

export function createLocalContext(args: ParsedArgs): LocalContext {
  const path = readString(args, 'db-path') ?? databasePath()
  const db = openDatabase(path)
  return {
    db,
    timezone: resolveTimezone(db, readString(args, 'timezone')),
    now: new Date(),
    databasePath: path,
    docsRoot: readString(args, 'docs-dir') ?? docsRoot(process.env, path, readString(args, 'db-path') !== undefined),
  }
}

export async function withLocalContext<T>(args: ParsedArgs, run: (ctx: LocalContext) => Promise<T> | T): Promise<T> {
  const ctx = createLocalContext(args)
  try {
    return await run(ctx)
  } finally {
    ctx.db.close()
  }
}
