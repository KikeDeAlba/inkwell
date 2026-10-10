import { existsSync } from 'node:fs'
import path from 'node:path'
import { agents } from '@kikedealba/kit'
import type { PlatformContext } from '@kikedealba/kit/platform'
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
    skills: [{ name: 'inkwell', dir: path.join(PACKAGE_ROOT, 'skill') }],
    mcp: options.drawio === false ? [] : [DRAWIO_MCP],
    claude: {
      permissions: {
        allow: [
          'Bash(inkwell tree:*)',
          'Bash(inkwell ls:*)',
          'Bash(inkwell show:*)',
          'Bash(inkwell search:*)',
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
