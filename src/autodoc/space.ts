import type { DatabaseSync } from 'node:sqlite'
import { queryAll } from '../db/query.ts'
import type { SpaceRow } from '../db/rows.ts'
import { findSpaceById, linkedSpaceFor } from '../db/spaces.ts'
import { currentRepoIdentity } from '../docs/entry-note.ts'
import { cliBitaRepoLookup, type BitaRepoLookup } from '../integrations/bita-projects.ts'

export interface ResolvedSpace {
  space: SpaceRow | null
  repoSlug: string | null
  via: 'bita' | 'repo' | null
}

export function spaceForRepoSlug(db: DatabaseSync, slug: string): SpaceRow | null {
  const rows = queryAll<{ space_id: number | null }>(db.prepare('SELECT DISTINCT space_id FROM pages WHERE repo_slug = ?'), slug)
  if (rows.length !== 1) return null
  const id = rows[0]?.space_id
  return id === null || id === undefined ? null : (findSpaceById(db, id) ?? null)
}

export async function resolveSessionSpace(db: DatabaseSync, cwd: string, lookup: BitaRepoLookup = cliBitaRepoLookup): Promise<ResolvedSpace> {
  const mapped = lookup(cwd)
  const identity = await currentRepoIdentity(cwd).catch(() => null)
  const repoSlug = identity?.slug ?? (mapped?.slug || null)
  if (mapped !== null) {
    const space = linkedSpaceFor(db, mapped.projectId, mapped.projectName, false)
    if (space !== undefined) return { space, repoSlug, via: 'bita' }
  }
  if (repoSlug !== null) {
    const space = spaceForRepoSlug(db, repoSlug)
    if (space !== null) return { space, repoSlug, via: 'repo' }
  }
  return { space: null, repoSlug, via: null }
}
