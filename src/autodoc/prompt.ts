import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { listPages, type DocPageRow } from '../db/pages.ts'
import { MAX_PAGE_DEPTH } from '../docs/layout.ts'
import { parseDocument, stripFrontMatter } from '../docs/markdown.ts'
import { resolveDocPath } from '../docs/paths.ts'
import { readRaw } from '../docs/store.ts'
import { searchPages } from '../docs/page-search.ts'
import { PACKAGE_ROOT } from '../version.ts'
import { redactSensitive } from './sensitive.ts'

export const PROMPT_TEMPLATE = path.join(PACKAGE_ROOT, 'assets', 'autodoc-prompt.md')

export interface TreePage {
  page: DocPageRow
  headings: string[]
}

export async function spaceTree(db: DatabaseSync, docsRoot: string, spaceId: number): Promise<TreePage[]> {
  const pages = listPages(db, spaceId).filter((page) => page.status === 'active')
  const byParent = new Map<number | null, DocPageRow[]>()
  for (const page of pages) byParent.set(page.parentId, [...(byParent.get(page.parentId) ?? []), page])
  const ids = new Set(pages.map((page) => page.id))
  const ordered: DocPageRow[] = []
  const walk = (parentId: number | null): void => {
    for (const page of (byParent.get(parentId) ?? []).sort((a, b) => a.position - b.position || a.id - b.id)) {
      ordered.push(page)
      walk(page.id)
    }
  }
  walk(null)
  for (const page of pages) if (page.parentId !== null && !ids.has(page.parentId) && !ordered.includes(page)) ordered.push(page)

  const tree: TreePage[] = []
  for (const page of ordered) {
    const raw = await readRaw(resolveDocPath(docsRoot, page.relPath))
    tree.push({ page, headings: raw === null ? [] : parseDocument(raw).sections.map((section) => section.heading) })
  }
  return tree
}

export function renderTree(tree: readonly TreePage[]): string {
  if (tree.length === 0) return '(el espacio no tiene páginas todavía)'
  return tree
    .map(({ page, headings }) => {
      const indent = '  '.repeat(page.depth)
      const h2 = headings.length === 0 ? '' : ` | H2: ${headings.map((heading) => `«${heading}»`).join(', ')}`
      return `${indent}- id=${page.id} «${page.title}» parentId=${page.parentId ?? 'null'} profundidad=${page.depth} ruta=${page.relPath}${h2}`
    })
    .join('\n')
}

export const PAGE_CONTENT_MAX = 6_000
export const PAGES_CONTENT_MAX = 30_000
const CANDIDATES_MAX = 12
const SEARCH_TERMS = 10
const TERM = /[\p{L}\p{N}_-]{6,}/gu

export interface CandidatePage {
  page: DocPageRow
  content: string
  truncated: boolean
}

export function searchTerms(conversation: string, limit = SEARCH_TERMS): string[] {
  const counts = new Map<string, number>()
  for (const match of conversation.toLowerCase().matchAll(TERM)) {
    const word = match[0]
    if (/^[0-9_-]+$/.test(word) || word === 'assistant') continue
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([word]) => word)
}

export async function candidatePages(
  db: DatabaseSync,
  docsRoot: string,
  spaceId: number,
  tree: readonly TreePage[],
  conversation: string,
  repoSlug: string | null,
): Promise<CandidatePage[]> {
  const scores = new Map<number, number>()
  for (const term of searchTerms(conversation)) {
    const found = await searchPages(db, docsRoot, term, { projectId: spaceId, maxPerPage: 1 }).catch(() => null)
    for (const hit of found?.hits ?? []) scores.set(hit.pageId, (scores.get(hit.pageId) ?? 0) + 1)
  }
  const pages = tree.map((item) => item.page)
  const ranked = [
    ...pages.filter((page) => scores.has(page.id)).sort((left, right) => (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0)),
    ...pages.filter((page) => repoSlug !== null && page.repoSlug === repoSlug),
    ...[...pages].sort((left, right) => left.depth - right.depth),
  ]
  const chosen: CandidatePage[] = []
  const seen = new Set<number>()
  let budget = PAGES_CONTENT_MAX
  for (const page of ranked) {
    if (seen.has(page.id) || chosen.length >= CANDIDATES_MAX || budget <= 0) continue
    seen.add(page.id)
    const raw = await readRaw(resolveDocPath(docsRoot, page.relPath))
    if (raw === null) continue
    const body = redactSensitive(stripFrontMatter(raw))
    const limit = Math.min(PAGE_CONTENT_MAX, budget)
    const truncated = body.length > limit
    const content = truncated ? body.slice(0, limit) : body
    budget -= content.length
    chosen.push({ page, content, truncated })
  }
  return chosen
}

export function renderCandidates(candidates: readonly CandidatePage[]): string {
  if (candidates.length === 0) return '(ninguna)'
  return candidates
    .map(({ page, content, truncated }) => `<page id="${page.id}"${truncated ? ' recortada="sí"' : ''}>\n${content}\n</page>`)
    .join('\n\n')
}

export interface PromptInput {
  spaceName: string
  tree: readonly TreePage[]
  candidates: readonly CandidatePage[]
  conversation: string
  maxActions: number
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
}

export async function buildPrompt(input: PromptInput): Promise<string> {
  const template = await readFile(PROMPT_TEMPLATE, 'utf8')
  return fillTemplate(template, {
    space: input.spaceName,
    max_actions: String(input.maxActions),
    max_parent_depth: String(MAX_PAGE_DEPTH - 1),
    tree: renderTree(input.tree),
    pages: renderCandidates(input.candidates),
    conversation: input.conversation.trim(),
  })
}
