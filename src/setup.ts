import { existsSync } from 'node:fs'
import path from 'node:path'
import { agents } from '@kikedealba/kit'
import { platformContext, type PlatformContext } from '@kikedealba/kit/platform'
import { defineManifest, registerTool, stableBin, unregisterTool, type ToolManifest } from '@kikedealba/kit/registry'
import { PACKAGE_ROOT, VERSION } from './version.ts'

export const CAPABILITIES = [
  'docs.page.read',
  'docs.page.write',
  'docs.backlog',
  'docs.history',
  'docs.propose',
  'docs.diagrams',
  'docs.export.pdf',
  'docs.confluence.sync',
  'docs.entry-notes',
]

export const SUBSCRIBED_EVENTS = ['delete', 'merge', 'cancel', 'start', 'stop', 'amend']

export const INSTALL_HINT = 'npm install -g @kikedealba/inkwell && inkwell setup'

export function binEntry(): string {
  const built = path.join(PACKAGE_ROOT, 'dist', 'bin', 'inkwell.js')
  return existsSync(built) ? built : path.join(PACKAGE_ROOT, 'src', 'bin', 'inkwell.ts')
}

export function binCommand(): string[] {
  return [process.execPath, binEntry()]
}

export async function stableBinCommand(ctx?: PlatformContext): Promise<string[]> {
  return stableBin('inkwell', VERSION, binCommand(), ctx)
}

export function manifest(bin: readonly string[] = binCommand()): ToolManifest {
  return defineManifest({
    name: 'inkwell',
    version: VERSION,
    description: 'Living technical documentation: pages, entry notes, backlog, history, diagrams, PDF and Confluence sync',
    bin: [...bin],
    capabilities: CAPABILITIES,
    subscribes: [{ tool: 'bita', events: SUBSCRIBED_EVENTS, command: [...bin, 'bita-hook'] }],
    homepage: 'https://github.com/KikeDeAlba/inkwell',
    install: INSTALL_HINT,
  })
}

export const DRAWIO_MCP: agents.McpServer = { name: 'drawio', command: ['npx', '-y', '@drawio/mcp'] }

export function integration(options: { drawio?: boolean } = {}): agents.AgentIntegration {
  return {
    tool: 'inkwell',
    version: VERSION,
    description: 'Living technical documentation through inkwell',
    skills: [{ name: 'inkwell', dir: path.join(PACKAGE_ROOT, 'skills', 'inkwell') }],
    mcp: options.drawio === false ? [] : [DRAWIO_MCP],
    claude: {
      permissions: {
        allow: [
          'Bash(inkwell tree:*)',
          'Bash(inkwell ls:*)',
          'Bash(inkwell show:*)',
          'Bash(inkwell search:*)',
          'Bash(inkwell guide:*)',
          'Bash(inkwell page ls:*)',
          'Bash(inkwell page show:*)',
          'Bash(inkwell page history:*)',
          'Bash(inkwell page diff:*)',
          'Bash(inkwell page asset path:*)',
          'Bash(inkwell backlog ls:*)',
          'Bash(inkwell diagrams ls:*)',
          'Bash(inkwell space ls:*)',
          'Bash(inkwell space show:*)',
          'Bash(inkwell branch ls:*)',
          'Bash(inkwell git status:*)',
          'Bash(inkwell confluence status:*)',
          'Bash(inkwell confluence conflict ls:*)',
          'Bash(inkwell note path:*)',
          'Bash(inkwell note show:*)',
          'Bash(inkwell note get:*)',
          'Bash(inkwell note ls:*)',
          'Bash(inkwell note search:*)',
          'Bash(inkwell note save:*)',
          'Bash(inkwell --version)',
        ],
      },
    },
  }
}

export async function register(ctx?: PlatformContext): Promise<string> {
  return registerTool(manifest(await stableBinCommand(ctx)))
}

export async function unregister(): Promise<boolean> {
  return unregisterTool('inkwell')
}

export const CLAUDE_PLUGIN: agents.ClaudePluginSpec = { marketplace: 'KikeDeAlba/inkwell', marketplaceName: 'inkwell', plugin: 'inkwell' }

export type AgentSelection = readonly agents.AgentName[] | 'detected' | 'all'

async function selectedAgents(selection: AgentSelection, options: agents.InstallOptions): Promise<agents.AgentName[]> {
  if (selection === 'all') return [...agents.AGENTS]
  if (selection !== 'detected') return [...selection]
  const ctx = options.ctx ?? platformContext()
  return agents.detectAgents(ctx, agents.agentHomes(ctx, options.homes), options.locate)
}

function blocked(steps: readonly agents.Step[]): boolean {
  return steps.some((step) => step.state === 'failed' || step.state === 'unavailable')
}

export async function installAgents(
  selection: AgentSelection,
  options: agents.InstallOptions & { drawio?: boolean } = {},
): Promise<agents.Step[]> {
  const { drawio, ...install } = options
  const tools = integration(drawio === undefined ? {} : { drawio })
  const wanted = await selectedAgents(selection, install)
  const steps: agents.Step[] = []
  if (wanted.includes('claude')) {
    const plugin = await agents.installClaudePlugin(CLAUDE_PLUGIN, install)
    steps.push(...plugin)
    if (!blocked(plugin)) steps.push(...(await agents.removeLegacyClaude(tools, install)))
  }
  const others = wanted.filter((agent) => agent !== 'claude')
  if (others.length > 0) steps.push(...(await agents.installIntegration(tools, { ...install, agents: others })))
  return steps
}

export async function uninstallAgents(options: agents.InstallOptions = {}): Promise<agents.Step[]> {
  const steps = await agents.uninstallClaudePlugin(CLAUDE_PLUGIN, options)
  steps.push(...(await agents.uninstallIntegration(integration(), { ...options, agents: 'all' })))
  return steps
}
