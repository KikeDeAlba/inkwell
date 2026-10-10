import { stat } from 'node:fs/promises'
import { checksumOf } from './markdown.ts'
import { resolveDocPath } from './paths.ts'
import { readRaw } from './store.ts'

export type DocFileStatus = 'ok' | 'changed' | 'missing' | 'unverified'

export interface DocFileRef {
  relPath: string
  checksum: string
  byteSize: number
}

export interface DocFileState {
  status: DocFileStatus
  path: string
  checksum: string | null
  recordedChecksum: string
  byteSize: number | null
  recordedByteSize: number
  mtime: string | null
}

export interface InspectedDoc {
  state: DocFileState
  raw: string | null
}

export interface InspectOptions {
  verify?: boolean
}

export async function inspectDocFile(
  docsRoot: string,
  row: DocFileRef,
  options: InspectOptions = {},
): Promise<InspectedDoc> {
  const verify = options.verify ?? true
  const path = resolveDocPath(docsRoot, row.relPath)

  const base = {
    path,
    recordedChecksum: row.checksum,
    recordedByteSize: row.byteSize,
  }

  if (!verify) {
    return {
      state: { ...base, status: 'unverified', checksum: null, byteSize: null, mtime: null },
      raw: null,
    }
  }

  const raw = await readRaw(path)
  if (raw === null) {
    return {
      state: { ...base, status: 'missing', checksum: null, byteSize: null, mtime: null },
      raw: null,
    }
  }

  const checksum = checksumOf(raw)
  const mtime = await modifiedAt(path)

  return {
    state: {
      ...base,
      status: checksum === row.checksum ? 'ok' : 'changed',
      checksum,
      byteSize: Buffer.byteLength(raw),
      mtime,
    },
    raw,
  }
}

async function modifiedAt(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    return new Date(info.mtimeMs).toISOString()
  } catch {
    return null
  }
}
