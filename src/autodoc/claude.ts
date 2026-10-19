import { spawn, type ChildProcess } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platformContext, which } from '@kikedealba/kit/platform'
import { modelEnvironment } from './env.ts'

export const CLAUDE_BIN_ENV_VAR = 'INKWELL_CLAUDE_BIN'

export const ISOLATION = ['--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']

export const MODEL_ENV: Readonly<Record<string, string>> = {
  INKWELL_AUTODOC: '1',
  GAZE_HARVEST: '1',
  BITA_NO_HOOKS: '1',
  KIT_NO_EVENTS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_SAFE_MODE: '1',
}

export const STDOUT_MAX_BYTES = 2 * 1024 * 1024
const WINDOWS_SAFE_ARG = /^[A-Za-z0-9_.,:=/\\@[\]+ ()-]*$/

export type ModelFailure = 'spawn' | 'timeout' | 'exit' | 'too-large' | 'is-error' | 'not-json' | 'empty' | 'unsafe-argument'

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
  model: string
  timeoutSeconds: number
}

export function claudeArguments(call: Pick<ModelCall, 'model'>): string[] {
  return ['-p', '--model', call.model, '--output-format', 'json', ...ISOLATION, '--tools', '']
}

interface CommandLine {
  command: string
  args: string[]
  verbatim: boolean
}

export function quoteWindows(arg: string): string {
  if (!WINDOWS_SAFE_ARG.test(arg) || arg.endsWith('\\')) throw new ModelError('unsafe-argument')
  return `"${arg}"`
}

async function commandFor(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandLine> {
  if (/\.(?:c|m)?js$|\.ts$/.test(bin)) return { command: process.execPath, args: [bin, ...args], verbatim: false }
  if (process.platform !== 'win32') return { command: bin, args, verbatim: false }
  const resolved = (await which(bin, platformContext({ env }))) ?? bin
  if (!/\.(?:cmd|bat)$/i.test(resolved)) return { command: resolved, args, verbatim: false }
  const line = [resolved, ...args].map(quoteWindows).join(' ')
  return { command: env['ComSpec'] ?? env['COMSPEC'] ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

let active: ChildProcess | null = null
let activeDir: string | null = null

export function stopActiveModel(): void {
  active?.kill('SIGKILL')
  if (activeDir !== null) rmSync(activeDir, { recursive: true, force: true })
  activeDir = null
}

interface Captured {
  code: number | null
  stdout: string
  timedOut: boolean
  tooLarge: boolean
}

function capture(line: CommandLine, options: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number }): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const child = spawn(line.command, line.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: line.verbatim,
    })
    active = child
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let timedOut = false
    let tooLarge = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > STDOUT_MAX_BYTES) {
        tooLarge = true
        child.kill('SIGKILL')
        return
      }
      stdout.push(chunk)
    })
    child.stderr.resume()
    child.on('error', () => {
      clearTimeout(timer)
      active = null
      reject(new ModelError('spawn'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      active = null
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), timedOut, tooLarge })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input)
  })
}

export async function runModel(call: ModelCall, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const bin = env[CLAUDE_BIN_ENV_VAR] || 'claude'
  const childEnv = modelEnvironment(env, MODEL_ENV)
  const cwd = await mkdtemp(join(tmpdir(), 'inkwell-autodoc-'))
  activeDir = cwd
  try {
    const line = await commandFor(bin, claudeArguments(call), childEnv)
    const result = await capture(line, { cwd, env: childEnv, input: call.prompt, timeoutMs: call.timeoutSeconds * 1000 })
    if (result.timedOut) throw new ModelError('timeout')
    if (result.tooLarge) throw new ModelError('too-large')
    if (result.code !== 0) throw new ModelError('exit', `exit-${result.code ?? 'signal'}`)
    return result.stdout
  } finally {
    activeDir = null
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function resultText(output: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(output) as unknown
  } catch {
    throw new ModelError('not-json')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ModelError('not-json')
  const record = parsed as Record<string, unknown>
  if (record['is_error'] === true) throw new ModelError('is-error')
  const result = typeof record['result'] === 'string' ? record['result'] : undefined
  if (result === undefined || result.trim().length === 0) throw new ModelError('empty')
  return result
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
