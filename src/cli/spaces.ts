import type { DatabaseSync } from 'node:sqlite'
import { readSetting } from '../db/settings.ts'
import { findSpaceById, listSpaces, resolveSpaceArg } from '../db/spaces.ts'
import type { SpaceRow } from '../db/rows.ts'
import { normalizeSiteUrl } from '../confluence/refs.ts'

export const SITE_KEY = 'atlassian.site'
export const NO_SPACE_ARGS = new Set(['_no-project', '-', 'none'])

export function selectedSpace(db: DatabaseSync, raw: string | undefined): { id: number | null; name: string | null; space: SpaceRow | null } | null {
  if (raw === undefined) return null
  if (NO_SPACE_ARGS.has(raw)) return { id: null, name: null, space: null }
  const space = resolveSpaceArg(db, raw)
  return { id: space.id, name: space.name, space }
}

export function spaceIdArg(db: DatabaseSync, raw: string): number | null {
  if (NO_SPACE_ARGS.has(raw)) return null
  return resolveSpaceArg(db, raw).id
}

export function spaceNameOf(db: DatabaseSync, spaceId: number | null): string | null {
  if (spaceId === null) return null
  return findSpaceById(db, spaceId)?.name ?? null
}

export function spaceNames(db: DatabaseSync): Map<number, string> {
  return new Map(listSpaces(db).map((space) => [space.id, space.name]))
}

export function defaultSiteUrl(db: DatabaseSync): string | undefined {
  const stored = readSetting(db, SITE_KEY)
  return stored === undefined ? undefined : (normalizeSiteUrl(stored) ?? undefined)
}

export function siteUrlFor(db: DatabaseSync, spaceId: number | null): string | undefined {
  const space = spaceId === null ? undefined : findSpaceById(db, spaceId)
  const own = space?.atlassianSite ? normalizeSiteUrl(space.atlassianSite) : null
  return own ?? defaultSiteUrl(db)
}
