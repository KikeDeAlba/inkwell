import { agents } from '@kikedealba/kit'
import { capabilitiesOf } from '@kikedealba/kit/registry'
import { readSetting, writeSetting, TIMEZONE_KEY } from '../../db/settings.ts'
import { findChrome, findDrawio, chromeInstallHint, drawioInstallHint } from '../../docs/apps.ts'
import { gitAvailable } from '../../docs/git.ts'
import { UsageError } from '../../errors.ts'
import { bitaLocation, migrateFromBita, migrationStatus } from '../../migrate/from-bita.ts'
import { integration, manifest, register, unregister } from '../../setup.ts'
import { normalizeSiteUrl } from '../../confluence/refs.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString } from '../args.ts'
import { withLocalContext } from '../context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'
import { SITE_KEY } from '../spaces.ts'

export function runCapabilities(argv: string[]): number {
  const args = parseCommandArgs(argv, {}, BASE_OPTIONS)
  const data = capabilitiesOf(manifest())
  if (readBoolean(args, 'json')) writeJson(successEnvelope('capabilities', data))
  else writeOut(`${data.name} ${data.version}\n${data.capabilities.join('\n')}`)
  return 0
}

function agentSelection(raw: string | undefined): readonly agents.AgentName[] | 'detected' | 'all' {
  if (raw === undefined || raw === 'detected') return 'detected'
  if (raw === 'all') return 'all'
  const names = raw.split(',').map((name) => name.trim()).filter((name) => name.length > 0)
  const unknown = names.filter((name) => !(agents.AGENTS as readonly string[]).includes(name))
  if (unknown.length > 0) throw new UsageError(`Unknown agent ${unknown.join(', ')}. Use ${agents.AGENTS.join(', ')}, detected or all.`)
  return names as agents.AgentName[]
}

export async function runSetup(argv: string[]): Promise<number> {
  const args = parseCommandArgs(
    argv,
    { agents: { type: 'string' }, 'no-agents': { type: 'boolean', default: false }, 'no-drawio': { type: 'boolean', default: false } },
    BASE_OPTIONS,
  )
  const json = readBoolean(args, 'json')
  const manifestPath = await register()
  const steps = readBoolean(args, 'no-agents')
    ? []
    : await agents.installIntegration(integration({ drawio: !readBoolean(args, 'no-drawio') }), { agents: agentSelection(readString(args, 'agents')) })
  const chrome = await findChrome()
  const drawio = await findDrawio()
  const git = await gitAvailable()
  const apps = {
    git: { found: git, hint: git ? null : 'Install git: the docs keep their history in it.' },
    chrome: { path: chrome, hint: chrome ? null : chromeInstallHint() },
    drawio: { path: drawio, hint: drawio ? null : drawioInstallHint() },
  }
  const migration = await withLocalContext(args, (ctx) => migrationStatus(ctx.db))
  const bita = bitaLocation()
  const data = { manifest: manifestPath, steps, apps, migration, bitaDatabase: bita.database }
  if (json) writeJson(successEnvelope('setup', data))
  else {
    writeOut(`registered in ${manifestPath}`)
    for (const step of steps) writeOut(`${step.state === 'failed' || step.state === 'unavailable' ? '!' : '-'} ${step.agent}: ${step.detail}`)
    if (!git) writeOut(`! ${apps.git.hint}`)
    if (!chrome) writeOut(`! Chrome: ${apps.chrome.hint}`)
    if (!drawio) writeOut(`! draw.io: ${apps.drawio.hint}`)
    if (!migration.migrated) writeOut('If bita has docs, bring them over with "inkwell migrate --from-bita" (try --dry-run first).')
  }
  return steps.some((step) => step.state === 'failed') ? 1 : 0
}

