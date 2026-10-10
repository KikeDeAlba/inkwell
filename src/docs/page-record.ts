import { existsSync } from 'node:fs'
import { DOC_SCHEMA_VERSION } from '../config/constants.ts'
import { assetsRelDir } from './diagrams.ts'
import { ancestorsOf, descendantsOf, recordPageFile, repointPage, type DocPageRow } from '../db/pages.ts'
import { issuesOfPage } from '../db/page-links.ts'
import type { DocsContext } from './context.ts'
import {
  checksumOf,
  emptyDocument,
  filledSections,
  outline,
  parseDocument,
  renderDocument,
  stampFrontMatter,
  upsertSection,
  type ParsedDocument,
} from './markdown.ts'
import { resolveDocPath } from './paths.ts'
import { readRaw, renameDocument, withDocLock, writeDocument } from './store.ts'
import { commitDocs, docsSubject, prepareDocsRepo, type DocsSource } from './git.ts'

export interface PageWrite {
  section?: { heading: string; body: string } | undefined
  body?: string | undefined
  frontMatter?: Record<string, string> | undefined
  dropSections?: readonly string[] | undefined
}

export interface RecordedPage {
  page: DocPageRow
  path: string
  relPath: string
  created: boolean
  changed: boolean
  sectionCount: number
  headingCount: number
  sha: string | null
}

export interface PageCommit {
  source?: DocsSource | undefined
  action?: string | undefined
  reason?: string | null | undefined
  entryId?: number | null | undefined
  trailers?: Record<string, string> | undefined
}

export function pageCommitIntent(page: DocPageRow, relPath: string, action: string, commit: PageCommit) {
  return {
    source: commit.source ?? 'manual',
    subject: docsSubject(relPath, commit.action ?? action, page.title),
    pageId: page.id,
    entryId: commit.entryId ?? null,
    reason: commit.reason ?? null,
    ...(commit.trailers ? { trailers: commit.trailers } : {}),
  }
}

export function pageFilePaths(relPath: string): string[] {
  return [relPath, assetsRelDir(relPath), relPath.slice(0, -3)]
}

function ownedFrontMatter(ctx: DocsContext, page: DocPageRow, parentTitle: string | null): Record<string, string> {
  const issues = issuesOfPage(ctx.db, page.id)
  return {
    inkwell: String(DOC_SCHEMA_VERSION),
    pageId: String(page.id),
    title: page.title,
    parent: parentTitle ?? '',
    issues: issues.map((issue) => issue.issueKey).join(', '),
    updatedAt: ctx.now.toISOString(),
  }
}

export async function recordPageDoc(
  ctx: DocsContext,
  page: DocPageRow,
  write: PageWrite = {},
  commit: PageCommit | false = {},
): Promise<RecordedPage> {
  const absolutePath = resolveDocPath(ctx.docsRoot, page.relPath)
  const parents = ancestorsOf(ctx.db, page.id)
  const parentTitle = parents.at(-1)?.title ?? null
  if (commit !== false) await prepareDocsRepo(ctx.docsRoot)

  return withDocLock(absolutePath, async () => {
    const raw = await readRaw(absolutePath)
    let doc: ParsedDocument = raw === null ? emptyDocument(new Map(), page.title) : parseDocument(raw)

    if (write.body !== undefined) {
      const replacement = parseDocument(write.body)
      doc = { ...doc, preamble: replacement.preamble, sections: replacement.sections }
    }
    if (write.section) {
      doc = upsertSection(doc, write.section.heading, write.section.body).doc
    }
    if (write.dropSections && write.dropSections.length > 0) {
      const dropped = new Set(write.dropSections)
      doc = { ...doc, sections: doc.sections.filter((section) => !dropped.has(section.heading)) }
    }
    if (doc.title !== page.title) doc = { ...doc, title: page.title }
    if (doc.frontMatterValid || raw === null) {
      doc = stampFrontMatter(doc, { ...ownedFrontMatter(ctx, page, parentTitle), ...(write.frontMatter ?? {}) })
      if (doc.frontMatter.has('bita')) doc = { ...doc, frontMatter: new Map([...doc.frontMatter].filter(([key]) => key !== 'bita')) }
    }

    const result = await writeDocument(absolutePath, doc)
    const headingCount = outline(doc).filter((heading) => heading.level === 2).length

    recordPageFile(ctx.db, page.id, {
      sectionCount: filledSections(doc).length,
      headingCount,
      byteSize: result.byteSize,
      checksum: result.checksum,
      recordedAt: ctx.now.toISOString(),
    })

    const sha =
      commit === false || !result.changed
        ? null
        : await commitDocs(
            ctx.docsRoot,
            [page.relPath],
            pageCommitIntent(page, page.relPath, result.created ? 'create' : 'update', commit),
          )

    return {
      page,
      path: absolutePath,
      relPath: page.relPath,
      created: result.created,
      changed: result.changed,
      sectionCount: result.sectionCount,
      headingCount,
      sha,
    }
  })
}

export async function movePageFile(
  ctx: DocsContext,
  page: DocPageRow,
  toRelPath: string,
  commit: PageCommit | false = {},
): Promise<boolean> {
  if (page.relPath === toRelPath) return false

  const from = resolveDocPath(ctx.docsRoot, page.relPath)
  const moved = existsSync(from) ? await renameDocument(from, resolveDocPath(ctx.docsRoot, toRelPath)) : false

  const fromAssets = resolveDocPath(ctx.docsRoot, assetsRelDir(page.relPath))
  if (existsSync(fromAssets)) await renameDocument(fromAssets, resolveDocPath(ctx.docsRoot, assetsRelDir(toRelPath)))

  const fromDir = page.relPath.slice(0, -3)
  const toDir = toRelPath.slice(0, -3)
  const subtree = descendantsOf(ctx.db, page.id)
  if (subtree.length > 0 && existsSync(resolveDocPath(ctx.docsRoot, fromDir))) {
    await renameDocument(resolveDocPath(ctx.docsRoot, fromDir), resolveDocPath(ctx.docsRoot, toDir))
  }
  for (const child of subtree) {
    if (child.relPath.startsWith(`${fromDir}/`)) repointPage(ctx.db, child.id, `${toDir}/${child.relPath.slice(fromDir.length + 1)}`)
  }

  repointPage(ctx.db, page.id, toRelPath)
  if (!moved && subtree.length === 0) return false
  if (commit !== false) {
    await commitDocs(
      ctx.docsRoot,
      [...pageFilePaths(page.relPath), ...pageFilePaths(toRelPath)],
      pageCommitIntent(page, toRelPath, 'move', commit),
    )
  }
  return true
}

export function checksumFor(doc: ParsedDocument): string {
  return checksumOf(renderDocument(doc))
}
