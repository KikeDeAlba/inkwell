import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseEnvelope } from '@kikedealba/kit/envelope'
import { registryDir } from '@kikedealba/kit/registry'

export interface BitaProject {
  id: number
  name: string
  key: string | null
  clientName: string | null
  active: boolean
  site: string | null
  confluence: { ref: string; kind: 'space' | 'page' } | null
  syncPull: boolean
  syncPush: boolean
}

export type BitaProjectLookup = (ref: string) => BitaProject | null

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function toBitaProject(raw: unknown): BitaProject | null {
  const data = record(raw)
  const id = data['id']
  const name = text(data['name'])
  if (typeof id !== 'number' || !Number.isInteger(id) || name === null) return null
  const atlassian = record(data['atlassian'])
  const confluence = record(atlassian['confluence'])
  const sync = record(atlassian['sync'])
  const ref = text(confluence['ref'])
  const kind = confluence['kind'] === 'page' ? 'page' : confluence['kind'] === 'space' ? 'space' : null
  return {
    id,
    name,
    key: text(data['key']),
    clientName: text(data['clientName']),
    active: data['active'] !== false,
    site: text(atlassian['site']),
    confluence: ref && kind ? { ref, kind } : null,
    syncPull: sync['pull'] === true,
    syncPush: sync['push'] === true,
  }
}

export function matchProject(projects: readonly BitaProject[], ref: string): BitaProject | null {
  const wanted = ref.trim()
  const asNumber = Number(wanted)
  if (Number.isInteger(asNumber) && asNumber > 0) return projects.find((project) => project.id === asNumber) ?? null
  const lower = wanted.toLowerCase()
  return projects.find((project) => project.name.toLowerCase() === lower) ?? projects.find((project) => project.key?.toLowerCase() === lower) ?? null
}

function bitaBin(): string[] | null {
  const file = path.join(registryDir(), 'bita.json')
  if (!existsSync(file)) return null
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as { bin?: unknown }
    const bin = Array.isArray(manifest.bin) ? manifest.bin.filter((part): part is string => typeof part === 'string') : []
    return bin.length > 0 && bin.every((part) => !path.isAbsolute(part) || existsSync(part)) ? bin : null
  } catch {
    return null
  }
}

export const cliBitaProjectLookup: BitaProjectLookup = (ref) => {
  if (process.env['INKWELL_NO_BITA']) return null
  const bin = bitaBin()
  const [command, ...prefix] = bin ?? []
  if (!command) return null
  try {
    const stdout = execFileSync(command, [...prefix, 'projects', '--json'], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, BITA_NO_DELEGATE: '1', BITA_NO_HOOKS: '1', KIT_NO_EVENTS: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const envelope = parseEnvelope(stdout)
    if (!envelope?.ok || !Array.isArray(envelope.data)) return null
    return matchProject(envelope.data.map(toBitaProject).filter((project): project is BitaProject => project !== null), ref)
  } catch {
    return null
  }
}

let lookup: BitaProjectLookup = cliBitaProjectLookup

export function bitaProjectLookup(): BitaProjectLookup {
  return lookup
}

export function setBitaProjectLookup(next: BitaProjectLookup): () => void {
  const previous = lookup
  lookup = next
  return () => {
    lookup = previous
  }
}

export interface BitaRepoProject {
  slug: string
  projectId: number
  projectName: string | null
}

export type BitaRepoLookup = (cwd: string) => BitaRepoProject | null

export const cliBitaRepoLookup: BitaRepoLookup = (cwd) => {
  if (process.env['INKWELL_NO_BITA']) return null
  const [command, ...prefix] = bitaBin() ?? []
  if (!command) return null
  try {
    const stdout = execFileSync(command, [...prefix, 'repo', 'which', '--json'], {
      cwd,
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, BITA_NO_DELEGATE: '1', BITA_NO_HOOKS: '1', KIT_NO_EVENTS: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const envelope = parseEnvelope(stdout)
    if (!envelope?.ok) return null
    const data = record(envelope.data)
    const projectId = data['projectId']
    if (typeof projectId !== 'number' || !Number.isInteger(projectId)) return null
    return { slug: text(data['slug']) ?? '', projectId, projectName: text(data['projectName']) }
  } catch {
    return null
  }
}
