import type { DatabaseSync } from 'node:sqlite'
import { bitaProjectLookup } from '../integrations/bita-projects.ts'
import { ConflictError, NotFoundError, UsageError } from '../errors.ts'
import { queryAll, queryOne } from './query.ts'
import { fromBoolean, toBoolean, type ConfluenceKind, type SpaceRow } from './rows.ts'
import { SPACE_KEY_PATTERN, UNASSIGNED_KEY, ensureSpaceKey, takenSpaceKeys } from './space-keys.ts'

interface RawSpace {
  id: number
  name: string
  key: string | null
  external_ref: string | null
  client_name: string | null
  active: number
  created_at: string
  atlassian_site: string | null
  confluence_ref: string | null
  confluence_kind: ConfluenceKind | null
  sync_pull: number
  sync_push: number
  last_sync_at: string | null
}

function toSpace(raw: RawSpace): SpaceRow {
  return {
    id: raw.id,
    name: raw.name,
    key: raw.key,
    externalRef: raw.external_ref,
    clientName: raw.client_name,
    active: toBoolean(raw.active),
    createdAt: raw.created_at,
    atlassianSite: raw.atlassian_site,
    confluenceRef: raw.confluence_ref,
    confluenceKind: raw.confluence_kind,
    syncPull: toBoolean(raw.sync_pull),
    syncPush: toBoolean(raw.sync_push),
    lastSyncAt: raw.last_sync_at,
  }
}

export interface NewSpace {
  id?: number
  name: string
  key?: string | null
  externalRef?: string | null
  clientName?: string | null
  active?: boolean
  createdAt: string
}

