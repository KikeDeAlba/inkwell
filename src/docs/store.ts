import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ConflictError } from '../errors.ts'
import { DOC_LOCK_STALE_MS, DOC_LOCK_TIMEOUT_MS } from '../config/constants.ts'
import { checksumOf, filledSections, parseDocument, renderDocument, type ParsedDocument } from './markdown.ts'

const BACKOFF_MS = [10, 20, 40, 80, 160, 320]

export interface WriteResult {
  path: string
  created: boolean
  changed: boolean
  sectionCount: number
  byteSize: number
  checksum: string
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath)
    return Date.now() - info.mtimeMs > DOC_LOCK_STALE_MS
  } catch {
    return false
  }
}

async function acquire(lockPath: string): Promise<void> {
  const deadline = Date.now() + DOC_LOCK_TIMEOUT_MS
  let attempt = 0

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      await handle.close()
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error

      if (await lockIsStale(lockPath)) {
        await unlink(lockPath).catch(() => undefined)
        continue
      }

      if (Date.now() >= deadline) {
        throw new ConflictError(
          `Another process is writing ${lockPath.replace(/\.lock$/, '')}.`,
          'DOC_LOCKED',
          'Wait for it to finish, then run the command again.',
        )
      }

      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 320
      attempt += 1
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
}

export async function withDocLock<T>(absolutePath: string, run: () => Promise<T>): Promise<T> {
  const lockPath = `${absolutePath}.lock`
  await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 })
  await acquire(lockPath)
  try {
    return await run()
  } finally {
    await unlink(lockPath).catch(() => undefined)
  }
}

export async function readRaw(absolutePath: string): Promise<string | null> {
  try {
    return await readFile(absolutePath, 'utf8')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

export async function readDocument(absolutePath: string): Promise<ParsedDocument | null> {
  const raw = await readRaw(absolutePath)
  return raw === null ? null : parseDocument(raw)
}

export async function writeDocument(absolutePath: string, doc: ParsedDocument): Promise<WriteResult> {
  const contents = renderDocument(doc)
  const previous = await readRaw(absolutePath)
  const created = previous === null

  if (previous === contents) {
    return {
      path: absolutePath,
      created: false,
      changed: false,
      sectionCount: filledSections(doc).length,
      byteSize: Buffer.byteLength(contents),
      checksum: checksumOf(contents),
    }
  }

  await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 })
  const staging = `${absolutePath}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
  try {
    await writeFile(staging, contents, { encoding: 'utf8', mode: 0o600 })
    await rename(staging, absolutePath)
  } finally {
    await rm(staging, { force: true }).catch(() => undefined)
  }

  return {
    path: absolutePath,
    created,
    changed: true,
    sectionCount: filledSections(doc).length,
    byteSize: Buffer.byteLength(contents),
    checksum: checksumOf(contents),
  }
}

export async function renameDocument(fromPath: string, toPath: string): Promise<boolean> {
  try {
    await mkdir(dirname(toPath), { recursive: true, mode: 0o700 })
    await rename(fromPath, toPath)
    return true
  } catch {
    return false
  }
}

export async function removeDocument(absolutePath: string): Promise<boolean> {
  try {
    await unlink(absolutePath)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}
