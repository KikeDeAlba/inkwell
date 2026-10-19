import { marked, type Token } from 'marked'
import { inTransaction } from '../db/open.ts'
import { deletePage, findPage, listPages, type DocPageRow } from '../db/pages.ts'
import type { DocsContext } from '../docs/context.ts'
import { insertNewPage } from '../docs/page-create.ts'
import { proposePage } from '../docs/proposals.ts'
import type { SpaceRow } from '../db/rows.ts'
import { backlogHeadings, backlogKindOf, normalizeHeading } from '../docs/backlog-extract.ts'
import { MAX_PAGE_DEPTH } from '../docs/layout.ts'
import { findSection, parseDocument } from '../docs/markdown.ts'
import { recordPageDoc } from '../docs/page-record.ts'
import { resolveDocPath } from '../docs/paths.ts'
import { readRaw } from '../docs/store.ts'
import { markAutodocPending } from '../db/autodoc-runs.ts'
import { REDACTED, sensitiveContent } from './sensitive.ts'

export const AUTODOC_BRANCH_PREFIX = 'autodoc/'

export const LOCK_CODES = new Set(['DOC_LOCKED', 'DOCS_LOCKED', 'DOCS_GIT_LOCKED'])
const RETRY_DELAYS_MS = [250, 500, 1000, 2000]
const FORBIDDEN_EXTRA = ['bitacora']
export const TITLE_MAX = 120
export const SECTION_MAX = 120
export const REASON_MAX = 300
export const MARKDOWN_MAX = 20_000
const CONTROL = /[\p{Cc}\p{Cf}]/gu
const MARKDOWN_CONTROL = /(?![\n\t])[\p{Cc}\p{Cf}]/gu
const TAG_START = /<[A-Za-z!/]/
const CODE_TOKENS = new Set(['code', 'codespan'])
const DEFAULT_PROPOSE_REASON = 'Update from a work session'
const DEFAULT_CREATE_REASON = 'New page from a work session'

export interface ShownPage {
  truncated: boolean
}

export interface AutodocRun {
  ctx: DocsContext
  space: SpaceRow
  sessionId: string
  maxActions: number
  repoSlug: string | null
  shown: ReadonlyMap<number, ShownPage>
}

export type Outcome =
  | { kind: 'propose'; pageId: number; branch: string; sha: string }
  | { kind: 'create'; pageId: number; parentId: number | null }
  | { kind: 'skip'; reason: string; detail: string }

class Skip extends Error {
  readonly reason: string

  constructor(reason: string, detail: string) {
    super(detail)
    this.reason = reason
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function oneLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const flat = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return null
  return [...flat].slice(0, max).join('').trim()
}

export function cleanMarkdown(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/\r\n?/g, '\n').replace(MARKDOWN_CONTROL, '').trim()
  return cleaned.length === 0 ? null : cleaned
}

