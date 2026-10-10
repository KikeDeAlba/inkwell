import { spawn } from 'node:child_process'

const GIT_TIMEOUT_MS = 3000

export interface GitResult {
  code: number | null
  stdout: string
  stderr: string
  missing: boolean
}

export interface GitExecOptions {
  cwd: string
  env?: NodeJS.ProcessEnv | undefined
  input?: string | undefined
  timeoutMs?: number | undefined
}

export function execGit(args: readonly string[], options: GitExecOptions): Promise<GitResult> {
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (result: GitResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }

    const child = spawn('git', args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? GIT_TIMEOUT_MS)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ code: null, stdout: '', stderr: error.message, missing: error.code === 'ENOENT' })
    })
    child.on('close', (code) => {
      finish({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        missing: false,
      })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input ?? '')
  })
}
