import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { fireEvents } from '@kikedealba/kit/events'
import { platformContext, toolDirs } from '@kikedealba/kit/platform'

export const DOCS_CHANGED_EVENT = 'docs.changed'
export const EVENTS_LOG_NAME = 'events.log'

export type DocsChangeAction = 'written' | 'deleted' | 'moved'
export type DocsChangeKind = 'page' | 'entry' | 'mixed'

export interface DocsChange {
  action: DocsChangeAction
  relPath: string
  from?: string
}

export interface DocsChangedEvent {
  docsRoot: string
  commit: string | null
  changes: DocsChange[]
}

export type DocsEventSink = (event: DocsChangedEvent, kind: DocsChangeKind) => Promise<void>

interface Batch {
  pending: Map<string, { commit: string | null; changes: DocsChange[] }>
}

const batches = new AsyncLocalStorage<Batch>()
let sinkOverride: DocsEventSink | null = null

const ENTRY_NOTE_PATH = /^[^/]+\/\d{4}\/\d{2}\/\d{2}-\d+-[^/]*\.md$/

export function isEntryNotePath(relPath: string): boolean {
  return ENTRY_NOTE_PATH.test(relPath)
}

export function isDocsMarkdown(relPath: string): boolean {
  if (!relPath.toLowerCase().endsWith('.md')) return false
  return !relPath.split('/').slice(0, -1).some((segment) => segment.endsWith('.assets'))
}

export function changeKind(changes: readonly DocsChange[]): DocsChangeKind {
  const kinds = new Set(changes.map((change) => (isEntryNotePath(change.relPath) ? 'entry' : 'page')))
  if (kinds.size === 1) return kinds.has('entry') ? 'entry' : 'page'
  return 'mixed'
}

export function parseNameStatus(output: string): DocsChange[] {
  const fields = output.split('\0')
  const changes: DocsChange[] = []
  let index = 0
  while (index < fields.length) {
    const status = fields[index] ?? ''
    index += 1
    if (status.length === 0) continue
    const code = status.charAt(0)
    if (code === 'R' || code === 'C') {
      const from = fields[index] ?? ''
      const to = fields[index + 1] ?? ''
      index += 2
      const fromDoc = isDocsMarkdown(from)
      const toDoc = isDocsMarkdown(to)
      if (code === 'R' && fromDoc && toDoc) changes.push({ action: 'moved', relPath: to, from })
      else {
        if (code === 'R' && fromDoc) changes.push({ action: 'deleted', relPath: from })
        if (toDoc) changes.push({ action: 'written', relPath: to })
      }
      continue
    }
    const path = fields[index] ?? ''
    index += 1
    if (!isDocsMarkdown(path)) continue
    changes.push({ action: code === 'D' ? 'deleted' : 'written', relPath: path })
  }
  return changes
}

export function mergeChanges(current: readonly DocsChange[], next: readonly DocsChange[]): DocsChange[] {
  const byPath = new Map<string, DocsChange>()
  for (const change of current) byPath.set(change.relPath, change)
  const put = (change: DocsChange): void => {
    byPath.delete(change.relPath)
    byPath.set(change.relPath, change)
  }

  for (const change of next) {
    const existing = byPath.get(change.relPath)
    if (change.action === 'written') {
      put(existing?.action === 'moved' ? existing : change)
      continue
    }
    if (change.action === 'deleted') {
      if (existing?.action === 'moved' && existing.from !== undefined) {
        byPath.delete(change.relPath)
        put({ action: 'deleted', relPath: existing.from })
      } else put(change)
      continue
    }
    const source = change.from === undefined ? undefined : byPath.get(change.from)
    let origin = change.from
    if (source !== undefined && change.from !== undefined) {
      byPath.delete(change.from)
      if (source.action === 'moved') origin = source.from
    }
    if (origin === undefined || origin === change.relPath) put({ action: 'written', relPath: change.relPath })
    else put({ action: 'moved', relPath: change.relPath, from: origin })
  }
  return [...byPath.values()]
}

export function setDocsEventSink(sink: DocsEventSink | null): DocsEventSink | null {
  const previous = sinkOverride
  sinkOverride = sink
  return previous
}

export function eventsLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolDirs('inkwell', platformContext({ env })).state, EVENTS_LOG_NAME)
}

async function fireDocsChanged(event: DocsChangedEvent, kind: DocsChangeKind): Promise<void> {
  await fireEvents(
    [
      {
        tool: 'inkwell',
        event: DOCS_CHANGED_EVENT,
        attributes: { kind: [kind] },
        document: { docsRoot: event.docsRoot, commit: event.commit, changes: event.changes },
      },
    ],
    { logPath: eventsLogPath() },
  )
}

function warnEmit(error: unknown): void {
  process.stderr.write(
    `Warning: the docs change was committed, but ${DOCS_CHANGED_EVENT} could not be emitted: ${error instanceof Error ? error.message : String(error)}\n`,
  )
}

async function deliver(event: DocsChangedEvent): Promise<void> {
  if (event.changes.length === 0) return
  try {
    await (sinkOverride ?? fireDocsChanged)(event, changeKind(event.changes))
  } catch (error) {
    warnEmit(error)
  }
}

export async function emitDocsChanged(event: DocsChangedEvent): Promise<void> {
  if (event.changes.length === 0) return
  const batch = batches.getStore()
  if (batch === undefined) {
    await deliver(event)
    return
  }
  const pending = batch.pending.get(event.docsRoot)
  batch.pending.set(event.docsRoot, {
    commit: event.commit ?? pending?.commit ?? null,
    changes: mergeChanges(pending?.changes ?? [], event.changes),
  })
}

export async function withEventBatch<T>(fn: () => Promise<T>): Promise<T> {
  if (batches.getStore() !== undefined) return fn()
  const batch: Batch = { pending: new Map() }
  try {
    return await batches.run(batch, fn)
  } finally {
    for (const [docsRoot, pending] of batch.pending) {
      await deliver({ docsRoot, commit: pending.commit, changes: pending.changes })
    }
  }
}
