import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inTransaction } from '../db/open.ts'
import { queryAll, queryOne } from '../db/query.ts'
import { readSetting, writeSetting, TIMEZONE_KEY } from '../db/settings.ts'
import { bitaProjectRef, findSpaceByExternalRef, findSpaceById, findSpaceByKey, findSpaceByName } from '../db/spaces.ts'
import { SPACE_KEY_PATTERN, UNASSIGNED_KEY, ensureSpaceKey } from '../db/space-keys.ts'
import { entryRef, issueRef } from '../db/page-links.ts'
import { normalizeSiteUrl } from '../confluence/refs.ts'
import { withEventBatch } from '../docs/events.ts'
import { commitPaths, isDocsRepo, initDocsRepo, gitAvailable } from '../docs/git.ts'
import { execGit } from '../docs/git-exec.ts'
import { resolveDocPath } from '../docs/paths.ts'
import { ConflictError, NotFoundError } from '../errors.ts'
import { importNotesFromBita, type NotesImportReport } from './notes-from-bita.ts'
import { columns, hasTable } from './bita-schema.ts'
import { SITE_KEY } from '../cli/spaces.ts'

export const MIGRATED_AT_KEY = 'migration.bita.at'
export const MIGRATED_FROM_KEY = 'migration.bita.database'
export const MIGRATION_COMMIT_SUBJECT = 'chore: move docs from bita'

export interface BitaLocation {
  database: string
  docs: string
  config: string
}

export function bitaLocation(env: NodeJS.ProcessEnv = process.env, overrides: { database?: string | undefined; docs?: string | undefined } = {}): BitaLocation {
  const home = env['HOME'] ?? env['USERPROFILE'] ?? homedir()
  const database = overrides.database ?? env['BITA_DB_PATH'] ?? join(env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'bita', 'bita.db')
  const docs = overrides.docs ?? env['BITA_DOCS_DIR'] ?? join(dirname(database), 'docs')
  const config = env['BITA_CONFIG_PATH'] ?? join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'bita', 'config.json')
  return { database: resolve(database), docs: resolve(docs), config }
}

export interface MigrationCounts {
  spaces: number
  spacesReused: number
  pages: number
  entryLinks: number
  issueLinks: number
  refs: number
  backlog: number
  confluenceMaps: number
  noteFiles: number
}

export interface MigrationReport {
  dryRun: boolean
  alreadyMigrated: boolean
  bitaDatabase: string
  bitaDocs: string
  docsRoot: string
  counts: MigrationCounts
  docs: { source: 'git' | 'files' | 'none'; commit: string | null }
  notes: NotesImportReport | null
  notesError?: string
  migratedAt: string | null
}

export interface MigrationStatus {
  migrated: boolean
  bitaDatabase: string | null
  migratedAt: string | null
}

export function migrationStatus(db: DatabaseSync): MigrationStatus {
  const at = readSetting(db, MIGRATED_AT_KEY) ?? null
  return { migrated: at !== null, bitaDatabase: readSetting(db, MIGRATED_FROM_KEY) ?? null, migratedAt: at }
}


function pick(cols: Set<string>, name: string, fallback: string): string {
  return cols.has(name) ? name : `${fallback} AS ${name}`
}

interface BitaProject {
  id: number
  name: string
  key: string | null
  client_name: string | null
  active: number
  created_at: string
  atlassian_site: string | null
  confluence_ref: string | null
  confluence_kind: 'space' | 'page' | null
  sync_pull: number
  sync_push: number
  last_sync_at: string | null
}

interface BitaPage {
  id: number
  project_id: number | null
  parent_id: number | null
  slug: string
  title: string
  rel_path: string
  depth: number
  position: number
  status: string
  source: string
  section_count: number
  heading_count: number
  byte_size: number
  checksum: string
  repo_slug: string | null
  branch: string | null
  head_sha: string | null
  created_at: string
  recorded_at: string
}

interface BitaEntryLink {
  page_id: number
  entry_id: number
  summary: string
  linked_at: string
  description: string
  kind: string | null
  started_at: string
  stopped_at: string | null
}

interface BitaIssueLink {
  page_id: number
  issue_key: string
  role: string
  summary: string
  status: string
  status_category: string
  url: string | null
  created_at: string
  refreshed_at: string | null
}

