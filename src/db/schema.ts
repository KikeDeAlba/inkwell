import type { DatabaseSync } from 'node:sqlite'

export interface Migration {
  readonly version: number
  readonly statements: readonly string[]
  readonly run?: (db: DatabaseSync) => void
}

const INITIAL_SCHEMA: readonly string[] = [
  `CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  `CREATE TABLE spaces (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     key TEXT,
     external_ref TEXT,
     client_name TEXT,
     active INTEGER NOT NULL DEFAULT 1,
     atlassian_site TEXT,
     confluence_ref TEXT,
     confluence_kind TEXT,
     sync_pull INTEGER NOT NULL DEFAULT 0,
     sync_push INTEGER NOT NULL DEFAULT 0,
     last_sync_at TEXT,
     created_at TEXT NOT NULL,
     CHECK (name <> ''),
     CHECK (confluence_kind IS NULL OR confluence_kind IN ('space', 'page'))
   )`,
  `CREATE UNIQUE INDEX spaces_name ON spaces (name COLLATE NOCASE)`,
  `CREATE UNIQUE INDEX spaces_key ON spaces (key COLLATE NOCASE)`,
  `CREATE UNIQUE INDEX spaces_external_ref ON spaces (external_ref) WHERE external_ref IS NOT NULL`,

  `CREATE TABLE pages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     space_id INTEGER REFERENCES spaces (id) ON DELETE RESTRICT,
     parent_id INTEGER REFERENCES pages (id) ON DELETE RESTRICT,
     slug TEXT NOT NULL,
     title TEXT NOT NULL,
     rel_path TEXT NOT NULL,
     depth INTEGER NOT NULL DEFAULT 0,
     position INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'active',
     source TEXT NOT NULL,
     section_count INTEGER NOT NULL DEFAULT 0,
     heading_count INTEGER NOT NULL DEFAULT 0,
     byte_size INTEGER NOT NULL DEFAULT 0,
     checksum TEXT NOT NULL DEFAULT '',
     repo_slug TEXT,
     branch TEXT,
     head_sha TEXT,
     created_at TEXT NOT NULL,
     recorded_at TEXT NOT NULL,
     CHECK (status IN ('active', 'archived')),
     CHECK (title <> ''),
     CHECK (slug <> '' AND slug NOT LIKE '%/%' AND slug NOT LIKE '%.%'),
     CHECK (rel_path <> '' AND rel_path NOT LIKE '/%' AND rel_path NOT LIKE '%..%'),
     CHECK (depth >= 0 AND depth <= 4),
     CHECK (parent_id IS NULL OR parent_id <> id)
   )`,
  `CREATE UNIQUE INDEX pages_sibling ON pages (IFNULL(space_id, 0), IFNULL(parent_id, 0), slug)`,
  `CREATE UNIQUE INDEX pages_path ON pages (rel_path)`,
  `CREATE INDEX pages_parent ON pages (parent_id, position)`,
  `CREATE INDEX pages_space ON pages (space_id, position)`,

  `CREATE TABLE page_links (
     page_id INTEGER NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
     ref TEXT NOT NULL,
     kind TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT '',
     summary TEXT NOT NULL DEFAULT '',
     title TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT '',
     status_category TEXT NOT NULL DEFAULT '',
     url TEXT,
     entry_kind TEXT,
     started_at TEXT,
     stopped_at TEXT,
     duration_seconds INTEGER,
     worklog_issues TEXT NOT NULL DEFAULT '[]',
     linked_at TEXT NOT NULL,
     refreshed_at TEXT,
     PRIMARY KEY (page_id, ref),
     CHECK (kind IN ('entry', 'issue', 'other')),
     CHECK (role IN ('', 'epic', 'story', 'task', 'subtask')),
     CHECK (status_category IN ('', 'new', 'indeterminate', 'done')),
     CHECK (ref <> '' AND ref LIKE '%:%')
   )`,
  `CREATE INDEX page_links_ref ON page_links (ref)`,

  `CREATE TABLE page_refs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     page_id INTEGER NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
     url TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL DEFAULT 'link',
     source TEXT NOT NULL DEFAULT 'manual',
     first_seen_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     CHECK (kind IN ('confluence', 'jira', 'drive', 'link')),
     CHECK (source IN ('manual', 'hook')),
     CHECK (url LIKE 'http://%' OR url LIKE 'https://%')
   )`,
  `CREATE UNIQUE INDEX page_refs_page_url ON page_refs (page_id, url)`,

  `CREATE TABLE backlog_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     space_id INTEGER REFERENCES spaces (id) ON DELETE RESTRICT,
     seq INTEGER,
     page_id INTEGER REFERENCES pages (id) ON DELETE SET NULL,
     origin_ref TEXT,
     kind TEXT NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'open',
     resolution TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL DEFAULT 'manual',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     resolved_at TEXT,
     CHECK (kind IN ('pending', 'finding')),
     CHECK (status IN ('open', 'resolved')),
     CHECK (source IN ('manual', 'extracted')),
     CHECK (title <> ''),
     CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
   )`,
  `CREATE INDEX backlog_items_space ON backlog_items (space_id, status, kind)`,
  `CREATE INDEX backlog_items_page ON backlog_items (page_id)`,
  `CREATE INDEX backlog_items_origin ON backlog_items (origin_ref)`,
  `CREATE UNIQUE INDEX backlog_items_seq ON backlog_items (space_id, seq)`,

  `CREATE TABLE confluence_page_map (
     page_id INTEGER PRIMARY KEY REFERENCES pages (id) ON DELETE CASCADE,
     site TEXT NOT NULL,
     confluence_id TEXT NOT NULL,
     confluence_version INTEGER NOT NULL,
     local_checksum TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('synced', 'conflict')),
     synced_at TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX confluence_page_map_remote ON confluence_page_map (site, confluence_id)`,
]

export const MIGRATIONS: readonly Migration[] = [{ version: 1, statements: INITIAL_SCHEMA }]

export const LATEST_VERSION = MIGRATIONS.reduce((highest, migration) => Math.max(highest, migration.version), 0)
