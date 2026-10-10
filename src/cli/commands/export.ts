import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { ancestorsOf, requirePage } from '../../db/pages.ts'
import { resolveDocPath } from '../../docs/paths.ts'
import { readRaw } from '../../docs/store.ts'
import { UsageError } from '../../errors.ts'
import { findBita } from '../../integrations/bita.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString } from '../args.ts'
import { createLocalContext } from '../context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { spaceNameOf } from '../spaces.ts'

const OPTIONS = {
  out: { type: 'string' as const },
  html: { type: 'string' as const },
  'bita-entry': { type: 'string' as const },
}

const USAGE = `Usage:
  inkwell export page <pageId> [--out FILE.pdf] [--html FILE.html]
  inkwell export meeting --bita-entry <entryId> [--out FILE.pdf]`

export async function runExport(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const [what, target] = args.positionals
  if (what === 'page') return await exportPageCommand(args, target, json)
  if (what === 'meeting') return await exportMeetingCommand(args, target, json)
  throw new UsageError(USAGE)
}

async function exportPageCommand(args: ReturnType<typeof parseCommandArgs>, target: string | undefined, json: boolean): Promise<number> {
  const id = Number(target)
  if (target === undefined || !Number.isInteger(id) || id <= 0) throw new UsageError(USAGE)
  const ctx = createLocalContext(args)
  try {
    const page = requirePage(ctx.db, id)
    const pagePath = resolveDocPath(ctx.docsRoot, page.relPath)
    const markdown = await readRaw(pagePath)
    if (markdown === null) throw new UsageError(`Page #${page.id} has no document on disk yet.`)
    const doc = {
      title: page.title,
      spaceName: spaceNameOf(ctx.db, page.spaceId),
      trail: ancestorsOf(ctx.db, page.id).map((row) => row.title),
      updatedAt: page.recordedAt,
      timezone: ctx.timezone,
      markdown,
      pagePath,
      relPath: page.relPath,
    }
    const { buildPageHtml, defaultPageExportEnvironment, exportPage } = await import('../../export/page.ts')
    const { withWorkDir } = await import('../../export/pdf.ts')
    const htmlOut = readString(args, 'html')
    const result = await withWorkDir(async (workDir) => {
      const env = await defaultPageExportEnvironment(workDir)
      if (htmlOut !== undefined) {
        const path = resolve(htmlOut)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, await buildPageHtml(doc, { styles: await env.styles(), renderMermaid: env.renderMermaid }))
        return { path, format: 'html' as const }
      }
      return { path: await exportPage(doc, readString(args, 'out'), workDir, env), format: 'pdf' as const }
    })
    const data = { pageId: page.id, title: page.title, path: result.path, format: result.format }
    if (json) writeJson(successEnvelope('export page', data))
    else writeOut(`Exported #${page.id} ${page.title} to ${result.path}`)
    return 0
  } finally {
    ctx.db.close()
  }
}

async function exportMeetingCommand(args: ReturnType<typeof parseCommandArgs>, target: string | undefined, json: boolean): Promise<number> {
  const raw = readString(args, 'bita-entry') ?? target
  if (raw === undefined || !/^\d+$/.test(raw)) throw new UsageError(USAGE)
  const entryId = Number(raw)
  const ctx = createLocalContext(args)
  const timezone = ctx.timezone
  ctx.db.close()

  const bita = await findBita()
  const entry = bita === null ? null : await bita.entry(entryId).catch(() => null)
  const { defaultMeetingExportEnvironment, exportMeeting, withWorkDir } = await import('../../export/meeting.ts')
  const result = await withWorkDir(async (workDir) =>
    exportMeeting(
      {
        entryId,
        out: readString(args, 'out'),
        timezone,
        entry: entry === null ? null : { description: entry.description, projectName: entry.projectName, clientName: null },
        workDir,
      },
      await defaultMeetingExportEnvironment(workDir),
    ),
  )
  if (json) writeJson(successEnvelope('export meeting', result))
  else writeOut(`Exported the minutes of entry ${entryId} to ${result.path}`)
  return 0
}
