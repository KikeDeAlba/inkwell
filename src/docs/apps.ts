import { existsSync } from 'node:fs'
import path from 'node:path'
import { platformContext, which, type PlatformContext } from '@kikedealba/kit/platform'

export const CHROME_ENV_VAR = 'INKWELL_CHROME'
export const DRAWIO_ENV_VAR = 'INKWELL_DRAWIO'

function programDirs(ctx: PlatformContext): string[] {
  const env = ctx.env
  return [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LOCALAPPDATA'] ? path.win32.join(env['LOCALAPPDATA'], 'Programs') : undefined, env['LOCALAPPDATA']].filter(
    (dir): dir is string => typeof dir === 'string' && dir.length > 0,
  )
}

export function chromeCandidates(ctx: PlatformContext = platformContext()): string[] {
  if (ctx.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.posix.join(ctx.home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  }
  if (ctx.platform === 'win32') {
    return programDirs(ctx).flatMap((dir) => [
      path.win32.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.win32.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ])
  }
  return []
}

export function drawioCandidates(ctx: PlatformContext = platformContext()): string[] {
  if (ctx.platform === 'darwin') {
    return ['/Applications/draw.io.app/Contents/MacOS/draw.io', path.posix.join(ctx.home, 'Applications/draw.io.app/Contents/MacOS/draw.io')]
  }
  if (ctx.platform === 'win32') return programDirs(ctx).map((dir) => path.win32.join(dir, 'draw.io', 'draw.io.exe'))
  return ['/opt/drawio/drawio', '/usr/bin/drawio', '/snap/bin/drawio']
}

const LINUX_CHROME = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']

export async function findChrome(ctx: PlatformContext = platformContext(), exists: (file: string) => boolean = existsSync): Promise<string | null> {
  const explicit = ctx.env[CHROME_ENV_VAR]
  if (explicit) return exists(explicit) ? explicit : null
  const fixed = chromeCandidates(ctx).find((candidate) => exists(candidate))
  if (fixed) return fixed
  if (ctx.platform !== 'linux') return null
  for (const name of LINUX_CHROME) {
    const found = await which(name, ctx)
    if (found) return found
  }
  return null
}

export async function findDrawio(ctx: PlatformContext = platformContext(), exists: (file: string) => boolean = existsSync): Promise<string | null> {
  const explicit = ctx.env[DRAWIO_ENV_VAR]
  if (explicit) return exists(explicit) ? explicit : null
  const fixed = drawioCandidates(ctx).find((candidate) => exists(candidate))
  if (fixed) return fixed
  return (await which('drawio', ctx)) ?? (await which('draw.io', ctx))
}

export function chromeInstallHint(ctx: PlatformContext = platformContext()): string {
  if (ctx.platform === 'darwin') return 'Install it with "brew install --cask google-chrome", or point INKWELL_CHROME at a Chromium-based browser.'
  if (ctx.platform === 'win32') return 'Install it with "winget install Google.Chrome", or point INKWELL_CHROME at chrome.exe or msedge.exe.'
  return 'Install google-chrome or chromium with your package manager, or point INKWELL_CHROME at the binary.'
}

export function drawioInstallHint(ctx: PlatformContext = platformContext()): string {
  if (ctx.platform === 'darwin') return 'Install it with "brew install --cask drawio", or point INKWELL_DRAWIO at the binary.'
  if (ctx.platform === 'win32') return 'Install it with "winget install JGraph.Draw", or point INKWELL_DRAWIO at draw.io.exe.'
  return 'Install draw.io Desktop (https://www.drawio.com/), or point INKWELL_DRAWIO at the binary.'
}
