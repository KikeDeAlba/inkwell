import { readFile } from 'node:fs/promises'
import { ConflictError, UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString, type ParsedArgs } from '../args.ts'
import { createLocalContext, type LocalContext } from '../context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { adfImage, displaySize, pngSize, storageImage } from '../../confluence/fragments.ts'
import { AtlConfluence, type AttachmentInfo, type ConfluenceGateway } from '../../confluence/gateway.ts'
import { normalizeSiteUrl } from '../../confluence/refs.ts'
import { resolveConflict, syncProject, syncStatus, type ProjectSyncReport } from '../../confluence/sync.ts'
import { mapsOfSpace } from '../../db/confluence-map.ts'
import { addRefToPage } from '../../db/page-refs.ts'
import { findPage } from '../../db/pages.ts'
import { findSpaceById, listSpaces, resolveSpaceArg } from '../../db/spaces.ts'
import type { SpaceRow } from '../../db/rows.ts'
import { defaultSiteUrl } from '../spaces.ts'
import { renderPageDiagrams } from './diagrams.ts'

const ACTIONS = new Set(['sync', 'status', 'conflict', 'publish-diagrams'])

const OPTIONS = {
  site: { type: 'string' as const },
  to: { type: 'string' as const },
  keep: { type: 'string' as const },
  all: { type: 'boolean' as const, default: false },
  force: { type: 'boolean' as const, default: false },
  'dry-run': { type: 'boolean' as const, default: false },
}

export type GatewayFactory = (site: string | null) => Promise<ConfluenceGateway>

let factory: GatewayFactory = async (site) => AtlConfluence.connect(site)

export function setGatewayFactory(next: GatewayFactory | null): void {
  factory = next ?? (async (site) => AtlConfluence.connect(site))
}

function siteFor(ctx: LocalContext, args: ParsedArgs, space: SpaceRow | undefined): string | null {
  const raw = readString(args, 'site') ?? space?.atlassianSite ?? defaultSiteUrl(ctx.db) ?? null
  if (raw === null) return null
  return normalizeSiteUrl(raw) ?? raw
}

function syncTargets(ctx: LocalContext, args: ParsedArgs, raw: string | undefined): SpaceRow[] {
  if (raw !== undefined) return [resolveSpaceArg(ctx.db, raw)]
  if (!readBoolean(args, 'all')) throw new UsageError('Usage: inkwell confluence sync <space>|--all [--dry-run]')
  return listSpaces(ctx.db).filter((space) => space.confluenceRef !== null && (space.syncPull || space.syncPush))
}

function syncCounts(report: ProjectSyncReport): string {
  return `pulled ${report.pulled.length}, pushed ${report.pushed.length}, created ${report.created.length}, conflicts ${report.conflicts.length}, skipped ${report.skipped.length}`
}

async function runSync(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  if (args.positionals[0] === 'status') return runSyncStatus(ctx, args, json, args.positionals[1])
  const dryRun = readBoolean(args, 'dry-run')
  const targets = syncTargets(ctx, args, args.positionals[0])
  const reports: ProjectSyncReport[] = []
  for (const space of targets) {
    if (space.confluenceRef === null || (!space.syncPull && !space.syncPush)) {
      reports.push({
        project: space.name,
        pulled: [],
        pushed: [],
        created: [],
        conflicts: [],
        skipped: [{ title: space.name, reason: space.confluenceRef === null ? 'no Confluence page or space set' : 'pull and push are off' }],
      })
      continue
    }
    const gateway = await factory(siteFor(ctx, args, space))
    reports.push(await syncProject(ctx, gateway, space, gateway.site, { dryRun }))
  }

  if (json) {
    writeJson(successEnvelope('confluence sync', reports, { dryRun }))
    return 0
  }
  if (reports.length === 0) writeOut('No space syncs with Confluence. Turn it on with "inkwell space set <space> --confluence <url|KEY> --pull on".')
  for (const report of reports) {
    writeOut(`${report.project}: ${syncCounts(report)}${dryRun ? ' (dry run)' : ''}`)
    for (const conflict of report.conflicts) writeOut(`  conflict #${conflict.pageId ?? '-'} ${conflict.title}: ${conflict.reason ?? ''}`)
  }
  return 0
}

async function runSyncStatus(ctx: LocalContext, args: ParsedArgs, json: boolean, raw: string | undefined): Promise<number> {
  if (raw === undefined) throw new UsageError('Usage: inkwell confluence status <space> [--offline]')
  const space = resolveSpaceArg(ctx.db, raw)
  let gateway: ConfluenceGateway | null = null
  if (!readBoolean(args, 'offline') && mapsOfSpace(ctx.db, space.id).length > 0) gateway = await factory(siteFor(ctx, args, space))
  const mappings = await syncStatus(ctx, gateway, space)
  if (json) {
    writeJson(successEnvelope('confluence sync status', mappings, { project: space.name, lastSyncAt: space.lastSyncAt, offline: gateway === null }))
    return 0
  }
  if (mappings.length === 0) writeOut(`${space.name} has no pages tied to Confluence yet.`)
  for (const mapping of mappings) writeOut(`#${mapping.pageId} ${mapping.title} <-> ${mapping.confluenceId}  ${mapping.state}  ${mapping.direction}`)
  return 0
}

