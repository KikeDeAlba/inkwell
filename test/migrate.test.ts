import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openMemoryDatabase } from '../src/db/open.ts'
import { listPages } from '../src/db/pages.ts'
import { findNoteByRelPath } from '../src/db/entry-notes.ts'
import { setDocsEventSink, type DocsChangedEvent } from '../src/docs/events.ts'
import { migrateFromBita } from '../src/migrate/from-bita.ts'
import { sandbox, type Sandbox } from './helpers/sandbox.ts'

const NOW = '2026-10-01T12:00:00.000Z'

function gitIn(root: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', env })
}

function bitaFixture(box: Sandbox): { db: string; docs: string } {
  const root = join(box.dir, 'bita')
  const docs = join(root, 'docs')
  mkdirSync(join(docs, 'apartados', 'arquitectura.assets'), { recursive: true })
  mkdirSync(join(docs, 'apartados', '2026', '09'), { recursive: true })
  const dbPath = join(root, 'bita.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, client_name TEXT, active INTEGER NOT NULL DEFAULT 1, external_id INTEGER, created_at TEXT NOT NULL, key TEXT, jira INTEGER NOT NULL DEFAULT 1,
      atlassian_site TEXT, atlassian_via TEXT NOT NULL DEFAULT 'mcp', confluence_ref TEXT, confluence_kind TEXT, sync_pull INTEGER NOT NULL DEFAULT 0, sync_push INTEGER NOT NULL DEFAULT 0, last_sync_at TEXT);
    CREATE TABLE entries (id INTEGER PRIMARY KEY, project_id INTEGER, description TEXT NOT NULL, started_at TEXT NOT NULL, stopped_at TEXT, billable INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL,
      external_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, merged_into INTEGER, kind TEXT);
    CREATE TABLE jira_links (entry_id INTEGER PRIMARY KEY, issue_key TEXT, worklog_id TEXT, linked_at TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE entry_docs (entry_id INTEGER NOT NULL, rel_path TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note', title TEXT NOT NULL DEFAULT '', title_slug TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
      section_count INTEGER NOT NULL DEFAULT 0, byte_size INTEGER NOT NULL DEFAULT 0, checksum TEXT NOT NULL DEFAULT '', repo_slug TEXT, branch TEXT, head_sha TEXT, created_at TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY (entry_id, rel_path));
    CREATE TABLE doc_pages (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, parent_id INTEGER, slug TEXT NOT NULL, title TEXT NOT NULL, rel_path TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL, section_count INTEGER NOT NULL DEFAULT 0, heading_count INTEGER NOT NULL DEFAULT 0,
      byte_size INTEGER NOT NULL DEFAULT 0, checksum TEXT NOT NULL DEFAULT '', repo_slug TEXT, branch TEXT, head_sha TEXT, created_at TEXT NOT NULL, recorded_at TEXT NOT NULL);
    CREATE TABLE page_entries (page_id INTEGER NOT NULL, entry_id INTEGER NOT NULL, summary TEXT NOT NULL DEFAULT '', linked_at TEXT NOT NULL, PRIMARY KEY (page_id, entry_id));
    CREATE TABLE page_issues (page_id INTEGER NOT NULL, issue_key TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'task', summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '',
      status_category TEXT NOT NULL DEFAULT '', url TEXT, created_at TEXT NOT NULL, refreshed_at TEXT, PRIMARY KEY (page_id, issue_key));
    CREATE TABLE page_refs (id INTEGER PRIMARY KEY AUTOINCREMENT, page_id INTEGER, entry_id INTEGER, url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'link',
      source TEXT NOT NULL DEFAULT 'manual', first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
    CREATE TABLE backlog_items (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, page_id INTEGER, entry_id INTEGER, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open', resolution TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT, seq INTEGER);
    CREATE TABLE confluence_page_map (page_id INTEGER PRIMARY KEY, site TEXT NOT NULL, confluence_id TEXT NOT NULL, confluence_version INTEGER NOT NULL, local_checksum TEXT NOT NULL, state TEXT NOT NULL, synced_at TEXT NOT NULL);
  `)
  db.prepare(`INSERT INTO projects (id, name, created_at, key, atlassian_site, confluence_ref, confluence_kind, sync_pull) VALUES (3, 'Apartados', ?, 'APT', 'https://acme.atlassian.net', 'VB', 'space', 1)`).run(NOW)
  db.prepare(`INSERT INTO projects (id, name, created_at, key) VALUES (5, 'CoDi', ?, 'CODI')`).run(NOW)
  db.prepare(`INSERT INTO projects (id, name, created_at, key) VALUES (6, 'apartados', ?, 'bl')`).run(NOW)
  db.prepare(`INSERT INTO backlog_items (id, project_id, kind, title, created_at, updated_at, seq) VALUES (5, 6, 'finding', 'Otro', ?, ?, 14)`).run(NOW, NOW)
  db.prepare(`INSERT INTO entries (id, project_id, description, started_at, stopped_at, source, created_at, updated_at) VALUES (10, 3, 'Ajustar WAF', '2026-09-20T15:00:00.000Z', '2026-09-20T16:00:00.000Z', 'timer', ?, ?)`).run(NOW, NOW)
  db.prepare(`INSERT INTO entries (id, project_id, description, started_at, stopped_at, source, created_at, updated_at, merged_into) VALUES (11, 3, 'seg', '2026-09-21T15:00:00.000Z', '2026-09-21T15:30:00.000Z', 'timer', ?, ?, 10)`).run(NOW, NOW)
  db.prepare(`INSERT INTO jira_links (entry_id, issue_key, linked_at) VALUES (11, 'VB-9', ?)`).run(NOW)
  db.prepare(`INSERT INTO settings (key, value) VALUES ('timezone', 'America/Mexico_City')`).run()
  db.prepare(`INSERT INTO entry_docs (entry_id, rel_path, source, created_at, recorded_at) VALUES (10, 'apartados/2026/09/20-10-ajustar-waf.md', 'stop', ?, ?)`).run(NOW, NOW)
  db.prepare(`INSERT INTO doc_pages (id, project_id, parent_id, slug, title, rel_path, depth, source, created_at, recorded_at) VALUES (7, 3, NULL, 'arquitectura', 'Arquitectura', 'apartados/arquitectura.md', 0, 'cli', ?, ?)`).run(NOW, NOW)
  db.prepare(`INSERT INTO doc_pages (id, project_id, parent_id, slug, title, rel_path, depth, source, created_at, recorded_at) VALUES (8, 3, 7, 'waf', 'WAF', 'apartados/arquitectura/waf.md', 1, 'cli', ?, ?)`).run(NOW, NOW)
  db.prepare(`INSERT INTO page_entries (page_id, entry_id, summary, linked_at) VALUES (7, 10, 'Se abrió el WAF.', ?)`).run(NOW)
  db.prepare(`INSERT INTO page_issues (page_id, issue_key, summary, created_at) VALUES (7, 'VB-1', 'Seguridad', ?)`).run(NOW)
  db.prepare(`INSERT INTO page_refs (page_id, url, title, kind, first_seen_at, last_seen_at) VALUES (7, 'https://acme.atlassian.net/wiki/x', 'Hub', 'confluence', ?, ?)`).run(NOW, NOW)
  db.prepare(`INSERT INTO page_refs (entry_id, url, first_seen_at, last_seen_at) VALUES (10, 'https://example.com/e', ?, ?)`).run(NOW, NOW)
  db.prepare(`INSERT INTO backlog_items (id, project_id, page_id, entry_id, kind, title, created_at, updated_at, seq) VALUES (4, 3, 7, 10, 'pending', 'Rotar llaves', ?, ?, 14)`).run(NOW, NOW)
  db.prepare(`INSERT INTO confluence_page_map (page_id, site, confluence_id, confluence_version, local_checksum, state, synced_at) VALUES (7, 'https://acme.atlassian.net', '100', 3, 'sha256:x', 'synced', ?)`).run(NOW)
  db.close()

  writeFileSync(join(docs, 'apartados', 'arquitectura.md'), '---\nbita: 1\npageId: 7\n---\n\n# Arquitectura\n\n## Estado\n\nUno.\n')
  writeFileSync(join(docs, 'apartados', 'arquitectura.assets', 'red.drawio'), '<mxfile/>')
  writeFileSync(join(docs, 'apartados', '2026', '09', '20-10-ajustar-waf.md'), '# Nota\n')
  gitIn(docs, box.env, 'init', '-q', '-b', 'main')
  gitIn(docs, box.env, 'add', '-A')
  gitIn(docs, box.env, 'commit', '-q', '-m', 'docs(apartados): create arquitectura')
  gitIn(docs, box.env, 'branch', 'proposal/x')
  writeFileSync(join(docs, 'apartados', 'arquitectura.md'), '---\nbita: 1\npageId: 7\n---\n\n# Arquitectura\n\n## Estado\n\nDos, sin commitear.\n')
  return { db: dbPath, docs }
}

test('migrate --from-bita reports with --dry-run, copies everything once, keeps the history and brings the entry notes', (t) => {
  const box = sandbox(t)
  const bita = bitaFixture(box)
  box.env['BITA_DB_PATH'] = bita.db
  box.env['BITA_CONFIG_PATH'] = join(box.dir, 'bita', 'config.json')
  writeFileSync(box.env['BITA_CONFIG_PATH'], JSON.stringify({ jira: { siteUrl: 'https://acme.atlassian.net' } }))

  const dry = box.ok('migrate', '--from-bita', '--dry-run')
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.counts, { spaces: 3, spacesReused: 0, pages: 2, entryLinks: 1, issueLinks: 1, refs: 1, backlog: 2, confluenceMaps: 1, noteFiles: 1 })
  assert.equal(dry.docs.source, 'git')
  assert.equal(box.ok('migrate', 'status').migrated, false)
  assert.equal(existsSync(box.env['INKWELL_DOCS_DIR'] as string), false)

  const done = box.ok('migrate', '--from-bita')
  assert.equal(done.alreadyMigrated, false)
  assert.match(done.docs.commit, /^[0-9a-f]{40}$/)

  const status = box.ok('migrate', 'status')
  assert.equal(status.migrated, true)
  assert.equal(status.bitaDatabase, bita.db)

  const space = box.ok('space', 'show', '3')
  assert.equal(space.name, 'Apartados')
  assert.equal(space.key, 'APT')
  assert.equal(space.externalRef, 'bita:project:3')
  assert.equal(space.atlassian.confluence.spaceKey, 'VB')
  assert.equal(space.atlassian.sync.pull, true)

  const page = box.ok('page', 'show', '7')
  assert.equal(page.title, 'Arquitectura')
  assert.equal(page.entryCount, 1)
  assert.equal(page.durationSeconds, 5400)
  assert.deepEqual(page.worklogIssues, ['VB-9'])
  assert.equal(page.issues[0].issueKey, 'VB-1')
  assert.equal(page.refs.length, 1)
  assert.equal(page.backlog[0].key, 'APT-14')
  assert.match(page.doc.markdown, /Dos, sin commitear/)

  const backlog = box.ok('backlog', 'ls', '--project', 'APT')
  assert.equal(backlog[0].originRef, 'bita:entry:10')
  const twin = box.ok('space', 'show', '6')
  assert.equal(twin.name, 'apartados (6)')
  assert.notEqual(twin.key, 'BL')
  assert.equal(box.ok('backlog', 'ls', '--project', '6')[0].key, `${twin.key}-14`)

  const docs = box.env['INKWELL_DOCS_DIR'] as string
  assert.equal(readFileSync(join(docs, 'apartados', '2026', '09', '20-10-ajustar-waf.md'), 'utf8'), '# Nota\n')
  assert.equal(done.notes.counts.imported, 1)
  const note = box.ok('note', 'show', '10')
  assert.equal(note.doc.relPath, 'apartados/2026/09/20-10-ajustar-waf.md')
  assert.equal(note.title, 'Ajustar WAF')
  assert.equal(note.spaceId, space.id)
  assert.equal(note.durationSeconds, 3600)
  assert.equal(readFileSync(join(docs, 'apartados', 'arquitectura.assets', 'red.drawio'), 'utf8'), '<mxfile/>')
  const log = gitIn(docs, box.env, 'log', '--format=%s', 'main').trim().split('\n')
  assert.deepEqual(log, ['chore: move docs from bita', 'docs(apartados): create arquitectura'])
  assert.match(gitIn(docs, box.env, 'branch', '--list'), /proposal\/x/)
  assert.equal(gitIn(docs, box.env, 'remote').trim(), '')
  assert.equal(box.ok('config', 'get').site, 'https://acme.atlassian.net')
  assert.equal(box.ok('page', 'history', '7').revisions.length, 2)

  const again = box.ok('migrate', '--from-bita')
  assert.equal(again.alreadyMigrated, true)
  assert.equal(box.ok('ls').length, 2)
})

test('migration refuses to mix with pages that already exist', (t) => {
  const box = sandbox(t)
  const bita = bitaFixture(box)
  box.ok('space', 'add', 'Apartados')
  box.ok('page', 'new', 'Propia', '--project', 'Apartados')
  const refused = box.run(['migrate', '--from-bita', '--bita-db', bita.db])
  assert.equal(refused.json.error.code, 'MIGRATION_TARGET_NOT_EMPTY')
})

test('a missing bita database is a clear error', (t) => {
  const box = sandbox(t)
  const missing = box.run(['migrate', '--from-bita', '--bita-db', join(box.dir, 'nope.db')])
  assert.equal(missing.json.error.code, 'BITA_DB_NOT_FOUND')
})

test('the whole migration, notes included, emits a single docs.changed once the data is in place', async (t) => {
  const box = sandbox(t)
  const bita = bitaFixture(box)
  const db = openMemoryDatabase()
  const docsRoot = join(box.dir, 'migrated-docs')
  const seen: { event: DocsChangedEvent; pages: number; notes: boolean }[] = []
  const previous = setDocsEventSink(async (event) => {
    seen.push({ event, pages: listPages(db).length, notes: findNoteByRelPath(db, 'apartados/2026/09/20-10-ajustar-waf.md') !== undefined })
  })
  t.after(() => setDocsEventSink(previous))

  const report = await migrateFromBita(db, {
    dryRun: false,
    location: { database: bita.db, docs: bita.docs, config: join(box.dir, 'bita', 'config.json') },
    docsRoot,
    now: new Date(NOW),
  })
  assert.equal(report.notes?.counts.imported, 1)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.pages, 2)
  assert.equal(seen[0]?.notes, true)
  assert.equal(seen[0]?.event.commit, report.docs.commit)
  assert.deepEqual(seen[0]?.event.changes, [{ action: 'written', relPath: 'apartados/arquitectura.md' }])
})
