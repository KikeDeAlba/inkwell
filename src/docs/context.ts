import type { DatabaseSync } from 'node:sqlite'

export interface DocsContext {
  db: DatabaseSync
  docsRoot: string
  timezone: string
  now: Date
}
