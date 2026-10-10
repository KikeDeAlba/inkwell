import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { sandbox, type Sandbox } from './helpers/sandbox.ts'

const NOW = '2026-10-01T12:00:00.000Z'

function bitaWithNotes(box: Sandbox): { db: string; docs: string } {
  const root = join(box.dir, 'bita')
  const docs = join(root, 'docs')
  mkdirSync(join(docs, 'apartados', '2026', '09'), { recursive: true })
  mkdirSync(join(docs, '_no-project', '2026', '09'), { recursive: true })
  const dbPath = join(root, 'bita.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, key TEXT);
    CREATE TABLE entries (id INTEGER PRIMARY KEY, project_id INTEGER, description TEXT NOT NULL, started_at TEXT NOT NULL, stopped_at TEXT, kind TEXT, merged_into INTEGER);
    CREATE TABLE jira_links (entry_id INTEGER PRIMARY KEY, issue_key TEXT, worklog_id TEXT, linked_at TEXT NOT NULL);
    CREATE TABLE entry_docs (entry_id INTEGER NOT NULL, rel_path TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note', title TEXT NOT NULL DEFAULT '', title_slug TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
      section_count INTEGER NOT NULL DEFAULT 0, byte_size INTEGER NOT NULL DEFAULT 0, checksum TEXT NOT NULL DEFAULT '', repo_slug TEXT, branch TEXT, head_sha TEXT, created_at TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY (entry_id, rel_path));
  `)
  db.prepare(`INSERT INTO projects (id, name, created_at, key) VALUES (3, 'Apartados', ?, 'APT')`).run(NOW)
  db.prepare(`INSERT INTO entries (id, project_id, description, started_at, stopped_at, kind) VALUES (10, 3, 'Ajustar WAF', '2026-09-20T15:00:00.000Z', '2026-09-20T16:00:00.000Z', NULL)`).run()
  db.prepare(`INSERT INTO entries (id, project_id, description, started_at, stopped_at, kind) VALUES (11, NULL, 'Junta semanal', '2026-09-21T15:00:00.000Z', '2026-09-21T15:30:00.000Z', 'remote-meeting')`).run()
  db.prepare(`INSERT INTO entries (id, project_id, description, started_at, stopped_at) VALUES (12, 3, 'Perdida', '2026-09-22T15:00:00.000Z', '2026-09-22T15:10:00.000Z')`).run()
  db.prepare(`INSERT INTO jira_links (entry_id, issue_key, linked_at) VALUES (10, 'VB-9', ?)`).run(NOW)
  const insert = db.prepare(`INSERT INTO entry_docs (entry_id, rel_path, kind, title, source, repo_slug, created_at, recorded_at) VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)`)
  insert.run(10, 'apartados/2026/09/20-10-ajustar-waf.md', 'note', 'Ajustar WAF', 'acme/infra', NOW, NOW)
  insert.run(10, 'apartados/2026/09/20-10-ajustar-waf--anexo.md', 'appendix', 'Anexo', null, NOW, NOW)
  insert.run(11, '_no-project/2026/09/21-11-junta-semanal.md', 'note', 'Junta semanal', null, NOW, NOW)
  insert.run(12, 'apartados/2026/09/22-12-perdida.md', 'note', 'Perdida', null, NOW, NOW)
  db.close()

  writeFileSync(join(docs, 'apartados', '2026', '09', '20-10-ajustar-waf.md'), '---\nbita: 1\nentryId: 10\n---\n\n# Ajustar WAF\n\n## Contexto\n\nEl WAF bloquea admin.\n')
  writeFileSync(join(docs, 'apartados', '2026', '09', '20-10-ajustar-waf--anexo.md'), '# Anexo\n')
  writeFileSync(join(docs, '_no-project', '2026', '09', '21-11-junta-semanal.md'), '# Junta semanal\n\n## Reunión\n\n- Acuerdos.\n')
  return { db: dbPath, docs }
}

test('migrate notes --from-bita copies the entry notes once, keeps bita intact and is safe to repeat', (t) => {
  const box = sandbox(t, { INKWELL_NO_BITA: '1' })
  const bita = bitaWithNotes(box)
  box.env['BITA_DB_PATH'] = bita.db
  box.env['BITA_DOCS_DIR'] = bita.docs
  box.ok('space', 'add', 'Apartados', '--key', 'APT', '--external-ref', 'bita:project:3')
  box.ok('page', 'new', 'Arquitectura', '--project', 'APT')

  const dry = box.ok('migrate', 'notes', '--from-bita', '--dry-run')
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.counts, { scanned: 4, imported: 3, already: 0, missing: 1, conflicts: 0 })
  assert.equal(dry.commit, null)
  assert.equal(existsSync(join(box.env['INKWELL_DOCS_DIR'] as string, 'apartados', '2026')), false)

  const done = box.ok('migrate', 'notes', '--from-bita')
  assert.deepEqual(done.counts, { scanned: 4, imported: 3, already: 0, missing: 1, conflicts: 0 })
  assert.match(done.commit, /^[0-9a-f]{40}$/)
  assert.equal(done.items.find((item: { entryId: number }) => item.entryId === 12).action, 'missing')

  const docs = box.env['INKWELL_DOCS_DIR'] as string
  assert.match(readFileSync(join(docs, 'apartados', '2026', '09', '20-10-ajustar-waf.md'), 'utf8'), /El WAF bloquea admin\./)
  assert.ok(existsSync(join(bita.docs, 'apartados', '2026', '09', '20-10-ajustar-waf.md')))
  const bitaDb = new DatabaseSync(bita.db, { readOnly: true })
  assert.equal((bitaDb.prepare('SELECT COUNT(*) AS n FROM entry_docs').get() as { n: number }).n, 4)
  bitaDb.close()

  const shown = box.ok('note', 'show', '10')
  assert.equal(shown.title, 'Ajustar WAF')
  assert.equal(shown.issueKey, 'VB-9')
  assert.equal(shown.durationSeconds, 3600)
  assert.equal(shown.appendices.length, 1)
  assert.equal(shown.doc.repoSlug, 'acme/infra')
  assert.equal(box.ok('note', 'show', '11').projectName, null)
  assert.equal(box.ok('note', 'ls', '--project', 'APT').length, 1)
  assert.equal(box.ok('note', 'search', 'acuerdos')[0].entryId, 11)

  const log = execFileSync('git', ['log', '--format=%s'], { cwd: docs, encoding: 'utf8', env: box.env }).trim().split('\n')
  assert.equal(log[0], 'chore: import entry notes from bita')

  const again = box.ok('migrate', 'notes', '--from-bita')
  assert.deepEqual(again.counts, { scanned: 4, imported: 0, already: 3, missing: 1, conflicts: 0 })
  assert.equal(again.commit, null)
})

test('migrate notes leaves a different file alone and reports it as a conflict', (t) => {
  const box = sandbox(t, { INKWELL_NO_BITA: '1' })
  const bita = bitaWithNotes(box)
  const docs = box.env['INKWELL_DOCS_DIR'] as string
  mkdirSync(join(docs, '_no-project', '2026', '09'), { recursive: true })
  writeFileSync(join(docs, '_no-project', '2026', '09', '21-11-junta-semanal.md'), '# Otra cosa\n')

  const done = box.ok('migrate', 'notes', '--from-bita', '--bita-db', bita.db, '--bita-docs', bita.docs)
  assert.equal(done.counts.conflicts, 1)
  assert.equal(done.counts.imported, 2)
  assert.equal(readFileSync(join(docs, '_no-project', '2026', '09', '21-11-junta-semanal.md'), 'utf8'), '# Otra cosa\n')
  assert.equal(box.ok('note', 'ls', '11').length, 0)
})
