import { parseArgs, type ParseArgsConfig } from 'node:util'
import { UsageError } from '../errors.ts'

type OptionConfig = NonNullable<ParseArgsConfig['options']>

export const BASE_OPTIONS: OptionConfig = {
  json: { type: 'boolean', default: false },
  timezone: { type: 'string' },
  'db-path': { type: 'string' },
  'docs-dir': { type: 'string' },
  offline: { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
}

export interface ParsedArgs {
  values: Record<string, string | boolean | string[] | undefined>
  positionals: string[]
}

function nfc(value: string): string {
  return value.normalize('NFC')
}

function normalizeValues(values: ParsedArgs['values']): ParsedArgs['values'] {
  const normalized: ParsedArgs['values'] = {}
  for (const [key, value] of Object.entries(values)) {
    normalized[key] = typeof value === 'string' ? nfc(value) : Array.isArray(value) ? value.map(nfc) : value
  }
  return normalized
}

export function parseCommandArgs(argv: string[], options: OptionConfig, globals: OptionConfig = BASE_OPTIONS): ParsedArgs {
  const merged: OptionConfig = { ...globals, ...options }
  const withAlias = merged['project'] !== undefined && merged['space'] === undefined ? { ...merged, space: merged['project'] } : merged
  try {
    const parsed = parseArgs({ args: argv, options: withAlias, allowPositionals: true, strict: true })
    const values = normalizeValues(parsed.values as ParsedArgs['values'])
    if (values['space'] !== undefined && values['project'] === undefined) values['project'] = values['space']
    return { values, positionals: parsed.positionals.map(nfc) }
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

export function readString(args: ParsedArgs, name: string): string | undefined {
  const value = args.values[name]
  return typeof value === 'string' ? value : undefined
}

export function readBoolean(args: ParsedArgs, name: string): boolean {
  return args.values[name] === true
}

export function readInteger(args: ParsedArgs, name: string): number | undefined {
  const raw = readString(args, name)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) throw new UsageError(`Invalid value for --${name}: "${raw}". Expected an integer.`)
  return parsed
}

export function splitPositionals(argv: readonly string[]): { positional: string[]; flags: string[] } {
  const positional: string[] = []
  const flags: string[] = []
  for (const token of argv) {
    if (token.startsWith('-') || flags.length > 0) flags.push(token)
    else positional.push(token)
  }
  return { positional, flags }
}
