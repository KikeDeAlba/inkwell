import { errorEnvelope as kitError, successEnvelope as kitSuccess, writeJson as kitWriteJson, type Envelope } from '@kikedealba/kit/envelope'
import { SCHEMA_VERSION } from '../version.ts'

export type { Envelope }

export function successEnvelope<T>(command: string, data: T, meta?: Record<string, unknown>): Envelope<T> {
  return kitSuccess(SCHEMA_VERSION, command, data, meta)
}

export function errorEnvelope(
  command: string,
  error: { code: string; message: string; hint?: string; status?: number; paths?: string[] },
  data?: unknown,
  meta?: Record<string, unknown>,
): Envelope<unknown> {
  return kitError(SCHEMA_VERSION, command, error, data, meta)
}

export function writeJson(value: unknown): void {
  kitWriteJson(value)
}

export function writeOut(line: string): void {
  process.stdout.write(`${line}\n`)
}

export function writeErr(line: string): void {
  process.stderr.write(`${line}\n`)
}