async function runConflict(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  const [action, target] = args.positionals
  if (action === 'ls' || action === 'list' || action === undefined) {
    const spaces = target !== undefined ? [resolveSpaceArg(ctx.db, target)] : listSpaces(ctx.db)
    const conflicts = spaces.flatMap((space) =>
      mapsOfSpace(ctx.db, space.id, 'conflict').map((map) => ({
        pageId: map.pageId,
        title: findPage(ctx.db, map.pageId)?.title ?? '',
        project: space.name,
        confluenceId: map.confluenceId,
        site: map.site,
        since: map.syncedAt,
      })),
    )
    if (json) writeJson(successEnvelope('confluence conflict ls', conflicts))
    else if (conflicts.length === 0) writeOut('No conflicts.')
    else for (const conflict of conflicts) writeOut(`#${conflict.pageId} ${conflict.title} (${conflict.project}) <-> ${conflict.confluenceId}`)
    return 0
  }

  if (action === 'resolve') {
    const pageId = Number(target)
    const keep = readString(args, 'keep')
    if (!Number.isInteger(pageId) || pageId <= 0 || (keep !== 'local' && keep !== 'remote' && keep !== 'both')) {
      throw new UsageError('Usage: inkwell confluence conflict resolve <pageId> --keep local|remote|both')
    }
    const page = findPage(ctx.db, pageId)
    const owner = page?.spaceId ? findSpaceById(ctx.db, page.spaceId) : undefined
    const gateway = await factory(siteFor(ctx, args, owner))
    const resolved = await resolveConflict(ctx, gateway, pageId, keep)
    if (json) writeJson(successEnvelope('confluence conflict resolve', resolved))
    else writeOut(`#${pageId} ${resolved.title}: ${resolved.reason ?? 'resolved'}.`)
    return 0
  }

  throw new UsageError('Usage: inkwell confluence conflict <ls [space]|resolve <pageId> --keep local|remote|both>')
}

export interface PlacedImage {
  attachment: AttachmentInfo
  adf: Record<string, unknown> | null
  storage: string
  width: number | null
  height: number | null
}

async function attachImage(gateway: ConfluenceGateway, pageId: string, path: string, comment?: string): Promise<PlacedImage> {
  const attachment = await gateway.attach(pageId, path, comment)
  const size = attachment.mediaType === 'image/png' || path.endsWith('.png') ? displaySize(pngSize(await readFile(path))) : null
  return {
    attachment,
    adf: adfImage(pageId, attachment, size),
    storage: storageImage(attachment.filename, size),
    width: size?.width ?? null,
    height: size?.height ?? null,
  }
}

async function runPublishDiagrams(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  const usage = 'Usage: inkwell confluence publish-diagrams <pageId> --to <confluencePageId>'
  const localId = Number(args.positionals[0])
  const target = readString(args, 'to')
  if (!Number.isInteger(localId) || localId <= 0 || target === undefined || !/^\d+$/.test(target)) throw new UsageError(usage)

  const local = findPage(ctx.db, localId)
  const owner = local?.spaceId ? findSpaceById(ctx.db, local.spaceId) : undefined
  const { diagrams, results } = await renderPageDiagrams(ctx, localId, { force: readBoolean(args, 'force') })
  const failed = results.filter((result) => result.state === 'failed' || result.state === 'missing-source')
  if (failed.length > 0) {
    const names = failed.map((result) => `${result.kind} ${result.name}${result.error ? ` (${result.error})` : ''}`)
    throw new ConflictError(`Some diagrams could not be rendered: ${names.join('; ')}.`, 'DIAGRAM_RENDER_FAILED', 'Fix them and run "inkwell diagrams render" first; nothing was uploaded.')
  }

  const gateway = await factory(siteFor(ctx, args, owner))
  const published = []
  for (const [at, result] of results.entries()) {
    const block = diagrams.blocks[at]!
    const image = await attachImage(gateway, target, result.imagePath, `inkwell: ${block.kind} ${block.name}`)
    const source = await gateway.attach(target, result.sourcePath, `inkwell: source of ${block.imageFile}`)
    published.push({ index: block.index, kind: block.kind, name: block.name, line: block.line, image, source })
  }

  const remote = await gateway.page(target)
  if (remote.url) {
    addRefToPage(ctx.db, localId, { url: remote.url, title: remote.title, kind: 'confluence', source: 'manual', now: ctx.now.toISOString() })
  }

  const data = { pageId: localId, bitaPageId: localId, confluencePageId: target, confluenceTitle: remote.title, confluenceUrl: remote.url, diagrams: published }
  if (json) {
    writeJson(successEnvelope('confluence publish-diagrams', data))
    return 0
  }
  if (published.length === 0) writeOut(`Page #${localId} has no diagrams to publish.`)
  for (const item of published) writeOut(`#${item.index} ${item.kind} ${item.name}: ${item.image.attachment.filename} + ${item.source.filename}`)
  return 0
}

export async function runConfluence(argv: string[]): Promise<number> {
  const action = argv[0]
  if (action === undefined || !ACTIONS.has(action)) throw new UsageError(`Usage: inkwell confluence <${[...ACTIONS].join('|')}>`)
  const args = parseCommandArgs(argv.slice(1), OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const ctx = createLocalContext(args)
  try {
    if (action === 'sync') return await runSync(ctx, args, json)
    if (action === 'status') return await runSyncStatus(ctx, args, json, args.positionals[0])
    if (action === 'conflict') return await runConflict(ctx, args, json)
    return await runPublishDiagrams(ctx, args, json)
  } finally {
    ctx.db.close()
  }
}
