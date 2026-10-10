import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConflictError } from '../errors.ts'
import { chromeInstallHint } from '../docs/apps.ts'
import { renderMermaidSvg } from '../docs/render.ts'
import type { MermaidRenderer } from './minutes.ts'

export const CHROME_TIMEOUT_MS = 180_000

export interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
}

export type ProcessRunner = (command: string, args: readonly string[], timeoutMs: number) => Promise<ProcessResult>

export const processRunner: ProcessRunner = (command, args, timeoutMs) =>
  new Promise((done) => {
    execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command) }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
      done({ code, stdout: String(stdout), stderr: String(stderr) || (error?.message ?? '') })
    })
  })

export interface PrintEnvironment {
  run: ProcessRunner
  exists: (path: string) => boolean
  chromeApp: string | null
}

export const CHROME_ISOLATION_FLAGS: readonly string[] = ['--use-mock-keychain', '--password-store=basic', '--no-service-autorun', '--disable-sync']

export function chromePdfArgs(htmlPath: string, outPath: string, profileDir: string): string[] {
  return [
    '--headless=new',
    ...CHROME_ISOLATION_FLAGS,
    '--disable-gpu',
    '--no-pdf-header-footer',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
    `--print-to-pdf=${outPath}`,
    pathToFileURL(htmlPath).href,
  ]
}

export async function printToPdf(htmlPath: string, outPath: string, workDir: string, env: PrintEnvironment): Promise<void> {
  if (env.chromeApp === null || !env.exists(env.chromeApp)) {
    throw new ConflictError('Google Chrome (or another Chromium browser) is not installed, and it is what prints the PDF.', 'CHROME_MISSING', chromeInstallHint())
  }
  await rm(outPath, { force: true })
  const result = await env.run(env.chromeApp, chromePdfArgs(htmlPath, outPath, join(workDir, 'chrome-profile')), CHROME_TIMEOUT_MS)
  if (!env.exists(outPath)) {
    const detail = result.stderr.trim().split('\n').slice(-2).join(' ')
    throw new ConflictError(`Chrome did not write the PDF${detail ? `: ${detail}` : '.'}`, 'PDF_FAILED')
  }
}

export function mermaidRendererIn(workDir: string): MermaidRenderer {
  return async (source, name) => {
    await mkdir(workDir, { recursive: true, mode: 0o700 })
    return renderMermaidSvg(source, workDir, name)
  }
}

export function downloadsDir(): string {
  return join(homedir(), 'Downloads')
}

export async function withWorkDir<T>(run: (workDir: string) => Promise<T>): Promise<T> {
  const workDir = await mkdtemp(join(tmpdir(), 'inkwell-export-'))
  try {
    return await run(workDir)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
