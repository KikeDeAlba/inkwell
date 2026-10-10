import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { clearOriginRef, repointOriginRef } from '../../db/backlog.ts'
import { inTransaction } from '../../db/open.ts'
import { entryRef, linkEntryToPage, linksOfRef, mergeEntryLinks, refreshEntrySnapshot, removeEntryLinks, type EntrySnapshot } from '../../db/page-links.ts'
import { findPage } from '../../db/pages.ts'
import { UsageError } from '../../errors.ts'
import { findBita, snapshotOf, toBitaEntry } from '../../integrations/bita.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString } from '../args.ts'
import { withLocalContext } from '../context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'

const OPTIONS = { file: { type: 'string' as const } }

export interface HookOutcome {
  event: string
  entryId: number | null
  linksRemoved: number
  linksMerged: number
  linksRefreshed: number
  linksAdded: number
  backlogUpdated: number
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function ids(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : Number(record(item)['id'])))
    .filter((item) => Number.isInteger(item) && item > 0)
}

function mergedSources(document: Record<string, unknown>, entry: Record<string, unknown>): number[] {
  for (const key of ['sources', 'sourceIds', 'mergedIds', 'merged', 'segmentIds']) {
    const found = ids(document[key])
    if (found.length > 0) return found
  }
  return ids(entry['segments'])
}

function snapshotFromEvent(entry: Record<string, unknown>): EntrySnapshot | null {
  const parsed = toBitaEntry(entry)
  return parsed === null ? null : snapshotOf(parsed)
}

export async function handleBitaEvent(db: DatabaseSync, document: Record<string, unknown>, now: Date): Promise<HookOutcome> {
  const event = typeof document['event'] === 'string' ? document['event'] : process.env['KIT_EVENT'] ?? ''
  const entry = record(document['entry'])
  const entryId = Number.isInteger(entry['id']) ? (entry['id'] as number) : null
  const outcome: HookOutcome = { event, entryId, linksRemoved: 0, linksMerged: 0, linksRefreshed: 0, linksAdded: 0, backlogUpdated: 0 }
  if (entryId === null) return outcome
  const at = now.toISOString()

  if (event === 'delete' || event === 'cancel') {
    inTransaction(db, () => {
      outcome.linksRemoved = removeEntryLinks(db, entryId).length
      outcome.backlogUpdated = clearOriginRef(db, entryRef(entryId))
    })
    return outcome
  }

  if (event === 'merge') {
    const sources = mergedSources(document, entry).filter((id) => id !== entryId)
    inTransaction(db, () => {
      outcome.linksMerged = mergeEntryLinks(db, sources, entryId, at).length
      for (const source of sources) outcome.backlogUpdated += repointOriginRef(db, entryRef(source), entryRef(entryId))
    })
    const bita = await findBita()
    const fresh = bita === null ? null : await bita.entry(entryId).catch(() => null)
    const snapshot = fresh === null ? snapshotFromEvent(entry) : snapshotOf(fresh, now)
    if (snapshot !== null) outcome.linksRefreshed = refreshEntrySnapshot(db, entryId, snapshot, at)
    return outcome
  }

  if (event === 'start' || event === 'stop' || event === 'amend') {
    const snapshot = snapshotFromEvent(entry)
    inTransaction(db, () => {
      if (snapshot !== null) outcome.linksRefreshed = refreshEntrySnapshot(db, entryId, snapshot, at)
      const linked = new Set(linksOfRef(db, entryRef(entryId)).map((link) => link.pageId))
      for (const pageId of ids(document['pageIds'])) {
        if (linked.has(pageId) || findPage(db, pageId) === undefined) continue
        linkEntryToPage(db, pageId, entryId, '', at, snapshot ?? {})
        outcome.linksAdded += 1
      }
    })
  }
  return outcome
}

export async function runBitaHook(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, OPTIONS, BASE_OPTIONS)
  const file = readString(args, 'file')
  const raw = file !== undefined ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')
  let document: Record<string, unknown>
  try {
    document = record(JSON.parse(raw) as unknown)
  } catch {
    throw new UsageError('bita-hook expects the event document as JSON on stdin.')
  }
  const outcome = await withLocalContext(args, (ctx) => handleBitaEvent(ctx.db, document, ctx.now))
  if (readBoolean(args, 'json')) writeJson(successEnvelope('bita-hook', outcome))
  else writeOut(`${outcome.event} #${outcome.entryId ?? '?'}: removed ${outcome.linksRemoved}, merged ${outcome.linksMerged}, refreshed ${outcome.linksRefreshed}, added ${outcome.linksAdded}`)
  return 0
}
