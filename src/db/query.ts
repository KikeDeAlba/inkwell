import type { StatementSync, SQLInputValue } from 'node:sqlite'

export function queryAll<T>(statement: StatementSync, ...params: SQLInputValue[]): T[] {
  return statement.all(...params) as unknown as T[]
}

export function queryOne<T>(
  statement: StatementSync,
  ...params: SQLInputValue[]
): T | undefined {
  return statement.get(...params) as unknown as T | undefined
}
