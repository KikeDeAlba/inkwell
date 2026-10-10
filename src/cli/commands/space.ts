import type { DatabaseSync } from 'node:sqlite'
import { listBacklogItems } from '../../db/backlog.ts'
import { listPages } from '../../db/pages.ts'
import { insertSpace, listSpaces, resolveSpaceArg, updateSpace, type SpaceUpdate } from '../../db/spaces.ts'
import type { SpaceRow } from '../../db/rows.ts'
import { normalizeSiteUrl, parseConfluenceRef } from '../../confluence/refs.ts'
import { UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString, splitPositionals, type ParsedArgs } from '../args.ts'
import { withLocalContext } from '../context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { defaultSiteUrl } from '../spaces.ts'
import { renderTable } from '../table.ts'
import { atlassianOf } from './docs.ts'

const ACTIONS = new Set(['ls', 'add', 'show', 'set'])

const OPTIONS = {
  name: { type: 'string' as const },
  key: { type: 'string' as const },
  client: { type: 'string' as const },
  active: { type: 'string' as const },
  site: { type: 'string' as const },
  confluence: { type: 'string' as const },
  pull: { type: 'string' as const },
  push: { type: 'string' as const },
  'external-ref': { type: 'string' as const },
  all: { type: 'boolean' as const, default: false },
}

function toggle(args: ParsedArgs, name: string): boolean | undefined {
  const raw = readString(args, name)
  if (raw === undefined) return undefined
  if (['on', 'true', 'yes', '1'].includes(raw.toLowerCase())) return true
  if (['off', 'false', 'no', '0'].includes(raw.toLowerCase())) return false
  throw new UsageError(`--${name} takes on or off.`)
}

function updateFrom(args: ParsedArgs): SpaceUpdate {
  const update: SpaceUpdate = {}
  const name = readString(args, 'name')
  if (name !== undefined) update.name = name
  const key = readString(args, 'key')
  if (key !== undefined) update.key = key
  const client = readString(args, 'client')
  if (client !== undefined) update.clientName = client === 'none' || client.length === 0 ? null : client
  const active = toggle(args, 'active')
  if (active !== undefined) update.active = active
  const external = readString(args, 'external-ref')
  if (external !== undefined) update.externalRef = external === 'none' || external.length === 0 ? null : external
  const site = readString(args, 'site')
  if (site !== undefined) {
    if (site === 'none' || site.length === 0) update.site = null
    else {
      const normalized = /^https?:\/\//i.test(site) || site.includes('.') ? normalizeSiteUrl(site) : site
      if (normalized === null) throw new UsageError(`"${site}" is not an Atlassian site.`)
      update.site = normalized
    }
  }
  const confluence = readString(args, 'confluence')
  if (confluence !== undefined) {
    const parsed = parseConfluenceRef(confluence)
    update.confluence = parsed === null ? null : { ref: parsed.ref, kind: parsed.kind }
    if (parsed?.site && update.site === undefined) update.site = parsed.site
  }
  const pull = toggle(args, 'pull')
  if (pull !== undefined) update.syncPull = pull
  const push = toggle(args, 'push')
  if (push !== undefined) update.syncPush = push
  return update
}

export function spaceView(db: DatabaseSync, space: SpaceRow) {
  const backlog = listBacklogItems(db, { projectId: space.id, status: 'all' })
  return {
    id: space.id,
    projectId: space.id,
    name: space.name,
    key: space.key,
    externalRef: space.externalRef,
    clientName: space.clientName,
    active: space.active,
    createdAt: space.createdAt,
    pageCount: listPages(db, space.id).length,
    backlog: {
      open: backlog.filter((item) => item.status === 'open').length,
      resolved: backlog.filter((item) => item.status === 'resolved').length,
    },
    atlassian: atlassianOf(space, defaultSiteUrl(db) ?? null),
  }
}

export async function runSpace(argv: string[]): Promise<number> {
  const action = argv[0] ?? 'ls'
  if (!ACTIONS.has(action)) throw new UsageError(`Usage: inkwell space <${[...ACTIONS].join('|')}>`)
  const { positional, flags } = splitPositionals(argv.slice(1))
  const args = parseCommandArgs(flags, OPTIONS, BASE_OPTIONS)
  positional.push(...args.positionals)
  const json = readBoolean(args, 'json')

  return withLocalContext(args, (ctx) => {
    if (action === 'ls') {
      const spaces = listSpaces(ctx.db, true).filter((space) => readBoolean(args, 'all') || space.active)
      const data = spaces.map((space) => spaceView(ctx.db, space))
      if (json) {
        writeJson(successEnvelope('space ls', data))
        return 0
      }
      if (data.length === 0) {
        writeOut('No spaces yet. Create one with "inkwell space add <name>".')
        return 0
      }
      writeOut(
        renderTable(
          [{ header: 'ID', align: 'right' }, { header: 'KEY' }, { header: 'NAME' }, { header: 'PAGES', align: 'right' }, { header: 'CONFLUENCE' }],
          data.map((space) => [String(space.id), space.key ?? '', space.name, String(space.pageCount), space.atlassian.confluence?.spaceKey ?? space.atlassian.confluence?.url ?? '']),
        ),
      )
      return 0
    }

    if (action === 'add') {
      const name = positional.join(' ').trim() || readString(args, 'name')
      if (name === undefined || name.length === 0) throw new UsageError('Usage: inkwell space add <name> [--key K] [--confluence <url|KEY>] [--site <url>] [--pull on] [--push on]')
      const key = readString(args, 'key')
      const created = insertSpace(ctx.db, { name, ...(key !== undefined ? { key } : {}), createdAt: ctx.now.toISOString() })
      const { name: _ignored, key: _key, ...rest } = updateFrom(args)
      const space = updateSpace(ctx.db, created.id, rest)
      const data = spaceView(ctx.db, space)
      if (json) writeJson(successEnvelope('space add', data))
      else writeOut(`#${space.id} ${space.name} (${space.key ?? ''})`)
      return 0
    }

    const raw = positional[0]
    if (raw === undefined) throw new UsageError(`Usage: inkwell space ${action} <space>`)
    const space = resolveSpaceArg(ctx.db, raw)

    if (action === 'show') {
      const data = spaceView(ctx.db, space)
      if (json) {
        writeJson(successEnvelope('space show', data))
        return 0
      }
      writeOut(`#${data.id} ${data.name} (${data.key ?? ''})`)
      writeOut(`pages: ${data.pageCount}, backlog: ${data.backlog.open} open / ${data.backlog.resolved} resolved`)
      if (data.atlassian.confluence) writeOut(`confluence: ${data.atlassian.confluence.url ?? data.atlassian.confluence.spaceKey ?? ''} (pull ${data.atlassian.sync.pull ? 'on' : 'off'}, push ${data.atlassian.sync.push ? 'on' : 'off'})`)
      return 0
    }

    const update = updateFrom(args)
    if (Object.keys(update).length === 0) throw new UsageError('Nothing to change. Pass --name, --key, --client, --active, --site, --confluence, --pull or --push.')
    const updated = updateSpace(ctx.db, space.id, update)
    const data = spaceView(ctx.db, updated)
    if (json) writeJson(successEnvelope('space set', data))
    else writeOut(`#${updated.id} ${updated.name} updated.`)
    return 0
  })
}
