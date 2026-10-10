import type { DatabaseSync } from 'node:sqlite'

export const SPACE_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,5}$/
export const UNASSIGNED_KEY = 'BL'
const FALLBACK_KEY = 'PRJ'

function keyWords(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 1 || /^[0-9]$/.test(word))
}

export function spaceKeyCandidates(name: string): string[] {
  const words = keyWords(name)
  const upper = words.map((word) => word.toUpperCase())
  const candidates: string[] = []

  const acronymAt = words.findIndex((word) => /^[A-Z]{2,5}$/.test(word))
  if (acronymAt >= 0) {
    const acronym = upper[acronymAt]!
    candidates.push(acronym)
    const rest = upper.filter((_, index) => index !== acronymAt).map((word) => word[0]).join('')
    if (rest.length > 0) candidates.push(`${acronym}${rest}`.slice(0, 6))
  }
  if (upper.length > 1) candidates.push(upper.map((word) => word[0]).join('').slice(0, 4))
  const joined = upper.join('')
  candidates.push(joined.slice(0, 3), joined.slice(0, 4))

  const valid = candidates
    .map((candidate) => candidate.replace(/^[0-9]+/, ''))
    .filter((candidate) => SPACE_KEY_PATTERN.test(candidate) && candidate !== UNASSIGNED_KEY)
  return [...new Set(valid)]
}

export function deriveSpaceKey(name: string, taken: ReadonlySet<string>): string {
  const derived = spaceKeyCandidates(name)
  const candidates = derived.length > 0 ? derived : [FALLBACK_KEY]
  const free = candidates.find((candidate) => !taken.has(candidate))
  if (free !== undefined) return free
  const base = candidates[0]!.slice(0, 5)
  for (let suffix = 2; ; suffix += 1) {
    const tail = String(suffix)
    const candidate = `${base.slice(0, 6 - tail.length)}${tail}`
    if (!taken.has(candidate)) return candidate
  }
}

export function takenSpaceKeys(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT key FROM spaces WHERE key IS NOT NULL').all() as { key: string }[]
  return new Set([UNASSIGNED_KEY, ...rows.map((row) => row.key.toUpperCase())])
}

export function ensureSpaceKey(db: DatabaseSync, spaceId: number): string | null {
  const row = db.prepare('SELECT name, key FROM spaces WHERE id = ?').get(spaceId) as { name: string; key: string | null } | undefined
  if (!row) return null
  if (row.key !== null) return row.key
  const key = deriveSpaceKey(row.name, takenSpaceKeys(db))
  db.prepare('UPDATE spaces SET key = ? WHERE id = ?').run(key, spaceId)
  return key
}
