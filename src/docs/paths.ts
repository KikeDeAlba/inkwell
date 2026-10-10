import { isAbsolute, relative, resolve, sep } from 'node:path'
import { UsageError } from '../errors.ts'

export function resolveDocPath(root: string, relPath: string): string {
  if (relPath.length === 0) throw new UsageError('A document path cannot be empty.')
  if (isAbsolute(relPath) || /^[A-Za-z]:[\\/]/.test(relPath) || relPath.startsWith('\\')) {
    throw new UsageError(`A document path must be relative to the docs root: "${relPath}".`)
  }

  const base = resolve(root)
  const target = resolve(base, relPath)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new UsageError(`"${relPath}" escapes the docs root.`)
  }
  return target
}

export function relativeDocPath(root: string, absolutePath: string): string {
  const relPath = relative(resolve(root), resolve(absolutePath))
  if (relPath.length === 0 || relPath.startsWith('..') || isAbsolute(relPath)) {
    throw new UsageError(`"${absolutePath}" is not inside the docs root.`)
  }
  return relPath.split(sep).join('/')
}