interface BitaRef {
  page_id: number
  url: string
  title: string
  kind: string
  source: string
  first_seen_at: string
  last_seen_at: string
}

interface BitaBacklog {
  id: number
  project_id: number | null
  seq: number | null
  page_id: number | null
  entry_id: number | null
  kind: string
  title: string
  body: string
  status: string
  resolution: string
  source: string
  created_at: string
  updated_at: string
  resolved_at: string | null
}

interface BitaMap {
  page_id: number
  site: string
  confluence_id: string
  confluence_version: number
  local_checksum: string
  state: string
  synced_at: string
}

interface BitaSnapshot {
  projects: BitaProject[]
  pages: BitaPage[]
  entryLinks: (BitaEntryLink & { durationSeconds: number | null; worklogIssues: string[] })[]
  issueLinks: BitaIssueLink[]
  refs: BitaRef[]
  backlog: BitaBacklog[]
  maps: BitaMap[]
  noteFiles: string[]
  timezone: string | null
}

function readBita(path: string): BitaSnapshot {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const projectCols = columns(db, 'projects')
    const projects = hasTable(db, 'projects')
      ? queryAll<BitaProject>(
          db.prepare(
            `SELECT id, name, ${pick(projectCols, 'key', 'NULL')}, ${pick(projectCols, 'client_name', 'NULL')}, ${pick(projectCols, 'active', '1')}, created_at,
                    ${pick(projectCols, 'atlassian_site', 'NULL')}, ${pick(projectCols, 'confluence_ref', 'NULL')}, ${pick(projectCols, 'confluence_kind', 'NULL')},
                    ${pick(projectCols, 'sync_pull', '0')}, ${pick(projectCols, 'sync_push', '0')}, ${pick(projectCols, 'last_sync_at', 'NULL')}
             FROM projects ORDER BY id`,
          ),
        )
      : []

    const pages = hasTable(db, 'doc_pages') ? queryAll<BitaPage>(db.prepare('SELECT * FROM doc_pages ORDER BY depth, id')) : []

    const entryCols = columns(db, 'entries')
    const merged = entryCols.has('merged_into')
    const entryLinks = hasTable(db, 'page_entries')
      ? queryAll<BitaEntryLink>(
          db.prepare(
            `SELECT pe.page_id, pe.entry_id, pe.summary, pe.linked_at, e.description, ${entryCols.has('kind') ? 'e.kind' : 'NULL AS kind'}, e.started_at, e.stopped_at
             FROM page_entries pe JOIN entries e ON e.id = pe.entry_id
             ORDER BY pe.page_id, e.started_at`,
          ),
        )
      : []
    const segments = db.prepare(
      merged
        ? `SELECT id, started_at, stopped_at FROM entries WHERE id = ? OR merged_into = ?`
        : `SELECT id, started_at, stopped_at FROM entries WHERE id = ? OR id = ?`,
    )
    const jira = hasTable(db, 'jira_links') ? db.prepare('SELECT issue_key FROM jira_links WHERE entry_id = ? AND issue_key IS NOT NULL') : null
    const enriched = entryLinks.map((link) => {
      const parts = segments.all(link.entry_id, link.entry_id) as { id: number; started_at: string; stopped_at: string | null }[]
      const durationSeconds =
        link.stopped_at === null
          ? null
          : parts.reduce((sum, part) => sum + (part.stopped_at === null ? 0 : Math.max(0, Math.round((Date.parse(part.stopped_at) - Date.parse(part.started_at)) / 1000))), 0)
      const issues = new Set<string>()
      if (jira) for (const part of parts) for (const row of jira.all(part.id) as { issue_key: string }[]) issues.add(row.issue_key)
      return { ...link, durationSeconds, worklogIssues: [...issues].sort() }
    })

    const issueLinks = hasTable(db, 'page_issues') ? queryAll<BitaIssueLink>(db.prepare('SELECT * FROM page_issues ORDER BY page_id, issue_key')) : []
    const refs = hasTable(db, 'page_refs')
      ? queryAll<BitaRef>(db.prepare('SELECT page_id, url, title, kind, source, first_seen_at, last_seen_at FROM page_refs WHERE page_id IS NOT NULL ORDER BY id'))
      : []
    const backlogCols = columns(db, 'backlog_items')
    const backlog = hasTable(db, 'backlog_items')
      ? queryAll<BitaBacklog>(
          db.prepare(
            `SELECT id, project_id, ${pick(backlogCols, 'seq', 'NULL')}, page_id, entry_id, kind, title, body, status, resolution, source, created_at, updated_at, resolved_at
             FROM backlog_items ORDER BY id`,
          ),
        )
      : []
    const maps = hasTable(db, 'confluence_page_map') ? queryAll<BitaMap>(db.prepare('SELECT * FROM confluence_page_map')) : []
    const noteFiles = hasTable(db, 'entry_docs') ? queryAll<{ rel_path: string }>(db.prepare('SELECT rel_path FROM entry_docs ORDER BY rel_path')).map((row) => row.rel_path) : []
    const timezone = hasTable(db, 'settings') ? (queryOne<{ value: string }>(db.prepare(`SELECT value FROM settings WHERE key = 'timezone'`))?.value ?? null) : null

    return { projects, pages, entryLinks: enriched, issueLinks, refs, backlog, maps, noteFiles, timezone }
  } finally {
    db.close()
  }
}

