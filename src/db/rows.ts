export type ConfluenceKind = 'space' | 'page'

export interface SpaceRow {
  id: number
  name: string
  key: string | null
  externalRef: string | null
  clientName: string | null
  active: boolean
  createdAt: string
  atlassianSite: string | null
  confluenceRef: string | null
  confluenceKind: ConfluenceKind | null
  syncPull: boolean
  syncPush: boolean
  lastSyncAt: string | null
}

export function toUtcIso(instant: string): string {
  const parsed = new Date(instant)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`not a valid instant: ${instant}`)
  }
  return parsed.toISOString()
}

export function toBoolean(value: unknown): boolean {
  return value === 1 || value === true
}

export function fromBoolean(value: boolean): number {
  return value ? 1 : 0
}
