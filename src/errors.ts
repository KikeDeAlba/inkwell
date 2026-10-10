export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  notFound: 3,
  conflict: 9,
} as const

export class ConflictError extends Error {
  readonly code: string
  readonly hint: string | undefined

  constructor(message: string, code: string, hint?: string) {
    super(message)
    this.name = 'ConflictError'
    this.code = code
    this.hint = hint
  }
}

export class NotFoundError extends Error {
  readonly code: string
  readonly hint: string | undefined

  constructor(message: string, code: string, hint?: string) {
    super(message)
    this.name = 'NotFoundError'
    this.code = code
    this.hint = hint
  }
}

export class UsageError extends Error {
  readonly code = 'USAGE_ERROR'
  readonly hint: string | undefined

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'UsageError'
    this.hint = hint
  }
}

export class MergeConflictError extends ConflictError {
  readonly paths: string[]

  constructor(message: string, paths: string[], hint?: string) {
    super(message, 'MERGE_CONFLICT', hint)
    this.name = 'MergeConflictError'
    this.paths = paths
  }
}

export function exitCodeOf(error: unknown): number {
  if (error instanceof UsageError) return EXIT.usage
  if (error instanceof NotFoundError) return EXIT.notFound
  if (error instanceof ConflictError) return EXIT.conflict
  return EXIT.failure
}
