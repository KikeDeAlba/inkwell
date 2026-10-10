import { dirname, join } from 'node:path'
import { platformContext, toolDirs, type PlatformContext } from '@kikedealba/kit/platform'

export const DB_PATH_ENV_VAR = 'INKWELL_DB_PATH'
export const DOCS_DIR_ENV_VAR = 'INKWELL_DOCS_DIR'
export const MEMORY_DB_PATH = ':memory:'

export function dataDir(ctx: PlatformContext = platformContext()): string {
  return toolDirs('inkwell', ctx).data
}

export function databasePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DB_PATH_ENV_VAR]
  if (override) return override
  return join(dataDir(platformContext({ env })), 'inkwell.db')
}

export function docsRoot(env: NodeJS.ProcessEnv = process.env, databaseLocation?: string, explicitDatabase = false): string {
  const override = env[DOCS_DIR_ENV_VAR]
  if (override) return override
  if (databaseLocation && databaseLocation !== MEMORY_DB_PATH && (explicitDatabase || env[DB_PATH_ENV_VAR])) {
    return join(dirname(databaseLocation), 'docs')
  }
  return join(dataDir(platformContext({ env })), 'docs')
}
