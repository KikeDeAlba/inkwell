import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { platformContext, toolDirs } from '@kikedealba/kit/platform'

export interface AutodocConfig {
  enabled: boolean
  model: string
  maxChars: number
  minChars: number
  maxActions: number
  timeoutSeconds: number
}

export const AUTODOC_DEFAULTS: AutodocConfig = {
  enabled: true,
  model: 'haiku',
  maxChars: 40_000,
  minChars: 600,
  maxActions: 5,
  timeoutSeconds: 240,
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolDirs('inkwell', platformContext({ env })).config, 'config.json')
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

export function loadAutodocConfig(env: NodeJS.ProcessEnv = process.env): AutodocConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configPath(env), 'utf8')) as unknown
  } catch {
    return { ...AUTODOC_DEFAULTS }
  }
  const root = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const block = root['autodoc']
  const autodoc = block !== null && typeof block === 'object' && !Array.isArray(block) ? (block as Record<string, unknown>) : {}
  const model = autodoc['model']
  return {
    enabled: autodoc['enabled'] !== false,
    model: typeof model === 'string' && model.trim().length > 0 ? model.trim() : AUTODOC_DEFAULTS.model,
    maxChars: positive(autodoc['maxChars'], AUTODOC_DEFAULTS.maxChars),
    minChars: positive(autodoc['minChars'], AUTODOC_DEFAULTS.minChars),
    maxActions: positive(autodoc['maxActions'], AUTODOC_DEFAULTS.maxActions),
    timeoutSeconds: positive(autodoc['timeoutSeconds'], AUTODOC_DEFAULTS.timeoutSeconds),
  }
}
