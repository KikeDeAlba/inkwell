import { rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agents } from '@kikedealba/kit'
import { platformContext } from '@kikedealba/kit/platform'

export const DEFAULT_AGENT: agents.HeadlessAgent = 'claude'

export const DEFAULT_MODELS: Partial<Record<agents.HeadlessAgent, string>> = { claude: 'haiku' }

export const CLAUDE_ISOLATION = ['--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--disallowedTools', 'Read,Grep,Glob']

export const MODEL_ENV: Readonly<Record<string, string>> = {
  INKWELL_AUTODOC: '1',
  GAZE_HARVEST: '1',
  BITA_NO_HOOKS: '1',
  KIT_NO_EVENTS: '1',
}

export const CLAUDE_MODEL_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_SAFE_MODE: '1',
}

export type ModelFailure = 'spawn' | 'timeout' | 'exit' | 'is-error' | 'not-json' | 'empty' | 'prompt-too-long'

export class ModelError extends Error {
  readonly reason: ModelFailure

  constructor(reason: ModelFailure, message: string = reason) {
    super(message)
    this.name = 'ModelError'
    this.reason = reason
  }
}

export interface ModelCall {
  prompt: string
  agent: string
  model: string | null
  models?: Readonly<Record<string, string>>
  timeoutSeconds: number
}

export interface ModelAnswer {
  text: string
  agent: agents.HeadlessAgent
  fallback: boolean
}

export interface PickedAgent {
  agent: agents.HeadlessAgent
  bin: string
  fallback: boolean
}

export function binEnvVar(agent: string): string {
  return `INKWELL_${agent.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BIN`
}

export async function resolveAgent(preferred: string, env: NodeJS.ProcessEnv = process.env): Promise<PickedAgent> {
  const ctx = platformContext({ env })
  const order = [preferred, ...agents.HEADLESS_AGENTS.filter((agent) => agent !== preferred)]
  for (const agent of order) {
    if (!agents.isHeadlessAgent(agent)) continue
    const override = env[binEnvVar(agent)]
    const bin = await agents.findAgentBinary(agent, { ctx, ...(override !== undefined && override.length > 0 ? { override } : {}) })
    if (bin !== null) return { agent, bin, fallback: agent !== preferred }
  }
  throw new ModelError('spawn')
}

export function modelFor(call: Pick<ModelCall, 'model' | 'models'>, picked: Pick<PickedAgent, 'agent'>): string | undefined {
  const specific = call.models?.[picked.agent]
  if (specific !== undefined) return specific
  if (picked.agent === 'claude') return call.model ?? DEFAULT_MODELS.claude
  return undefined
}

export function modelArguments(agent: agents.HeadlessAgent): string[] {
  return agent === 'claude' ? [...CLAUDE_ISOLATION] : []
}

export function modelExtras(agent: agents.HeadlessAgent): Record<string, string> {
  return agent === 'claude' ? { ...MODEL_ENV, ...CLAUDE_MODEL_ENV } : { ...MODEL_ENV }
}

export function failureOf(error: agents.HeadlessError): ModelError {
  if (error.code === 'UNAVAILABLE') return new ModelError('spawn')
  if (error.code === 'TIMEOUT') return new ModelError('timeout')
  if (error.code === 'PARSE') return new ModelError('not-json')
  if (error.code === 'PROMPT_TOO_LONG') return new ModelError('prompt-too-long')
  if (error.exitCode === 0) return new ModelError('is-error')
  return new ModelError('exit', `exit-${error.exitCode ?? 'signal'}`)
}

let active: AbortController | null = null
let activeDir: string | null = null

export function stopActiveModel(): void {
  active?.abort()
  if (activeDir !== null) rmSync(activeDir, { recursive: true, force: true })
  activeDir = null
}

export async function runModel(call: ModelCall, env: NodeJS.ProcessEnv = process.env): Promise<ModelAnswer> {
  const picked = await resolveAgent(call.agent, env)
  const cwd = await mkdtemp(join(tmpdir(), 'inkwell-autodoc-'))
  const controller = new AbortController()
  active = controller
  activeDir = cwd
  try {
    const model = modelFor(call, picked)
    const result = await agents.runHeadless({
      agent: picked.agent,
      bin: picked.bin,
      prompt: call.prompt,
      cwd,
      access: 'read',
      ...(model === undefined ? {} : { model }),
      extraArgs: modelArguments(picked.agent),
      env: modelExtras(picked.agent),
      ctx: platformContext({ env }),
      timeoutMs: call.timeoutSeconds * 1000,
      signal: controller.signal,
    })
    if (result.text.trim().length === 0) throw new ModelError('empty')
    return { text: result.text, agent: picked.agent, fallback: picked.fallback }
  } catch (error) {
    if (error instanceof agents.HeadlessError) throw failureOf(error)
    throw error
  } finally {
    active = null
    activeDir = null
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined)
  }
}

function looksLikeActions(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item) && 'action' in (item as Record<string, unknown>))
  )
}

export const PARSE_MAX_BYTES = 200 * 1024

export function topLevelArrays(text: string): string[] {
  const found: string[] = []
  const stack: string[] = []
  let start = -1
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (stack.length === 0) {
      if (char === '[') {
        stack.push(']')
        start = index
      }
      continue
    }
    if (inString) {
      if (char === '\\') index += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '[') stack.push(']')
    else if (char === '{') stack.push('}')
    else if (char === ']' || char === '}') {
      if (stack.pop() !== char) {
        stack.length = 0
        continue
      }
      if (stack.length === 0) found.push(text.slice(start, index + 1))
    }
  }
  return found
}

export function parseActions(text: string): unknown[] | null {
  if (Buffer.byteLength(text) > PARSE_MAX_BYTES) return null
  let chosen: unknown[] | null = null
  for (const candidate of topLevelArrays(text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (looksLikeActions(parsed) && (parsed.length > 0 || chosen === null || chosen.length === 0)) chosen = parsed
    } catch {
      continue
    }
  }
  return chosen
}
