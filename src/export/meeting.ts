import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { findTool } from '@kikedealba/kit/registry'
import { ConflictError, NotFoundError } from '../errors.ts'
import { findChrome } from '../docs/apps.ts'
import { slugify } from '../docs/slug.ts'
import { localDay } from '../domain/timezone.ts'
import { buildMinutesHtml, loadPrintStyles, pickTitle, type MeetingMode, type MermaidRenderer } from './minutes.ts'
import { downloadsDir, mermaidRendererIn, printToPdf, processRunner, type PrintEnvironment, type ProcessRunner } from './pdf.ts'

export { chromePdfArgs, printToPdf, withWorkDir, type ProcessResult, type ProcessRunner } from './pdf.ts'

const RECAP_TIMEOUT_MS = 60_000

export const RECAP_INSTALL_HINT = 'npm install -g @kikedealba/recap && recap setup'

export interface MeetingExportEnvironment extends PrintEnvironment {
  run: ProcessRunner
  readText: (path: string) => Promise<string>
  recapCommand: () => Promise<string[] | null>
  renderMermaid: MermaidRenderer
  styles: () => Promise<string>
  downloadsDir: string
}

export function findRecapBinary(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | null {
  const explicit = env['RECAP_CLI']
  if (explicit && exists(explicit)) return explicit
  const home = env['HOME'] ?? env['USERPROFILE'] ?? homedir()
  const candidates = [
    join(home, '.local/bin/recap'),
    join(home, 'Applications/Recap.app/Contents/MacOS/recap'),
    '/opt/homebrew/bin/recap',
    '/usr/local/bin/recap',
    '/Applications/Recap.app/Contents/MacOS/recap',
  ]
  return candidates.find((candidate) => exists(candidate)) ?? null
}

export async function findRecapCommand(): Promise<string[] | null> {
  const explicit = process.env['RECAP_CLI']
  if (explicit && existsSync(explicit)) return [explicit]
  const tool = await findTool('recap')
  if (tool) return tool.bin
  const legacy = findRecapBinary()
  return legacy === null ? null : [legacy]
}

export async function defaultMeetingExportEnvironment(workDir: string): Promise<MeetingExportEnvironment> {
  return {
    run: processRunner,
    exists: existsSync,
    readText: (path) => readFile(path, 'utf8'),
    recapCommand: findRecapCommand,
    chromeApp: await findChrome(),
    renderMermaid: mermaidRendererIn(join(workDir, 'mermaid')),
    styles: () => loadPrintStyles(),
    downloadsDir: downloadsDir(),
  }
}

export interface RecapMeeting {
  dir: string
  summary: string | null
  startedAt: string
  durationSeconds: number | null
  mode: MeetingMode | null
  title: string | null
  wrapupTitle: string | null
  wrapupProject: string | null
  bitaEntryTitle: string | null
}

export interface MeetingEntryInfo {
  description: string | null
  projectName: string | null
  clientName: string | null
}

export interface MeetingExportRequest {
  entryId: number
  out?: string | undefined
  timezone: string
  entry: MeetingEntryInfo | null
  workDir: string
}

export interface MeetingExportResult {
  path: string
  title: string
  entryId: number
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function projectName(value: unknown): string | null {
  return text(value) ?? text(record(value)?.['name'])
}

export function parseRecapShow(stdout: string, entryId: number): RecapMeeting {
  let envelope: Record<string, unknown> | null = null
  try {
    envelope = record(JSON.parse(stdout) as unknown)
  } catch {
    envelope = null
  }
  if (envelope === null) throw new ConflictError(`recap did not answer with JSON for entry ${entryId}.`, 'RECAP_FAILED')
  const error = record(envelope['error'])
  if (envelope['ok'] === false || error !== null) {
    const code = text(error?.['code']) ?? 'RECAP_FAILED'
    const message = text(error?.['message']) ?? `recap failed for entry ${entryId}.`
    if (code === 'MEETING_NOT_FOUND') {
      throw new NotFoundError(`No recorded meeting is linked to entry ${entryId}.`, 'MEETING_NOT_FOUND', 'Check it with "recap list".')
    }
    throw new ConflictError(message, code)
  }
  const data = record(envelope['data'])
  const dir = text(data?.['dir'])
  const startedAt = text(data?.['startedAt']) ?? text(data?.['createdAt'])
  if (data === null || dir === null || startedAt === null) {
    throw new ConflictError(`recap answered without the meeting of entry ${entryId}.`, 'RECAP_FAILED')
  }
  const wrapup = record(data['wrapup'])
  const mode = data['mode'] === 'meeting' || data['mode'] === 'remote' || data['mode'] === 'in-person' ? data['mode'] : null
  const duration = data['durationSeconds']
  return {
    dir,
    summary: text(data['summary']),
    startedAt,
    durationSeconds: typeof duration === 'number' && Number.isFinite(duration) ? duration : null,
    mode,
    title: text(data['title']),
    wrapupTitle: text(wrapup?.['title']),
    wrapupProject: projectName(wrapup?.['project']),
    bitaEntryTitle: text(record(data['bitaEntry'])?.['title']),
  }
}

export async function readRecapMeeting(entryId: number, env: MeetingExportEnvironment): Promise<RecapMeeting> {
  const recap = await env.recapCommand()
  const [command, ...prefix] = recap ?? []
  if (command === undefined) {
    throw new ConflictError('recap is not installed, and it holds the meeting minutes.', 'RECAP_MISSING', RECAP_INSTALL_HINT)
  }
  const result = await env.run(command, [...prefix, 'show', '--bita-entry', String(entryId), '--json'], RECAP_TIMEOUT_MS)
  if (result.stdout.trim().length === 0) {
    throw new ConflictError(`recap failed for entry ${entryId}: ${result.stderr.trim().split('\n')[0] ?? ''}`, 'RECAP_FAILED')
  }
  return parseRecapShow(result.stdout, entryId)
}

export function defaultPdfPath(downloadsDir: string, startedAt: string, timezone: string, title: string): string {
  const slug = slugify(title) || 'reunion'
  return join(downloadsDir, `minuta-${localDay(startedAt, timezone)}-${slug}.pdf`)
}

export async function exportMeeting(request: MeetingExportRequest, env: MeetingExportEnvironment): Promise<MeetingExportResult> {
  const meeting = await readRecapMeeting(request.entryId, env)
  const summaryPath = meeting.summary ?? join(meeting.dir, 'summary.md')
  let summaryMarkdown: string
  try {
    summaryMarkdown = await env.readText(summaryPath)
  } catch {
    throw new NotFoundError(`The meeting of entry ${request.entryId} has no minutes yet.`, 'MINUTES_MISSING', `Expected them at ${summaryPath}.`)
  }

  const fallback = `Reunión del ${localDay(meeting.startedAt, request.timezone)}`
  const title = pickTitle([meeting.wrapupTitle, request.entry?.description, meeting.title, meeting.bitaEntryTitle], fallback)
  const html = await buildMinutesHtml(
    {
      title,
      projectName: meeting.wrapupProject ?? request.entry?.projectName ?? null,
      clientName: request.entry?.clientName ?? null,
      startedAt: meeting.startedAt,
      durationSeconds: meeting.durationSeconds,
      mode: meeting.mode,
      timezone: request.timezone,
      summaryMarkdown,
      meetingDir: meeting.dir,
    },
    { styles: await env.styles(), renderMermaid: env.renderMermaid },
  )

  const out = resolve(request.out ?? defaultPdfPath(env.downloadsDir, meeting.startedAt, request.timezone, title))
  await mkdir(dirname(out), { recursive: true })
  await mkdir(request.workDir, { recursive: true, mode: 0o700 })
  const htmlPath = join(request.workDir, 'minuta.html')
  await writeFile(htmlPath, html, { mode: 0o600 })
  await printToPdf(htmlPath, out, request.workDir, env)
  return { path: out, title, entryId: request.entryId }
}