async function bitaSiteUrl(configPath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as { jira?: { siteUrl?: unknown } }
    const raw = parsed.jira?.siteUrl
    return typeof raw === 'string' ? normalizeSiteUrl(raw) : null
  } catch {
    return null
  }
}

function countRows(db: DatabaseSync, table: string): number {
  return queryOne<{ total: number }>(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`))?.total ?? 0
}

async function isEmptyDir(path: string): Promise<boolean> {
  if (!existsSync(path)) return true
  const entries = (await readdir(path)).filter((name) => name !== '.DS_Store')
  return entries.length === 0
}

async function git(root: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const result = await execGit(['-c', 'core.quotepath=false', ...args], { cwd: root, timeoutMs })
  if (result.code !== 0) throw new ConflictError(`git ${args[0] ?? ''} failed in ${root}: ${(result.stderr || result.stdout).trim()}`, 'DOCS_GIT_FAILED')
  return result.stdout
}

async function copyDocs(source: string, target: string, snapshot: BitaSnapshot): Promise<{ source: 'git' | 'files' | 'none'; commit: string | null }> {
  const sourceIsRepo = existsSync(join(source, '.git'))
  let mode: 'git' | 'files' | 'none' = 'none'
  if (sourceIsRepo && (await gitAvailable())) {
    await mkdir(dirname(target), { recursive: true })
    await git(dirname(target), ['clone', '-q', '--no-hardlinks', source, target])
    await git(target, ['fetch', '-q', '--update-head-ok', 'origin', '+refs/heads/*:refs/heads/*'])
    await git(target, ['remote', 'remove', 'origin'])
    mode = 'git'
  } else if (existsSync(source)) {
    await cp(source, target, { recursive: true, filter: (path) => !path.split(/[\\/]/).includes('.git') })
    mode = 'files'
  }

  if (mode === 'git') {
    const working = [...snapshot.pages.flatMap((page) => [page.rel_path, `${page.rel_path.slice(0, -3)}.assets`]), ...snapshot.noteFiles]
    for (const rel of working) {
      const from = resolveDocPath(source, rel)
      if (existsSync(from)) await cp(from, resolveDocPath(target, rel), { recursive: true, force: true })
    }
  }

  if (mode === 'none' || !(await gitAvailable())) return { source: mode, commit: null }
  if (!isDocsRepo(target)) {
    const state = await initDocsRepo(target)
    return { source: mode, commit: state.head }
  }
  const commit = await commitPaths(target, ['.'], { source: 'import', subject: MIGRATION_COMMIT_SUBJECT, reason: 'bita migration' })
  return { source: mode, commit }
}

export interface MigrateOptions {
  dryRun: boolean
  location: BitaLocation
  docsRoot: string
  now: Date
}

export function migrateFromBita(db: DatabaseSync, options: MigrateOptions): Promise<MigrationReport> {
  return withEventBatch(() => runMigration(db, options))
}

async function runMigration(db: DatabaseSync, options: MigrateOptions): Promise<MigrationReport> {
  const { location, docsRoot, now } = options
  const status = migrationStatus(db)
  const empty: MigrationCounts = { spaces: 0, spacesReused: 0, pages: 0, entryLinks: 0, issueLinks: 0, refs: 0, backlog: 0, confluenceMaps: 0, noteFiles: 0 }
  const base = { bitaDatabase: location.database, bitaDocs: location.docs, docsRoot }

  if (status.migrated) {
    return { ...base, dryRun: options.dryRun, alreadyMigrated: true, counts: empty, docs: { source: 'none', commit: null }, notes: null, migratedAt: status.migratedAt }
  }
  if (!existsSync(location.database)) {
    throw new NotFoundError(`There is no bita database at ${location.database}.`, 'BITA_DB_NOT_FOUND', 'Pass --bita-db <path> or set BITA_DB_PATH.')
  }

  const snapshot = readBita(location.database)
  const reused = snapshot.projects.filter((project) => findSpaceByExternalRef(db, bitaProjectRef(project.id)) ?? findSpaceByName(db, project.name)).length
  const counts: MigrationCounts = {
    spaces: snapshot.projects.length - reused,
    spacesReused: reused,
    pages: snapshot.pages.length,
    entryLinks: snapshot.entryLinks.length,
    issueLinks: snapshot.issueLinks.length,
    refs: snapshot.refs.length,
    backlog: snapshot.backlog.length,
    confluenceMaps: snapshot.maps.length,
    noteFiles: snapshot.noteFiles.length,
  }

  if (countRows(db, 'pages') > 0 || countRows(db, 'backlog_items') > 0) {
    throw new ConflictError(
      'inkwell already has pages or backlog items, so the bita data would mix with them.',
      'MIGRATION_TARGET_NOT_EMPTY',
      'Migrate into a fresh database: point INKWELL_DB_PATH and INKWELL_DOCS_DIR somewhere empty.',
    )
  }
  if (!(await isEmptyDir(docsRoot))) {
    throw new ConflictError(`${docsRoot} already has files, and the bita docs would be cloned there.`, 'MIGRATION_DOCS_NOT_EMPTY', 'Move it away or set INKWELL_DOCS_DIR to an empty folder.')
  }

  if (options.dryRun) {
    const source = existsSync(join(location.docs, '.git')) ? 'git' : existsSync(location.docs) ? 'files' : 'none'
    return { ...base, dryRun: true, alreadyMigrated: false, counts, docs: { source, commit: null }, notes: null, migratedAt: null }
  }

  const createdDocs = !existsSync(docsRoot)
  if (!createdDocs) await rm(docsRoot, { recursive: true, force: true })
  let docs: { source: 'git' | 'files' | 'none'; commit: string | null }
  try {
    docs = await copyDocs(location.docs, docsRoot, snapshot)
  } catch (error) {
    await rm(docsRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  const siteUrl = await bitaSiteUrl(location.config)
  const at = now.toISOString()
  try {
    inTransaction(db, () => writeSnapshot(db, snapshot, { siteUrl, at, database: location.database }))
  } catch (error) {
    await rm(docsRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  try {
    const notes = await importNotesFromBita(db, { dryRun: false, location, docsRoot, now })
    return { ...base, dryRun: false, alreadyMigrated: false, counts, docs, notes, migratedAt: at }
  } catch (error) {
    const notesError = `${error instanceof Error ? error.message : String(error)}. Run "inkwell migrate notes --from-bita" to retry.`
    return { ...base, dryRun: false, alreadyMigrated: false, counts, docs, notes: null, notesError, migratedAt: at }
  }
}

function writeSnapshot(db: DatabaseSync, snapshot: BitaSnapshot, extra: { siteUrl: string | null; at: string; database: string }): void {
  const spaceOf = new Map<number, number>()
  const insertSpace = db.prepare(
    `INSERT INTO spaces (id, name, key, external_ref, client_name, active, atlassian_site, confluence_ref, confluence_kind, sync_pull, sync_push, last_sync_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const claimed = new Set<number>()
  for (const project of snapshot.projects) {
    const ref = bitaProjectRef(project.id)
    const byRef = findSpaceByExternalRef(db, ref)
    const byName = byRef ? undefined : findSpaceByName(db, project.name)
    const existing = byRef ?? (byName && byName.externalRef === null && !claimed.has(byName.id) ? byName : undefined)
    if (existing) {
      if (existing.externalRef === null) db.prepare('UPDATE spaces SET external_ref = ? WHERE id = ?').run(ref, existing.id)
      spaceOf.set(project.id, existing.id)
      claimed.add(existing.id)
      continue
    }
    const name = findSpaceByName(db, project.name) ? `${project.name} (${project.id})` : project.name
    const wanted = project.key?.toUpperCase() ?? null
    const key = wanted !== null && SPACE_KEY_PATTERN.test(wanted) && wanted !== UNASSIGNED_KEY && !findSpaceByKey(db, wanted) ? wanted : null
    const id = findSpaceById(db, project.id) ? null : project.id
    const result = insertSpace.run(
      id,
      name,
      key,
      ref,
      project.client_name,
      project.active,
      project.atlassian_site,
      project.confluence_ref,
      project.confluence_kind,
      project.sync_pull,
      project.sync_push,
      project.last_sync_at,
      project.created_at,
    )
    const spaceId = Number(result.lastInsertRowid)
    ensureSpaceKey(db, spaceId)
    spaceOf.set(project.id, spaceId)
    claimed.add(spaceId)
  }

  const mapSpace = (projectId: number | null): number | null => (projectId === null ? null : (spaceOf.get(projectId) ?? null))

  const insertPage = db.prepare(
    `INSERT INTO pages (id, space_id, parent_id, slug, title, rel_path, depth, position, status, source, section_count, heading_count, byte_size, checksum, repo_slug, branch, head_sha, created_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const page of snapshot.pages) {
    insertPage.run(
      page.id,
      mapSpace(page.project_id),
      page.parent_id,
      page.slug,
      page.title,
      page.rel_path,
      page.depth,
      page.position,
      page.status,
      page.source,
      page.section_count,
      page.heading_count,
      page.byte_size,
      page.checksum,
      page.repo_slug,
      page.branch,
      page.head_sha,
      page.created_at,
      page.recorded_at,
    )
  }

  const insertEntryLink = db.prepare(
    `INSERT OR IGNORE INTO page_links (page_id, ref, kind, summary, title, entry_kind, started_at, stopped_at, duration_seconds, worklog_issues, linked_at, refreshed_at)
     VALUES (?, ?, 'entry', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const link of snapshot.entryLinks) {
    insertEntryLink.run(
      link.page_id,
      entryRef(link.entry_id),
      link.summary,
      link.description,
      link.kind,
      link.started_at,
      link.stopped_at,
      link.durationSeconds,
      JSON.stringify(link.worklogIssues),
      link.linked_at,
      extra.at,
    )
  }

  const insertIssue = db.prepare(
    `INSERT OR IGNORE INTO page_links (page_id, ref, kind, role, summary, status, status_category, url, linked_at, refreshed_at)
     VALUES (?, ?, 'issue', ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const issue of snapshot.issueLinks) {
    insertIssue.run(issue.page_id, issueRef(issue.issue_key), issue.role, issue.summary, issue.status, issue.status_category, issue.url, issue.created_at, issue.refreshed_at)
  }

  const insertRef = db.prepare(
    `INSERT OR IGNORE INTO page_refs (page_id, url, title, kind, source, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const ref of snapshot.refs) insertRef.run(ref.page_id, ref.url, ref.title, ref.kind, ref.source, ref.first_seen_at, ref.last_seen_at)

  const insertBacklog = db.prepare(
    `INSERT INTO backlog_items (id, space_id, seq, page_id, origin_ref, kind, title, body, status, resolution, source, created_at, updated_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const item of snapshot.backlog) {
    insertBacklog.run(
      item.id,
      mapSpace(item.project_id),
      item.seq,
      item.page_id,
      item.entry_id === null ? null : entryRef(item.entry_id),
      item.kind,
      item.title,
      item.body,
      item.status,
      item.resolution,
      item.source,
      item.created_at,
      item.updated_at,
      item.resolved_at,
    )
  }

  const insertMap = db.prepare(
    `INSERT OR IGNORE INTO confluence_page_map (page_id, site, confluence_id, confluence_version, local_checksum, state, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const map of snapshot.maps) insertMap.run(map.page_id, map.site, map.confluence_id, map.confluence_version, map.local_checksum, map.state, map.synced_at)

  if (snapshot.timezone !== null && readSetting(db, TIMEZONE_KEY) === undefined) writeSetting(db, TIMEZONE_KEY, snapshot.timezone)
  if (extra.siteUrl !== null && readSetting(db, SITE_KEY) === undefined) writeSetting(db, SITE_KEY, extra.siteUrl)
  writeSetting(db, MIGRATED_FROM_KEY, extra.database)
  writeSetting(db, MIGRATED_AT_KEY, extra.at)
}