export function insertSpace(db: DatabaseSync, space: NewSpace): SpaceRow {
  const name = space.name.trim()
  if (name.length === 0) throw new UsageError('A space needs a name.')
  if (findSpaceByName(db, name)) throw new ConflictError(`There is already a space named "${name}".`, 'SPACE_EXISTS')
  const key = space.key === undefined || space.key === null ? null : normalizeKey(db, space.key)
  const result = db
    .prepare(
      `INSERT INTO spaces (id, name, key, external_ref, client_name, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(space.id ?? null, name, key, space.externalRef ?? null, space.clientName ?? null, fromBoolean(space.active ?? true), space.createdAt)
  const id = Number(result.lastInsertRowid)
  ensureSpaceKey(db, id)
  return requireSpace(db, id)
}

function normalizeKey(db: DatabaseSync, raw: string, exceptId?: number): string {
  const key = raw.trim().toUpperCase()
  if (!SPACE_KEY_PATTERN.test(key) || key === UNASSIGNED_KEY) {
    throw new UsageError(`"${raw}" is not a valid space key: 2 to 6 letters or digits, starting with a letter, and not ${UNASSIGNED_KEY}.`)
  }
  const owner = findSpaceByKey(db, key)
  if (owner && owner.id !== exceptId) throw new ConflictError(`The key ${key} belongs to ${owner.name}.`, 'SPACE_KEY_TAKEN')
  return key
}

export function findSpaceById(db: DatabaseSync, id: number): SpaceRow | undefined {
  const raw = queryOne<RawSpace>(db.prepare('SELECT * FROM spaces WHERE id = ?'), id)
  return raw ? toSpace(raw) : undefined
}

export function requireSpace(db: DatabaseSync, id: number): SpaceRow {
  const space = findSpaceById(db, id)
  if (!space) throw new NotFoundError(`No space #${id}.`, 'SPACE_NOT_FOUND', 'Run "inkwell space ls" to see them.')
  return space
}

export function findSpaceByName(db: DatabaseSync, name: string): SpaceRow | undefined {
  const raw = queryOne<RawSpace>(db.prepare('SELECT * FROM spaces WHERE name = ? COLLATE NOCASE'), name.trim())
  return raw ? toSpace(raw) : undefined
}

export function findSpaceByKey(db: DatabaseSync, key: string): SpaceRow | undefined {
  const raw = queryOne<RawSpace>(db.prepare('SELECT * FROM spaces WHERE key = ? COLLATE NOCASE'), key.trim())
  return raw ? toSpace(raw) : undefined
}

export function findSpaceByExternalRef(db: DatabaseSync, ref: string): SpaceRow | undefined {
  const raw = queryOne<RawSpace>(db.prepare('SELECT * FROM spaces WHERE external_ref = ?'), ref)
  return raw ? toSpace(raw) : undefined
}

export function bitaProjectRef(projectId: number): string {
  return `bita:project:${projectId}`
}

export function findSpaceForBitaProject(db: DatabaseSync, projectId: number): SpaceRow | undefined {
  return findSpaceByExternalRef(db, bitaProjectRef(projectId))
}

export function listSpaces(db: DatabaseSync, includeInactive = true): SpaceRow[] {
  const sql = includeInactive
    ? 'SELECT * FROM spaces ORDER BY name COLLATE NOCASE'
    : 'SELECT * FROM spaces WHERE active = 1 ORDER BY name COLLATE NOCASE'
  return queryAll<RawSpace>(db.prepare(sql)).map(toSpace)
}

export function resolveSpaceArg(db: DatabaseSync, raw: string): SpaceRow {
  const trimmed = raw.trim()
  const asNumber = Number(trimmed)
  if (Number.isInteger(asNumber) && asNumber > 0) {
    const found = findSpaceById(db, asNumber) ?? findSpaceForBitaProject(db, asNumber) ?? adoptBitaProject(db, trimmed)
    if (found) return found
    throw new NotFoundError(`No space with id ${asNumber}.`, 'PROJECT_NOT_FOUND', 'Run "inkwell space ls" to see them.')
  }
  const found =
    findSpaceByName(db, trimmed) ??
    findSpaceByKey(db, trimmed) ??
    (trimmed.includes(':') ? findSpaceByExternalRef(db, trimmed) : undefined) ??
    adoptBitaProject(db, trimmed)
  if (found) return found
  throw new NotFoundError(`No space named or keyed "${raw}".`, 'PROJECT_NOT_FOUND', 'Run "inkwell space ls" to see them, or create it with "inkwell space add".')
}

export interface SpaceUpdate {
  name?: string
  key?: string
  clientName?: string | null
  active?: boolean
  externalRef?: string | null
  site?: string | null
  confluence?: { ref: string; kind: ConfluenceKind } | null
  syncPull?: boolean
  syncPush?: boolean
}

export function updateSpace(db: DatabaseSync, id: number, update: SpaceUpdate): SpaceRow {
  const space = requireSpace(db, id)
  const sets: string[] = []
  const values: (string | number | null)[] = []
  if (update.name !== undefined) {
    const name = update.name.trim()
    if (name.length === 0) throw new UsageError('A space needs a name.')
    const owner = findSpaceByName(db, name)
    if (owner && owner.id !== id) throw new ConflictError(`There is already a space named "${name}".`, 'SPACE_EXISTS')
    sets.push('name = ?')
    values.push(name)
  }
  if (update.key !== undefined) {
    sets.push('key = ?')
    values.push(normalizeKey(db, update.key, id))
  }
  if (update.clientName !== undefined) {
    sets.push('client_name = ?')
    values.push(update.clientName)
  }
  if (update.active !== undefined) {
    sets.push('active = ?')
    values.push(fromBoolean(update.active))
  }
  if (update.externalRef !== undefined) {
    sets.push('external_ref = ?')
    values.push(update.externalRef)
  }
  if (update.site !== undefined) {
    sets.push('atlassian_site = ?')
    values.push(update.site)
  }
  if (update.confluence !== undefined) {
    sets.push('confluence_ref = ?', 'confluence_kind = ?')
    values.push(update.confluence?.ref ?? null, update.confluence?.kind ?? null)
  }
  if (update.syncPull !== undefined) {
    sets.push('sync_pull = ?')
    values.push(fromBoolean(update.syncPull))
  }
  if (update.syncPush !== undefined) {
    sets.push('sync_push = ?')
    values.push(fromBoolean(update.syncPush))
  }
  if (sets.length === 0) return space
  db.prepare(`UPDATE spaces SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  return requireSpace(db, id)
}

export function setSpaceLastSync(db: DatabaseSync, id: number, at: string): void {
  db.prepare('UPDATE spaces SET last_sync_at = ? WHERE id = ?').run(at, id)
}

export { takenSpaceKeys }

export function adoptBitaProject(db: DatabaseSync, ref: string): SpaceRow | undefined {
  const project = bitaProjectLookup()(ref)
  if (!project) return undefined
  const linked = findSpaceForBitaProject(db, project.id)
  if (linked) return linked
  const sameName = findSpaceByName(db, project.name)
  if (sameName) return sameName.externalRef ? sameName : updateSpace(db, sameName.id, { externalRef: bitaProjectRef(project.id) })
  const keyFree = project.key !== null && !findSpaceByKey(db, project.key)
  const space = insertSpace(db, {
    name: project.name,
    ...(keyFree ? { key: project.key } : {}),
    externalRef: bitaProjectRef(project.id),
    clientName: project.clientName,
    active: project.active,
    createdAt: new Date().toISOString(),
  })
  return updateSpace(db, space.id, {
    ...(project.site ? { site: project.site } : {}),
    ...(project.confluence ? { confluence: project.confluence } : {}),
    syncPull: project.syncPull,
    syncPush: project.syncPush,
  })
}
