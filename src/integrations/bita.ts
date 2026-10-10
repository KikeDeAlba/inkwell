import { findTool, invokeTool, type FoundTool } from '@kikedealba/kit/registry'
import { ConflictError, NotFoundError } from '../errors.ts'
import type { EntrySnapshot } from '../db/page-links.ts'

export const BITA_INSTALL_HINT = 'npm install -g @kikedealba/bita && bita setup'

export interface BitaEntry {
  id: number
  description: string
  kind: string | null
  projectId: number | null
  projectName: string | null
  startedAt: string
  stoppedAt: string | null
  note: string | null
  issueKey: string | null
  durationSeconds: number | null
}

export interface BitaClient {
  entry(id: number): Promise<BitaEntry | null>
  running(): Promise<BitaEntry[]>
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

export function toBitaEntry(raw: unknown): BitaEntry | null {
  const data = record(raw)
  const id = integer(data['id'])
  if (id === null) return null
  const startedAt = text(data['startedAt']) ?? text(data['start'])
  if (startedAt === null) return null
  const stoppedAt = text(data['stoppedAt']) ?? text(data['stop'])
  const duration = integer(data['durationSeconds'])
  return {
    id,
    description: text(data['description']) ?? '',
    kind: text(data['kind']),
    projectId: integer(data['projectId']),
    projectName: text(data['projectName']),
    startedAt,
    stoppedAt,
    note: text(data['note']),
    issueKey: text(data['issueKey']),
    durationSeconds: stoppedAt === null ? null : duration,
  }
}

export class CliBita implements BitaClient {
  readonly tool: FoundTool

  constructor(tool: FoundTool) {
    this.tool = tool
  }

  async entry(id: number): Promise<BitaEntry | null> {
    const { envelope } = await invokeTool(this.tool, ['entries', 'get', String(id)], { timeoutMs: 30_000 })
    if (!envelope.ok) {
      const code = envelope.error?.code ?? ''
      if (/NOT_FOUND/.test(code)) return null
      throw new ConflictError(`bita entries get ${id}: ${envelope.error?.message ?? 'failed'}`, 'BITA_FAILED', envelope.error?.hint)
    }
    return toBitaEntry(envelope.data)
  }

  async running(): Promise<BitaEntry[]> {
    const { envelope } = await invokeTool(this.tool, ['running'], { timeoutMs: 30_000 })
    if (!envelope.ok || !Array.isArray(envelope.data)) return []
    return envelope.data.map(toBitaEntry).filter((entry): entry is BitaEntry => entry !== null)
  }
}

let override: BitaClient | null | undefined

export function setBitaClient(client: BitaClient | null | undefined): void {
  override = client
}

export async function findBita(): Promise<BitaClient | null> {
  if (override !== undefined) return override
  const tool = await findTool('bita', { capability: 'time.entries.read' })
  return tool ? new CliBita(tool) : null
}

export async function requireBita(): Promise<BitaClient> {
  const bita = await findBita()
  if (bita) return bita
  throw new ConflictError('bita is not installed (or it is too old to answer "entries get"), and the entries live there.', 'BITA_MISSING', BITA_INSTALL_HINT)
}

export async function requireEntry(bita: BitaClient, id: number): Promise<BitaEntry> {
  const entry = await bita.entry(id)
  if (!entry) throw new NotFoundError(`No entry #${id} in bita.`, 'ENTRY_NOT_FOUND')
  return entry
}

export function entryDuration(entry: Pick<BitaEntry, 'startedAt' | 'stoppedAt' | 'durationSeconds'>, now: Date = new Date()): number {
  if (entry.durationSeconds !== null) return entry.durationSeconds
  const end = entry.stoppedAt === null ? now.getTime() : Date.parse(entry.stoppedAt)
  return Math.max(0, Math.round((end - Date.parse(entry.startedAt)) / 1000))
}

export function snapshotOf(entry: BitaEntry, now: Date = new Date()): EntrySnapshot {
  return {
    title: entry.description,
    entryKind: entry.kind,
    startedAt: entry.startedAt,
    stoppedAt: entry.stoppedAt,
    durationSeconds: entry.stoppedAt === null ? null : entryDuration(entry, now),
    worklogIssues: entry.issueKey ? [entry.issueKey] : [],
  }
}
