import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { platformContext } from '@kikedealba/kit/platform'
import { AUTODOC_BRANCH_PREFIX } from '../../autodoc/actions.ts'
import { stopActiveModel } from '../../autodoc/claude.ts'
import { releaseHeldSessions } from '../../autodoc/lock.ts'
import { loadAutodocConfig } from '../../autodoc/config.ts'
import { runEnvironment } from '../../autodoc/env.ts'
import { logLine, runAutodoc } from '../../autodoc/run.ts'
import { clearAutodocPending, isAutodocPending, pendingAutodocPages } from '../../db/autodoc-runs.ts'
import { findPage, requirePage } from '../../db/pages.ts'
import { appliedProposals, branchCommits, listBranches, trailer } from '../../docs/git.ts'
import { UsageError } from '../../errors.ts'
import { dataDir } from '../../paths.ts'
import { binEntry } from '../../setup.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString } from '../args.ts'
import { withLocalContext } from '../context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'

const RUN_MARGIN_SECONDS = 120

export function autodocDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return dataDir(platformContext({ env }))
}

export function autodocLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(autodocDataDir(env), 'autodoc.log')
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

export interface SessionEndInput {
  transcript: string
  session: string
  cwd: string
}

export function transcriptSessionId(transcript: string): string {
  return createHash('sha256').update(transcript).digest('hex').slice(0, 32)
}

export function sessionEndInput(document: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): SessionEndInput | null {
  if (env['INKWELL_AUTODOC'] !== undefined && env['INKWELL_AUTODOC'] !== '0') return null
  if (env['INKWELL_NO_AUTODOC'] === '1') return null
  if (!loadAutodocConfig(env).enabled) return null
  const transcript = text(document['transcript_path'])
  if (transcript === null) return null
  return {
    transcript,
    session: text(document['session_id']) ?? transcriptSessionId(transcript),
    cwd: text(document['cwd']) ?? text(env['CLAUDE_PROJECT_DIR']) ?? process.cwd(),
  }
}

export function runArguments(input: SessionEndInput): string[] {
  return ['autodoc-run', `--transcript=${input.transcript}`, `--session=${input.session}`, `--cwd=${input.cwd}`]
}

function readStdin(): Record<string, unknown> {
  try {
    return record(JSON.parse(readFileSync(0, 'utf8')) as unknown)
  } catch {
    return {}
  }
}

export function openLog(logPath: string): number {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
  const fd = openSync(logPath, 'a', 0o600)
  if (process.platform !== 'win32') {
    try {
      chmodSync(logPath, 0o600)
    } catch {
      return fd
    }
  }
  return fd
}

export function selfEntry(): string {
  const current = process.argv[1]
  return current !== undefined && existsSync(current) ? current : binEntry()
}

function spawnDetached(args: readonly string[], logPath: string, env: NodeJS.ProcessEnv): void {
  const log = openLog(logPath)
  try {
    const child = spawn(process.execPath, [selfEntry(), ...args], { detached: true, stdio: ['ignore', log, log], env, windowsHide: true, shell: false })
    child.on('error', () => undefined)
    child.unref()
  } finally {
    closeSync(log)
  }
}

export function runHook(argv: string[]): number {
  const [event] = argv
  if (event !== 'session-end') throw new UsageError('Usage: inkwell hook session-end')
  try {
    const input = sessionEndInput(readStdin())
    if (input === null) return 0
    spawnDetached(runArguments(input), autodocLogPath(), runEnvironment(process.env, { INKWELL_AUTODOC: '1' }))
  } catch {
    return 0
  }
  return 0
}

const RUN_OPTIONS = {
  transcript: { type: 'string' as const },
  session: { type: 'string' as const },
  cwd: { type: 'string' as const },
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code.toLowerCase() : 'unexpected'
}

export async function runAutodocRun(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, RUN_OPTIONS, BASE_OPTIONS)
  const transcript = readString(args, 'transcript')
  const sessionId = readString(args, 'session')
  if (transcript === undefined || sessionId === undefined) throw new UsageError('Usage: inkwell autodoc-run --transcript=FILE --session=ID [--cwd=DIR]')
  const cwd = readString(args, 'cwd') ?? process.cwd()
  const config = loadAutodocConfig()
  const guard = setTimeout(() => {
    stopActiveModel()
    releaseHeldSessions()
    process.stdout.write(`${logLine(sessionId, null, 0, 'skip:run-timeout')}\n`)
    process.exit(0)
  }, (config.timeoutSeconds + RUN_MARGIN_SECONDS) * 1000)
  guard.unref()
  try {
    const result = await withLocalContext(args, (ctx) => runAutodoc({ ctx, config, transcript, sessionId, cwd, lockDir: autodocDataDir() }))
    if (readBoolean(args, 'json')) writeJson(successEnvelope('autodoc-run', result))
  } catch (error) {
    process.stdout.write(`${logLine(sessionId, null, 0, `skip:error-${errorCode(error)}`)}\n`)
  } finally {
    clearTimeout(guard)
  }
  return 0
}