export async function runUninstall(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, {}, BASE_OPTIONS)
  const steps = await agents.uninstallIntegration(integration(), { agents: 'all' })
  const removed = await unregister()
  const data = { unregistered: removed, steps }
  if (readBoolean(args, 'json')) writeJson(successEnvelope('uninstall', data))
  else {
    writeOut(`registry: ${removed ? 'removed' : 'not registered'}`)
    for (const step of steps.filter((item) => item.state === 'removed')) writeOut(`- ${step.agent}: ${step.detail}`)
    writeOut('The pages and their history stay where they are.')
  }
  return 0
}

export async function runMigrate(argv: string[]): Promise<number> {
  const args = parseCommandArgs(
    argv,
    {
      'from-bita': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'bita-db': { type: 'string' },
      'bita-docs': { type: 'string' },
    },
    BASE_OPTIONS,
  )
  const json = readBoolean(args, 'json')
  if (args.positionals[0] === 'status') {
    const status = await withLocalContext(args, (ctx) => migrationStatus(ctx.db))
    if (json) writeJson(successEnvelope('migrate status', status))
    else writeOut(status.migrated ? `Migrated from ${status.bitaDatabase ?? 'bita'} on ${status.migratedAt}.` : 'Not migrated from bita.')
    return 0
  }
  if (!readBoolean(args, 'from-bita')) throw new UsageError('Usage: inkwell migrate --from-bita [--dry-run] [--bita-db PATH] [--bita-docs DIR] | inkwell migrate status')

  const location = bitaLocation(process.env, { database: readString(args, 'bita-db'), docs: readString(args, 'bita-docs') })
  const report = await withLocalContext(args, (ctx) =>
    migrateFromBita(ctx.db, { dryRun: readBoolean(args, 'dry-run'), location, docsRoot: ctx.docsRoot, now: ctx.now }),
  )
  if (json) {
    writeJson(successEnvelope('migrate', report))
    return 0
  }
  if (report.alreadyMigrated) {
    writeOut(`Already migrated from bita on ${report.migratedAt}. Nothing to do.`)
    return 0
  }
  const c = report.counts
  writeOut(
    `${report.dryRun ? 'Would bring' : 'Brought'} ${c.spaces} spaces (${c.spacesReused} already here), ${c.pages} pages, ${c.entryLinks + c.issueLinks} links, ${c.refs} refs, ${c.backlog} backlog items and ${c.confluenceMaps} Confluence maps; ${c.noteFiles} per-entry notes stay out.`,
  )
  writeOut(`docs: ${report.bitaDocs} -> ${report.docsRoot} (${report.docs.source})${report.docs.commit ? ` at ${report.docs.commit.slice(0, 7)}` : ''}`)
  if (report.dryRun) writeOut('Nothing was written: --dry-run.')
  return 0
}

export async function runConfig(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, {}, BASE_OPTIONS)
  const [action, key, value] = args.positionals
  const keys: Record<string, string> = { timezone: TIMEZONE_KEY, site: SITE_KEY }
  return withLocalContext(args, (ctx) => {
    if (action === 'get' || action === undefined) {
      const data = Object.fromEntries(Object.entries(keys).map(([name, stored]) => [name, readSetting(ctx.db, stored) ?? null]))
      if (readBoolean(args, 'json')) writeJson(successEnvelope('config get', key ? { [key]: data[key] ?? null } : data))
      else for (const [name, stored] of Object.entries(data)) if (!key || key === name) writeOut(`${name}: ${stored ?? ''}`)
      return 0
    }
    if (action !== 'set' || key === undefined || value === undefined || keys[key] === undefined) {
      throw new UsageError('Usage: inkwell config get [timezone|site] | inkwell config set <timezone|site> <value>')
    }
    let stored = value
    if (key === 'site') {
      const site = normalizeSiteUrl(value)
      if (site === null) throw new UsageError(`"${value}" is not an Atlassian site URL.`)
      stored = site
    }
    if (key === 'timezone') {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value })
      } catch {
        throw new UsageError(`"${value}" is not a time zone.`)
      }
    }
    writeSetting(ctx.db, keys[key] as string, stored)
    if (readBoolean(args, 'json')) writeJson(successEnvelope('config set', { [key]: stored }))
    else writeOut(`${key}: ${stored}`)
    return 0
  })
}
