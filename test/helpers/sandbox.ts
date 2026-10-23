import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const BIN = join(import.meta.dirname, '..', '..', 'src', 'bin', 'inkwell.ts')

export function nodeLauncher(dir: string, name: string, script: string): string {
  if (process.platform === 'win32') {
    const file = join(dir, `${name}.cmd`)
    writeFileSync(file, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
    return file
  }
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(file, 0o755)
  return file
}

export interface Sandbox {
  dir: string
  env: NodeJS.ProcessEnv
  run(args: string[], input?: string): { status: number | null; stdout: string; stderr: string; json: any }
  ok(...args: string[]): any
  cleanup(): void
}

export function sandbox(t: { after: (fn: () => void) => void }, extra: NodeJS.ProcessEnv = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'inkwell-cli-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_DATA_HOME: join(dir, 'data'),
    XDG_STATE_HOME: join(dir, 'state'),
    APPDATA: join(dir, 'appdata'),
    LOCALAPPDATA: join(dir, 'localappdata'),
    KIT_REGISTRY_DIR: join(dir, 'registry'),
    KIT_CREDENTIALS: 'file',
    KIT_NO_EVENTS: '1',
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    INKWELL_DB_PATH: join(dir, 'inkwell', 'inkwell.db'),
    INKWELL_DOCS_DIR: join(dir, 'inkwell', 'docs'),
    ...extra,
  }
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'KIT_AGENTS_HOME']) delete env[key]
  delete env['INKWELL_CHROME']
  delete env['INKWELL_DRAWIO']
  const run = (args: string[], input?: string) => {
    const result = spawnSync(process.execPath, [BIN, ...args, ...(args.includes('--json') ? [] : ['--json'])], { env, encoding: 'utf8', input: input ?? '' })
    const last = result.stdout.trim().split('\n').at(-1) ?? ''
    let json: any = null
    try {
      json = JSON.parse(last)
    } catch {
      json = null
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, json }
  }
  const box: Sandbox = {
    dir,
    env,
    run,
    ok: (...args: string[]) => {
      const result = run(args)
      if (result.status !== 0 || !result.json?.ok) throw new Error(`inkwell ${args.join(' ')} failed (${result.status}): ${result.stdout} ${result.stderr}`)
      return result.json.data
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  }
  t.after(() => box.cleanup())
  return box
}

export interface FakeEntry {
  id: number
  description: string
  kind: string | null
  projectId: number | null
  projectName: string | null
  startedAt: string
  stoppedAt: string | null
  note: string | null
}

export function registerFakeBita(box: Sandbox, entries: FakeEntry[], running: number[] = []): void {
  const script = join(box.dir, 'fake-bita.mjs')
  writeFileSync(
    script,
    `const entries = ${JSON.stringify(entries)}
const running = ${JSON.stringify(running)}
const args = process.argv.slice(2).filter((arg) => arg !== '--json')
const envelope = (command, data) => ({ schemaVersion: 3, ok: true, command, generatedAt: new Date().toISOString(), data })
const fail = (command, code, message) => ({ schemaVersion: 3, ok: false, command, generatedAt: new Date().toISOString(), error: { code, message } })
let out
if (args[0] === 'capabilities') out = envelope('capabilities', { name: 'bita', version: '0.18.0', envelope: 1, capabilities: ['time.entries.read', 'time.entries.write', 'time.notes', 'time.events'], emits: ['start', 'stop', 'cancel', 'amend', 'delete', 'merge'] })
else if (args[0] === 'entries' && args[1] === 'get') {
  const found = entries.find((entry) => entry.id === Number(args[2]))
  out = found ? envelope('entries get', found) : fail('entries get', 'ENTRY_NOT_FOUND', 'no entry')
} else if (args[0] === 'running') out = envelope('running', entries.filter((entry) => running.includes(entry.id)))
else out = fail(args.join(' '), 'USAGE_ERROR', 'unknown')
process.stdout.write(JSON.stringify(out) + '\\n')
process.exitCode = out.ok ? 0 : 2
`,
  )
  mkdirSync(box.env['KIT_REGISTRY_DIR'] as string, { recursive: true })
  writeFileSync(
    join(box.env['KIT_REGISTRY_DIR'] as string, 'bita.json'),
    JSON.stringify({
      manifestVersion: 1,
      name: 'bita',
      version: '0.18.0',
      bin: [process.execPath, script],
      envelope: 1,
      capabilities: ['time.entries.read', 'time.entries.write', 'time.notes', 'time.events'],
      emits: ['start', 'stop', 'cancel', 'amend', 'delete', 'merge'],
      subscribes: [],
    }),
  )
}
