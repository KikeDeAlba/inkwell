import { createHash, randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const held = new Set<string>()

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function ownerOf(path: string): number | null {
  try {
    const pid = Number((JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }).pid)
    return Number.isInteger(pid) ? pid : null
  } catch {
    return null
  }
}

function stale(path: string, staleMs: number): boolean {
  try {
    if (Date.now() - statSync(path).mtimeMs > staleMs) return true
  } catch {
    return false
  }
  const pid = ownerOf(path)
  return pid === null || !alive(pid)
}

function release(path: string): void {
  held.delete(path)
  if (ownerOf(path) !== process.pid) return
  try {
    unlinkSync(path)
  } catch {
    return
  }
}

export function releaseHeldSessions(): void {
  for (const path of [...held]) release(path)
}

export function setAside(path: string, staleMs: number): 'removed' | 'busy' | 'gone' {
  const aside = `${path}.stale-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    renameSync(path, aside)
  } catch {
    return 'gone'
  }
  if (!stale(aside, staleMs)) {
    try {
      renameSync(aside, path)
    } catch {
      return 'busy'
    }
    return 'busy'
  }
  try {
    unlinkSync(aside)
  } catch {
    return 'gone'
  }
  return 'removed'
}

export function sessionLockPath(dir: string, sessionId: string): string {
  return join(dir, 'autodoc-locks', `${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}.lock`)
}

export function claimSession(dir: string, sessionId: string, staleMs: number): (() => void) | null {
  const path = sessionLockPath(dir, sessionId)
  mkdirSync(join(dir, 'autodoc-locks'), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      } finally {
        closeSync(fd)
      }
      held.add(path)
      return () => release(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!stale(path, staleMs)) return null
      const taken = setAside(path, staleMs)
      if (taken === 'busy') return null
    }
  }
  return null
}
