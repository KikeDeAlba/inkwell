import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openMemoryDatabase } from '../src/db/open.ts'
import { linkIssueToPage, unlinkIssueFromPage } from '../src/db/page-links.ts'
import { findPage, insertPage, requirePage } from '../src/db/pages.ts'
import { parseDocument } from '../src/docs/markdown.ts'
import { recordPageDoc } from '../src/docs/page-record.ts'
import type { DocsContext } from '../src/docs/context.ts'

const NOW = new Date('2026-09-22T08:00:00.000Z')
const REL = 'gcc/notificaciones-programadas.md'

function context(): { ctx: DocsContext; root: string; pageId: number } {
  const root = mkdtempSync(join(tmpdir(), 'inkwell-front-matter-'))
  const db = openMemoryDatabase()

  db.prepare('INSERT INTO spaces (id, name, active, created_at) VALUES (1, ?, 1, ?)').run(
    'GCC',
    NOW.toISOString(),
  )

  const pageId = insertPage(db, {
    spaceId: 1,
    parentId: null,
    slug: 'notificaciones-programadas',
    title: 'Notificaciones programadas',
    relPath: REL,
    depth: 0,
    source: 'cli',
    now: NOW.toISOString(),
  })

  return { ctx: { db, docsRoot: root, timezone: 'America/Mazatlan', now: NOW }, root, pageId }
}

async function frontMatter(root: string): Promise<Map<string, string>> {
  return parseDocument(await readFile(join(root, REL), 'utf8')).frontMatter
}

test('the issues linked to a page reach its front matter', async () => {
  const { ctx, root, pageId } = context()

  try {
    await recordPageDoc(ctx, requirePage(ctx.db, pageId), {
      body: '# Notificaciones programadas\n\nEstado actual.\n',
    })
    assert.equal((await frontMatter(root)).get('issues'), '')

    linkIssueToPage(ctx.db, {
      pageId,
      issueKey: 'GCCAPP-2209',
      statusCategory: 'done',
      url: 'https://gruposti.atlassian.net/browse/GCCAPP-2209',
      now: NOW.toISOString(),
    })
    linkIssueToPage(ctx.db, { pageId, issueKey: 'GCCAPP-2211', now: NOW.toISOString() })
    await recordPageDoc(ctx, requirePage(ctx.db, pageId))

    assert.equal((await frontMatter(root)).get('issues'), 'GCCAPP-2209, GCCAPP-2211')

    const recorded = findPage(ctx.db, pageId)
    assert.equal(recorded?.relPath, REL)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('unlinking takes the key back out', async () => {
  const { ctx, root, pageId } = context()

  try {
    await recordPageDoc(ctx, requirePage(ctx.db, pageId), {
      body: '# Notificaciones programadas\n\nEstado actual.\n',
    })
    linkIssueToPage(ctx.db, { pageId, issueKey: 'GCCAPP-2211', now: NOW.toISOString() })
    await recordPageDoc(ctx, requirePage(ctx.db, pageId))
    assert.equal((await frontMatter(root)).get('issues'), 'GCCAPP-2211')

    unlinkIssueFromPage(ctx.db, pageId, 'GCCAPP-2211')
    await recordPageDoc(ctx, requirePage(ctx.db, pageId))
    assert.equal((await frontMatter(root)).get('issues'), '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a hand-written body survives the restamp', async () => {
  const { ctx, root, pageId } = context()

  try {
    await recordPageDoc(ctx, requirePage(ctx.db, pageId), {
      body: '# Notificaciones programadas\n\nEstado actual.\n\n## Cómo funciona\n\nEventBridge Scheduler.\n',
    })

    linkIssueToPage(ctx.db, { pageId, issueKey: 'GCCAPP-2211', now: NOW.toISOString() })
    await recordPageDoc(ctx, requirePage(ctx.db, pageId))

    const doc = parseDocument(await readFile(join(root, REL), 'utf8'))
    assert.equal(doc.preamble.trim(), 'Estado actual.')
    assert.deepEqual(
      doc.sections.map((section) => section.heading),
      ['Cómo funciona'],
    )
    assert.equal(doc.sections[0]?.body.trim(), 'EventBridge Scheduler.')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