export interface AutodocProposal {
  branch: string
  head: string
  commits: { sha: string; pageId: number | null; title: string | null; section: string | null; reason: string | null; session: string | null }[]
}

export interface AutodocPendingPage {
  pageId: number
  title: string
  relPath: string
  parentId: number | null
  session: string
  createdAt: string
}

async function runList(rest: string[]): Promise<number> {
  const args = parseCommandArgs(rest, {}, BASE_OPTIONS)
  const { proposals, pending } = await withLocalContext(args, async (ctx) => {
    const applied = await appliedProposals(ctx.docsRoot)
    const found: AutodocProposal[] = []
    for (const branch of await listBranches(ctx.docsRoot)) {
      if (!branch.name.startsWith(AUTODOC_BRANCH_PREFIX) || branch.commits.length === 0) continue
      const commits = (await branchCommits(ctx.docsRoot, branch.name))
        .filter((commit) => !applied.has(commit.sha))
        .map((commit) => ({
          sha: commit.sha,
          pageId: commit.pageId,
          title: commit.pageId === null ? null : (findPage(ctx.db, commit.pageId)?.title ?? null),
          section: trailer(commit.trailers, 'Section') ?? null,
          reason: trailer(commit.trailers, 'Reason') ?? null,
          session: trailer(commit.trailers, 'Session') ?? null,
        }))
      if (commits.length > 0) found.push({ branch: branch.name, head: branch.head, commits })
    }
    const pages: AutodocPendingPage[] = []
    for (const item of pendingAutodocPages(ctx.db)) {
      const page = findPage(ctx.db, item.pageId)
      if (page !== undefined) pages.push({ pageId: page.id, title: page.title, relPath: page.relPath, parentId: page.parentId, session: item.sessionId, createdAt: item.createdAt })
    }
    return { proposals: found, pending: pages }
  })

  if (readBoolean(args, 'json')) {
    writeJson(successEnvelope('autodoc ls', { proposals, pending }))
    return 0
  }
  if (proposals.length === 0 && pending.length === 0) {
    writeOut('No autodoc proposals or pages waiting for approval.')
    return 0
  }
  for (const proposal of proposals) {
    for (const commit of proposal.commits) {
      const page = commit.pageId === null ? '?' : `#${commit.pageId} ${commit.title ?? ''}`.trim()
      writeOut(`${proposal.branch}  ${commit.sha.slice(0, 7)}  ${page}${commit.section ? ` «${commit.section}»` : ''}`)
      if (commit.reason) writeOut(`  ${commit.reason}`)
      if (commit.session) writeOut(`  session ${commit.session}`)
    }
  }
  if (proposals.length > 0) writeOut('Review with "inkwell branch diff <branch>" and accept with "inkwell branch apply <branch> --commit <sha>".')
  for (const page of pending) writeOut(`pending  #${page.pageId} ${page.title}  ${page.relPath}  session ${page.session}`)
  if (pending.length > 0) writeOut('New pages stay out of Confluence until "inkwell autodoc approve <pageId>" or a full "page write".')
  return 0
}

async function runApprove(rest: string[]): Promise<number> {
  const args = parseCommandArgs(rest, {}, BASE_OPTIONS)
  const raw = args.positionals[0]
  const id = Number(raw)
  if (raw === undefined || !Number.isInteger(id) || id <= 0) throw new UsageError('Usage: inkwell autodoc approve <pageId>')
  const data = await withLocalContext(args, (ctx) => {
    const page = requirePage(ctx.db, id)
    const wasPending = isAutodocPending(ctx.db, page.id)
    clearAutodocPending(ctx.db, page.id)
    return { pageId: page.id, title: page.title, approved: true, wasPending }
  })
  if (readBoolean(args, 'json')) writeJson(successEnvelope('autodoc approve', data))
  else writeOut(data.wasPending ? `Approved #${data.pageId} ${data.title}.` : `#${data.pageId} ${data.title} was not waiting for approval.`)
  return 0
}

export async function runAutodocCommand(argv: string[]): Promise<number> {
  const [action, ...rest] = argv
  if (action === 'ls') return runList(rest)
  if (action === 'approve') return runApprove(rest)
  throw new UsageError('Usage: inkwell autodoc ls [--json] | inkwell autodoc approve <pageId>')
}
