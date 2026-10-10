import type { DatabaseSync } from 'node:sqlite'
import { MEETING_KINDS } from '../config/constants.ts'
import { UsageError } from '../errors.ts'
import { queryAll } from './query.ts'

export type PageIssueRole = 'epic' | 'story' | 'task' | 'subtask'
export type StatusCategory = '' | 'new' | 'indeterminate' | 'done'
export type LinkKind = 'entry' | 'issue' | 'other'

export const ROLES: readonly PageIssueRole[] = ['epic', 'story', 'task', 'subtask']
export const CATEGORIES: readonly StatusCategory[] = ['', 'new', 'indeterminate', 'done']

const ENTRY_REF = /^bita:entry:([1-9][0-9]*)$/
const ISSUE_REF = /^jira:([A-Z][A-Z0-9_]*-[0-9]+)$/

export function entryRef(entryId: number): string {
  return `bita:entry:${entryId}`
}

export function issueRef(issueKey: string): string {
  return `jira:${issueKey}`
}

export function entryIdOf(ref: string | null | undefined): number | null {
  const match = ref ? ENTRY_REF.exec(ref) : null
  return match ? Number(match[1]) : null
}

export function issueKeyOf(ref: string | null | undefined): string | null {
  const match = ref ? ISSUE_REF.exec(ref) : null
  return match ? (match[1] ?? null) : null
}

export function linkKindOf(ref: string): LinkKind {
  if (ENTRY_REF.test(ref)) return 'entry'
  if (ISSUE_REF.test(ref)) return 'issue'
  return 'other'
}

export interface EntrySnapshot {
  title?: string | undefined
  entryKind?: string | null | undefined
  startedAt?: string | null | undefined
  stoppedAt?: string | null | undefined
  durationSeconds?: number | null | undefined
  worklogIssues?: readonly string[] | undefined
}

export interface PageLinkRow {
  pageId: number
  ref: string
  kind: LinkKind
  role: PageIssueRole | ''
  summary: string
  title: string
  status: string
  statusCategory: StatusCategory
  url: string | null
  entryKind: string | null
  startedAt: string | null
  stoppedAt: string | null
  durationSeconds: number | null
  worklogIssues: string[]
  linkedAt: string
  refreshedAt: string | null
}

interface RawLink {
  page_id: number
  ref: string
  kind: LinkKind
  role: PageIssueRole | ''
  summary: string
  title: string
  status: string
  status_category: StatusCategory
  url: string | null
  entry_kind: string | null
  started_at: string | null
  stopped_at: string | null
  duration_seconds: number | null
  worklog_issues: string
  linked_at: string
  refreshed_at: string | null
}

