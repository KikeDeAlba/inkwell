import type { DatabaseSync } from 'node:sqlite'
import { ancestorsOf, insertPage, requirePage, uniqueSiblingSlug, type DocPageRow } from '../db/pages.ts'
import { findSpaceById } from '../db/spaces.ts'
import { UsageError } from '../errors.ts'
import type { DocsContext } from './context.ts'
import { MAX_PAGE_DEPTH, pageRelPath } from './layout.ts'
import { titleSlug } from './slug.ts'

export function newPageRelPath(db: DatabaseSync, spaceId: number | null, parent: DocPageRow | null, slug: string): string {
  const ancestors = parent ? [...ancestorsOf(db, parent.id).map((row) => row.slug), parent.slug] : []
  const projectName = spaceId === null ? null : (findSpaceById(db, spaceId)?.name ?? null)
  return pageRelPath({ projectName, ancestorSlugs: ancestors, slug })
}

export interface NewPageRequest {
  title: string
  spaceId: number | null
  parent: DocPageRow | null
  slug?: string | undefined
  source: string
  repoSlug?: string | null | undefined
}

export function insertNewPage(ctx: DocsContext, request: NewPageRequest): DocPageRow {
  const { parent } = request
  const depth = parent ? parent.depth + 1 : 0
  if (depth > MAX_PAGE_DEPTH) {
    throw new UsageError(`A page tree cannot go deeper than ${MAX_PAGE_DEPTH + 1} levels.`)
  }

  const wanted = request.slug ?? titleSlug(request.title)
  const slug = uniqueSiblingSlug(ctx.db, request.spaceId, parent?.id ?? null, titleSlug(wanted))
  const relPath = newPageRelPath(ctx.db, request.spaceId, parent, slug)

  const id = insertPage(ctx.db, {
    spaceId: request.spaceId,
    parentId: parent?.id ?? null,
    slug,
    title: request.title.trim(),
    relPath,
    depth,
    source: request.source,
    repoSlug: request.repoSlug ?? null,
    now: ctx.now.toISOString(),
  })
  return requirePage(ctx.db, id)
}

