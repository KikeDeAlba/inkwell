import type { DocsContext } from '../docs/context.ts'
import { advanceAutodocCursor, autodocCursor } from '../db/autodoc-runs.ts'
import type { BitaRepoLookup } from '../integrations/bita-projects.ts'
import { AutodocWriter, describeOutcome, sessionTag, type Outcome, type ShownPage } from './actions.ts'
import { ModelError, parseActions, runModel, type ModelAnswer, type ModelCall } from './model.ts'
import type { AutodocConfig } from './config.ts'
import { claimSession } from './lock.ts'
import { buildPrompt, candidatePages, spaceTree } from './prompt.ts'
import { redactSensitive } from './sensitive.ts'
import { resolveSessionSpace } from './space.ts'
import { readTranscript, tailChars, unreadable, type TranscriptSlice } from './transcript.ts'

export interface AutodocRequest {
  ctx: DocsContext
  config: AutodocConfig
  transcript: string
  sessionId: string
  cwd: string
  lockDir: string
  env?: NodeJS.ProcessEnv
  lookup?: BitaRepoLookup
  model?: (call: ModelCall) => Promise<ModelAnswer>
  log?: (line: string) => void
}

export type AutodocStatus =
  | 'disabled'
  | 'busy'
  | 'transcript-unreadable'
  | 'nothing-new'
  | 'no-space'
  | 'model-failed'
  | 'unparseable'
  | 'write-failed'
  | 'done'

export interface AutodocResult {
  status: AutodocStatus
  chars: number
  outcomes: Outcome[]
  cursor: number
  agent: string | null
  fallback: boolean
}

function defaultLog(line: string): void {
  process.stdout.write(`${line}\n`)
}

export function logLine(sessionId: string, spaceKey: string | null, chars: number, summary: string): string {
  return `${new Date().toISOString()} autodoc ${sessionTag(sessionId)} [${spaceKey ?? '-'}] ${chars} chars -> ${summary}`
}

export async function runAutodoc(request: AutodocRequest): Promise<AutodocResult> {
  const { ctx, config, sessionId } = request
  const env = request.env ?? process.env
  const log = request.log ?? defaultLog
  let spaceKey: string | null = null
  let used: Pick<ModelAnswer, 'agent' | 'fallback'> | null = null
  const finish = (status: AutodocStatus, chars: number, summary: string, outcomes: Outcome[] = []): AutodocResult => {
    log(logLine(sessionId, spaceKey, chars, summary))
    return { status, chars, outcomes, cursor: autodocCursor(ctx.db, sessionId), agent: used?.agent ?? null, fallback: used?.fallback ?? false }
  }

  if (!config.enabled) return finish('disabled', 0, 'skip:disabled')
  const release = claimSession(request.lockDir, sessionId, (config.timeoutSeconds * 2 + 120) * 1000)
  if (release === null) return finish('busy', 0, 'skip:busy')
  try {
    let slice: TranscriptSlice
    try {
      slice = await readTranscript(request.transcript, autodocCursor(ctx.db, sessionId))
    } catch {
      return finish('transcript-unreadable', 0, 'skip:transcript-unreadable')
    }
    if (unreadable(slice)) return finish('transcript-unreadable', 0, 'skip:transcript-unreadable')

    const fresh = [...slice.text].length
    if (fresh < config.minChars) return finish('nothing-new', fresh, 'skip:nothing-new')
    const conversation = redactSensitive(tailChars(slice.text, config.maxChars))
    const chars = [...conversation].length

    const resolved = await resolveSessionSpace(ctx.db, request.cwd, ...(request.lookup ? [request.lookup] : []))
    const space = resolved.space
    if (space === null) return finish('no-space', chars, 'skip:no-space')
    spaceKey = space.key ?? String(space.id)

    const tree = await spaceTree(ctx.db, ctx.docsRoot, space.id)
    const candidates = await candidatePages(ctx.db, ctx.docsRoot, space.id, tree, conversation, resolved.repoSlug)
    const prompt = await buildPrompt({ spaceName: space.name, tree, candidates, conversation, maxActions: config.maxActions })
    const call: ModelCall = { prompt, agent: config.agent, model: config.model, timeoutSeconds: config.timeoutSeconds }

    let answer: string
    try {
      const reply = await (request.model ?? ((next: ModelCall) => runModel(next, env)))(call)
      used = { agent: reply.agent, fallback: reply.fallback }
      if (reply.fallback) log(logLine(sessionId, spaceKey, chars, `warn:agent-fallback-${config.agent}-to-${reply.agent}`))
      answer = reply.text
    } catch (error) {
      if (!(error instanceof ModelError)) throw error
      return finish('model-failed', chars, `skip:model-${error.message}`)
    }

    const actions = parseActions(answer)
    if (actions === null) return finish('unparseable', chars, 'skip:unparseable')

    const shown = new Map<number, ShownPage>(candidates.map((item) => [item.page.id, { truncated: item.truncated }]))
    const writer = new AutodocWriter({ ctx, space, sessionId, maxActions: config.maxActions, repoSlug: resolved.repoSlug, shown })
    const outcomes: Outcome[] = []
    for (const action of actions) outcomes.push(await writer.apply(action))
    const summary = outcomes.length === 0 ? 'nothing' : outcomes.map(describeOutcome).join(',')
    if (outcomes.length > 0 && outcomes.every((item) => item.kind === 'skip' && item.reason === 'write-failed')) {
      return finish('write-failed', chars, summary, outcomes)
    }
    advanceAutodocCursor(ctx.db, sessionId, slice.lines, new Date().toISOString())
    return finish('done', chars, summary, outcomes)
  } finally {
    release()
  }
}