export function safeHref(href: string): boolean {
  const trimmed = href.trim()
  if (/&#|&\w+;|%/.test(trimmed)) return false
  if (/^https?:\/\/[^\s]/i.test(trimmed) || trimmed.startsWith('#')) return true
  return !trimmed.includes(':') && !trimmed.startsWith('//') && !trimmed.startsWith('\\') && !/[\s\u0000-\u001f]/.test(trimmed)
}

function children(token: Token): Token[] {
  const record = token as unknown as Record<string, unknown>
  const nested: Token[] = []
  for (const key of ['tokens', 'items']) {
    const value = record[key]
    if (Array.isArray(value)) nested.push(...(value as Token[]))
  }
  const cells = [...(Array.isArray(record['header']) ? [record['header']] : []), ...(Array.isArray(record['rows']) ? (record['rows'] as unknown[]) : [])]
  for (const row of cells) {
    if (!Array.isArray(row)) continue
    for (const cell of row) {
      const tokens = (cell as { tokens?: unknown }).tokens
      if (Array.isArray(tokens)) nested.push(...(tokens as Token[]))
    }
  }
  return nested
}

export function unsafeMarkdown(markdown: string): string | null {
  const tokens = marked.lexer(markdown)
  for (const def of Object.values(tokens.links ?? {})) if (!safeHref(def.href)) return 'link'
  const pending: Token[] = [...tokens]
  while (pending.length > 0) {
    const token = pending.pop() as Token
    if (token.type === 'html') return 'html'
    if (token.type === 'image') return 'image'
    if ((token.type === 'link' || token.type === 'def') && !safeHref(String((token as { href?: unknown }).href ?? ''))) return 'link'
    const nested = children(token)
    const text = (token as { text?: unknown }).text
    if (nested.length === 0 && !CODE_TOKENS.has(token.type) && typeof text === 'string' && TAG_START.test(text)) return 'html'
    pending.push(...nested)
  }
  return null
}

function pageId(value: unknown): number | null {
  const id = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null
}

export function comparableTitle(title: string): string {
  return title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function isForbidden(heading: string): boolean {
  if (backlogKindOf(heading) !== null) return true
  const normalized = normalizeHeading(heading)
  return FORBIDDEN_EXTRA.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `))
}

export function forbiddenHeadings(markdown: string, section?: string): string[] {
  const doc = parseDocument(markdown)
  const found = new Set([...backlogHeadings(doc), ...doc.sections.map((item) => item.heading).filter(isForbidden)])
  if (section !== undefined && isForbidden(section)) found.add(section)
  return [...found]
}

export function sessionTag(sessionId: string): string {
  const cleaned = sessionId.toLowerCase().replace(/[^a-z0-9]/g, '')
  return (cleaned.length > 0 ? cleaned : 'session').slice(0, 8)
}

function sectionBody(markdown: string, heading: string): string {
  const lines = markdown.replace(/^\s+/, '').split('\n')
  const first = /^##\s+(.*\S)\s*$/.exec(lines[0] ?? '')
  if (first?.[1] !== undefined && comparableTitle(first[1]) === comparableTitle(heading)) return lines.slice(1).join('\n').trim()
  return markdown.trim()
}

function withTitle(markdown: string, title: string): string {
  const trimmed = markdown.trim()
  return /^#\s+\S/.test(trimmed) ? trimmed : `# ${title}\n\n${trimmed}`
}

async function retryOnLock<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      const code = (error as { code?: unknown }).code
      const delay = RETRY_DELAYS_MS[attempt]
      if (typeof code !== 'string' || !LOCK_CODES.has(code) || delay === undefined) throw error
      await new Promise((done) => setTimeout(done, delay))
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class AutodocWriter {
  readonly run: AutodocRun
  private applied = 0

  constructor(run: AutodocRun) {
    this.run = run
  }

  private spacePages(): DocPageRow[] {
    return listPages(this.run.ctx.db, this.run.space.id)
  }

  private activePages(): DocPageRow[] {
    return this.spacePages().filter((page) => page.status === 'active')
  }

  private pageInSpace(raw: unknown, field: string): DocPageRow {
    const id = pageId(raw)
    if (id === null) throw new Skip(`no-${field}`, `${field} is missing or not a page id`)
    const page = findPage(this.run.ctx.db, id)
    if (page === undefined) throw new Skip(`${field}-not-found`, `page #${id} does not exist`)
    if (page.spaceId !== this.run.space.id) throw new Skip(`${field}-outside-space`, `page #${id} belongs to another space`)
    if (page.status !== 'active') throw new Skip(`${field}-archived`, `page #${id} is archived`)
    return page
  }

  private branchFor(page: DocPageRow): string {
    return `${AUTODOC_BRANCH_PREFIX}${sessionTag(this.run.sessionId)}-${page.id}`
  }

  private screen(fields: { title?: string | null; reason: string; markdown: string; section?: string | undefined }): void {
    if (fields.markdown.length > MARKDOWN_MAX) throw new Skip('markdown-too-long', `the markdown has ${fields.markdown.length} characters`)
    const unsafe = unsafeMarkdown(fields.markdown) ?? unsafeMarkdown(`${fields.title ?? ''}\n\n${fields.reason}\n\n${fields.section ?? ''}`)
    if (unsafe !== null) throw new Skip('unsafe-markdown', `the content carries ${unsafe}`)
    const values = [fields.title ?? '', fields.reason, fields.markdown, fields.section ?? '']
    if (values.some((value) => value.includes(REDACTED))) throw new Skip('sensitive-content', 'the content carries a redacted value')
    for (const value of values) {
      const kind = value.length === 0 ? null : sensitiveContent(value)
      if (kind !== null) throw new Skip('sensitive-content', `the content carries ${kind}`)
    }
  }

  async apply(raw: unknown): Promise<Outcome> {
    if (this.applied >= this.run.maxActions) return { kind: 'skip', reason: 'max-actions', detail: `more than ${this.run.maxActions} actions` }
    try {
      const item = record(raw)
      const action = item['action']
      const outcome = action === 'propose' ? await this.propose(item) : action === 'create' ? await this.create(item) : null
      if (outcome === null) throw new Skip('unknown-action', `unknown action ${JSON.stringify(action ?? null)}`)
      this.applied += 1
      return outcome
    } catch (error) {
      if (error instanceof Skip) return { kind: 'skip', reason: error.reason, detail: error.message }
      return { kind: 'skip', reason: 'write-failed', detail: errorText(error) }
    }
  }

  private async propose(item: Record<string, unknown>): Promise<Outcome> {
    const page = this.pageInSpace(item['pageId'], 'page')
    const markdown = cleanMarkdown(item['markdown'])
    if (markdown === null) throw new Skip('empty-markdown', 'the proposal has no markdown')
    const reason = oneLine(item['reason'], REASON_MAX) ?? DEFAULT_PROPOSE_REASON
    const wanted = oneLine(item['section'], SECTION_MAX)
    const after = oneLine(item['afterSection'], SECTION_MAX)
    const shown = this.run.shown.get(page.id)
    if (shown === undefined) throw new Skip('page-not-shown', `page #${page.id} was not in the prompt`)

    let section: string | undefined
    let afterSection: string | undefined
    let body = markdown
    if (wanted !== null) {
      const current = await readRaw(resolveDocPath(this.run.ctx.docsRoot, page.relPath))
      const doc = current === null ? null : parseDocument(current)
      const existing = doc === null ? undefined : findSection(doc, wanted)
      const anchor = doc === null || after === null ? undefined : findSection(doc, after)
      if (existing !== undefined) section = existing.heading
      else if (anchor !== undefined) {
        section = wanted
        afterSection = anchor.heading
      } else throw new Skip('section-not-found', `page #${page.id} has no section "${wanted}"${after === null ? '' : ` nor "${after}"`}`)
      body = sectionBody(markdown, section)
    }
    if (section === undefined && shown.truncated) throw new Skip('page-truncated', `page #${page.id} was cut in the prompt`)
    this.screen({ reason, markdown: body, section })
    const forbidden = forbiddenHeadings(body, section)
    if (forbidden.length > 0) throw new Skip('forbidden-heading', `forbidden headings: ${forbidden.join(', ')}`)

    try {
      const { sha, branch } = await retryOnLock(() =>
        proposePage(this.run.ctx, page, {
          branch: this.branchFor(page),
          fresh: true,
          body,
          section,
          afterSection,
          reason,
          origin: { source: 'session', entryId: null, sessionId: this.run.sessionId },
        }),
      )
      return { kind: 'propose', pageId: page.id, branch, sha }
    } catch (error) {
      if ((error as { code?: unknown }).code === 'USAGE_ERROR') {
        const unchanged = /does not change/.test(errorText(error))
        throw new Skip(unchanged ? 'no-change' : 'invalid-proposal', errorText(error))
      }
      throw error
    }
  }

  private async create(item: Record<string, unknown>): Promise<Outcome> {
    const title = oneLine(item['title'], TITLE_MAX)
    if (title === null) throw new Skip('no-title', 'the new page has no title')
    const markdown = cleanMarkdown(item['markdown'])
    if (markdown === null) throw new Skip('empty-markdown', 'the new page has no markdown')
    const reason = oneLine(item['reason'], REASON_MAX) ?? DEFAULT_CREATE_REASON

    const pages = this.spacePages()
    let parent: DocPageRow | null = null
    if (this.activePages().length > 0 || pageId(item['parentId']) !== null) {
      parent = this.pageInSpace(item['parentId'], 'parent')
      if (parent.depth + 1 > MAX_PAGE_DEPTH) throw new Skip('too-deep', `a child of #${parent.id} would go past ${MAX_PAGE_DEPTH + 1} levels`)
    }
    const wanted = comparableTitle(title)
    const twin = pages.find((page) => comparableTitle(page.title) === wanted)
    if (twin !== undefined) throw new Skip('duplicate-title', `"${title}" repeats page #${twin.id}`)

    const body = withTitle(markdown, title)
    this.screen({ title, reason, markdown: body })
    const forbidden = forbiddenHeadings(body)
    if (forbidden.length > 0) throw new Skip('forbidden-heading', `forbidden headings: ${forbidden.join(', ')}`)

    const ctx = this.run.ctx
    const page = inTransaction(ctx.db, () => {
      const inserted = insertNewPage(ctx, { title, spaceId: this.run.space.id, parent, source: 'autodoc', repoSlug: this.run.repoSlug })
      markAutodocPending(ctx.db, inserted.id, this.run.sessionId, ctx.now.toISOString())
      return inserted
    })
    try {
      await retryOnLock(() =>
        recordPageDoc(ctx, page, { body }, { source: 'session', reason, trailers: { 'Inkwell-Session': this.run.sessionId } }),
      )
    } catch (error) {
      deletePage(ctx.db, page.id)
      throw error
    }
    return { kind: 'create', pageId: page.id, parentId: parent?.id ?? null }
  }
}

export function describeOutcome(outcome: Outcome): string {
  if (outcome.kind === 'propose') return `propose:${outcome.pageId}@${outcome.branch}`
  if (outcome.kind === 'create') return `create:${outcome.pageId}<${outcome.parentId ?? 'root'}`
  return `skip:${outcome.reason}`
}