function parseIssues(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function toLink(raw: RawLink): PageLinkRow {
  return {
    pageId: raw.page_id,
    ref: raw.ref,
    kind: raw.kind,
    role: raw.role,
    summary: raw.summary,
    title: raw.title,
    status: raw.status,
    statusCategory: raw.status_category,
    url: raw.url,
    entryKind: raw.entry_kind,
    startedAt: raw.started_at,
    stoppedAt: raw.stopped_at,
    durationSeconds: raw.duration_seconds,
    worklogIssues: parseIssues(raw.worklog_issues),
    linkedAt: raw.linked_at,
    refreshedAt: raw.refreshed_at,
  }
}

export function linkDuration(link: Pick<PageLinkRow, 'startedAt' | 'stoppedAt' | 'durationSeconds'>, now: Date = new Date()): number {
  if (link.durationSeconds !== null && link.durationSeconds !== undefined && link.stoppedAt !== null) return link.durationSeconds
  if (link.startedAt === null) return link.durationSeconds ?? 0
  const end = link.stoppedAt === null ? now.getTime() : Date.parse(link.stoppedAt)
  return Math.max(0, Math.round((end - Date.parse(link.startedAt)) / 1000))
}

export function linkEntryToPage(db: DatabaseSync, pageId: number, entryId: number, summary: string, now: string, snapshot: EntrySnapshot = {}): void {
  db.prepare(
    `INSERT INTO page_links (page_id, ref, kind, summary, title, entry_kind, started_at, stopped_at, duration_seconds, worklog_issues, linked_at, refreshed_at)
     VALUES (?, ?, 'entry', ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (page_id, ref) DO UPDATE SET
       summary = CASE WHEN excluded.summary = '' THEN page_links.summary ELSE excluded.summary END,
       title = CASE WHEN excluded.title = '' THEN page_links.title ELSE excluded.title END,
       entry_kind = COALESCE(excluded.entry_kind, page_links.entry_kind),
       started_at = COALESCE(excluded.started_at, page_links.started_at),
       stopped_at = CASE WHEN excluded.refreshed_at IS NULL THEN page_links.stopped_at ELSE excluded.stopped_at END,
       duration_seconds = COALESCE(excluded.duration_seconds, page_links.duration_seconds),
       worklog_issues = CASE WHEN excluded.worklog_issues = '[]' THEN page_links.worklog_issues ELSE excluded.worklog_issues END,
       refreshed_at = COALESCE(excluded.refreshed_at, page_links.refreshed_at)`,
  ).run(
    pageId,
    entryRef(entryId),
    summary,
    snapshot.title ?? '',
    snapshot.entryKind ?? null,
    snapshot.startedAt ?? null,
    snapshot.stoppedAt ?? null,
    snapshot.durationSeconds ?? null,
    JSON.stringify(snapshot.worklogIssues ?? []),
    now,
    snapshot.startedAt !== undefined ? now : null,
  )
}

export function refreshEntrySnapshot(db: DatabaseSync, entryId: number, snapshot: EntrySnapshot, now: string): number {
  const sets = ['refreshed_at = ?']
  const values: (string | number | null)[] = [now]
  if (snapshot.title !== undefined) {
    sets.push('title = ?')
    values.push(snapshot.title)
  }
  if (snapshot.entryKind !== undefined) {
    sets.push('entry_kind = ?')
    values.push(snapshot.entryKind)
  }
  if (snapshot.startedAt !== undefined) {
    sets.push('started_at = ?')
    values.push(snapshot.startedAt)
  }
  if (snapshot.stoppedAt !== undefined) {
    sets.push('stopped_at = ?')
    values.push(snapshot.stoppedAt)
  }
  if (snapshot.durationSeconds !== undefined) {
    sets.push('duration_seconds = ?')
    values.push(snapshot.durationSeconds)
  }
  if (snapshot.worklogIssues !== undefined && snapshot.worklogIssues.length > 0) {
    sets.push('worklog_issues = ?')
    values.push(JSON.stringify(snapshot.worklogIssues))
  }
  return Number(db.prepare(`UPDATE page_links SET ${sets.join(', ')} WHERE ref = ?`).run(...values, entryRef(entryId)).changes)
}

export function unlinkEntryFromPage(db: DatabaseSync, pageId: number, entryId: number): void {
  db.prepare('DELETE FROM page_links WHERE page_id = ? AND ref = ?').run(pageId, entryRef(entryId))
}

export function removeEntryLinks(db: DatabaseSync, entryId: number): number[] {
  const pages = queryAll<{ page_id: number }>(db.prepare('SELECT page_id FROM page_links WHERE ref = ?'), entryRef(entryId)).map((row) => row.page_id)
  db.prepare('DELETE FROM page_links WHERE ref = ?').run(entryRef(entryId))
  return pages
}

export function linksOfPage(db: DatabaseSync, pageId: number): PageLinkRow[] {
  return queryAll<RawLink>(db.prepare('SELECT * FROM page_links WHERE page_id = ? ORDER BY linked_at, ref'), pageId).map(toLink)
}

export function linksOfRef(db: DatabaseSync, ref: string): PageLinkRow[] {
  return queryAll<RawLink>(db.prepare('SELECT * FROM page_links WHERE ref = ? ORDER BY linked_at, page_id'), ref).map(toLink)
}

export interface PageEntryRow {
  pageId: number
  entryId: number
  summary: string
  linkedAt: string
}

export function pagesOfEntry(db: DatabaseSync, entryId: number): PageEntryRow[] {
  return linksOfRef(db, entryRef(entryId)).map((link) => ({ pageId: link.pageId, entryId, summary: link.summary, linkedAt: link.linkedAt }))
}

export function entryLinksOfPage(db: DatabaseSync, pageId: number): PageLinkRow[] {
  return queryAll<RawLink>(
    db.prepare(`SELECT * FROM page_links WHERE page_id = ? AND kind = 'entry' ORDER BY IFNULL(started_at, linked_at) DESC`),
    pageId,
  ).map(toLink)
}

export interface NewPageIssue {
  pageId: number
  issueKey: string
  role?: PageIssueRole
  summary?: string
  status?: string
  statusCategory?: StatusCategory
  url?: string | null
  now: string
}

export function linkIssueToPage(db: DatabaseSync, issue: NewPageIssue): void {
  if (issueKeyOf(issueRef(issue.issueKey)) === null) throw new UsageError(`"${issue.issueKey}" is not a Jira issue key.`)
  db.prepare(
    `INSERT INTO page_links (page_id, ref, kind, role, summary, status, status_category, url, linked_at, refreshed_at)
     VALUES (?, ?, 'issue', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (page_id, ref) DO UPDATE SET
       role = excluded.role,
       summary = CASE WHEN excluded.summary = '' THEN page_links.summary ELSE excluded.summary END,
       status = CASE WHEN excluded.status = '' THEN page_links.status ELSE excluded.status END,
       status_category = CASE WHEN excluded.status_category = '' THEN page_links.status_category ELSE excluded.status_category END,
       url = COALESCE(excluded.url, page_links.url),
       refreshed_at = excluded.refreshed_at`,
  ).run(
    issue.pageId,
    issueRef(issue.issueKey),
    issue.role ?? 'task',
    issue.summary ?? '',
    issue.status ?? '',
    issue.statusCategory ?? '',
    issue.url ?? null,
    issue.now,
    issue.now,
  )
}

export function unlinkIssueFromPage(db: DatabaseSync, pageId: number, issueKey: string): void {
  db.prepare('DELETE FROM page_links WHERE page_id = ? AND ref = ?').run(pageId, issueRef(issueKey))
}

export interface PageIssueRow {
  pageId: number
  issueKey: string
  role: PageIssueRole
  summary: string
  status: string
  statusCategory: StatusCategory
  url: string | null
  createdAt: string
  refreshedAt: string | null
}

export function issuesOfPage(db: DatabaseSync, pageId: number): PageIssueRow[] {
  return queryAll<RawLink>(db.prepare(`SELECT * FROM page_links WHERE page_id = ? AND kind = 'issue' ORDER BY ref`), pageId)
    .map(toLink)
    .map((link) => ({
      pageId: link.pageId,
      issueKey: issueKeyOf(link.ref) ?? link.ref,
      role: (link.role === '' ? 'task' : link.role) as PageIssueRole,
      summary: link.summary,
      status: link.status,
      statusCategory: link.statusCategory,
      url: link.url,
      createdAt: link.linkedAt,
      refreshedAt: link.refreshedAt,
    }))
}

export function worklogIssuesOfPage(db: DatabaseSync, pageId: number): string[] {
  const keys = new Set<string>()
  for (const link of entryLinksOfPage(db, pageId)) for (const key of link.worklogIssues) keys.add(key)
  return [...keys].sort()
}

export interface PageTally {
  pageId: number
  entryCount: number
  durationSeconds: number
  issueCount: number
}

export function talliesByPage(db: DatabaseSync, now: Date = new Date()): Map<number, PageTally> {
  const tallies = new Map<number, PageTally>()
  const rows = queryAll<RawLink>(db.prepare(`SELECT * FROM page_links WHERE kind IN ('entry', 'issue')`)).map(toLink)
  for (const link of rows) {
    const tally = tallies.get(link.pageId) ?? { pageId: link.pageId, entryCount: 0, durationSeconds: 0, issueCount: 0 }
    if (link.kind === 'entry') {
      tally.entryCount += 1
      tally.durationSeconds += linkDuration(link, now)
    } else {
      tally.issueCount += 1
    }
    tallies.set(link.pageId, tally)
  }
  return tallies
}

export interface PageMeeting {
  entryId: number
  kind: string
  startedAt: string
  stoppedAt: string | null
  durationSeconds: number
}

export function meetingsOfPage(db: DatabaseSync, pageId: number, now: Date = new Date()): PageMeeting[] {
  return queryAll<RawLink>(
    db.prepare(
      `SELECT * FROM page_links
       WHERE page_id = ? AND kind = 'entry' AND entry_kind IN (${MEETING_KINDS.map(() => '?').join(', ')}) AND started_at IS NOT NULL
       ORDER BY started_at`,
    ),
    pageId,
    ...MEETING_KINDS,
  )
    .map(toLink)
    .map((link) => ({
      entryId: entryIdOf(link.ref) ?? 0,
      kind: link.entryKind ?? '',
      startedAt: link.startedAt ?? '',
      stoppedAt: link.stoppedAt,
      durationSeconds: link.stoppedAt === null ? 0 : linkDuration(link, now),
    }))
}

export function mergeEntryLinks(db: DatabaseSync, sources: readonly number[], targetId: number, now: string): number[] {
  const pageIds = new Set<number>()
  const everyone = [targetId, ...sources.filter((id) => id !== targetId)]
  const summaries = new Map<number, string[]>()
  const issues = new Map<number, Set<string>>()
  for (const id of everyone) {
    for (const link of linksOfRef(db, entryRef(id))) {
      pageIds.add(link.pageId)
      if (link.summary.trim().length > 0) summaries.set(link.pageId, [...(summaries.get(link.pageId) ?? []), link.summary.trim()])
      const set = issues.get(link.pageId) ?? new Set<string>()
      for (const key of link.worklogIssues) set.add(key)
      issues.set(link.pageId, set)
    }
  }
  for (const id of sources) {
    if (id === targetId) continue
    db.prepare('DELETE FROM page_links WHERE ref = ?').run(entryRef(id))
  }
  for (const pageId of pageIds) {
    const summary = [...new Set(summaries.get(pageId) ?? [])].join(' / ')
    linkEntryToPage(db, pageId, targetId, summary, now, { worklogIssues: [...(issues.get(pageId) ?? [])].sort() })
  }
  return [...pageIds]
}
