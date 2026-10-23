import { readFile } from 'node:fs/promises'

const STRIPPED_TAGS = [
  'system-reminder',
  'local-command-stdout',
  'local-command-stderr',
  'command-message',
  'command-args',
  'task-notification',
  'environment_context',
  'user_instructions',
  'skills_instructions',
  'session_context',
  'INSTRUCTIONS',
]

const CODEX_PREAMBLES = ['# AGENTS.md instructions']

export interface TranscriptSlice {
  text: string
  lines: number
  fresh: number
  invalid: number
}

export function stripTags(text: string): string {
  let out = text
  for (const tag of STRIPPED_TAGS) {
    const open = `<${tag}>`
    const close = `</${tag}>`
    for (let start = out.indexOf(open); start !== -1; start = out.indexOf(open)) {
      const end = out.indexOf(close, start)
      if (end === -1) {
        out = out.slice(0, start)
        break
      }
      out = out.slice(0, start) + out.slice(end + close.length)
    }
  }
  return out.trim()
}

export function unreadable(slice: TranscriptSlice): boolean {
  return slice.fresh > 0 && slice.invalid === slice.fresh
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function textParts(content: unknown, types: readonly (string | undefined)[]): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const parts: string[] = []
  for (const item of content) {
    const block = record(item)
    const kind = typeof block['type'] === 'string' ? block['type'] : undefined
    if (types.includes(kind) && typeof block['text'] === 'string') parts.push(block['text'])
  }
  return parts
}

type Speaker = 'USER' | 'ASSISTANT'

interface Turn {
  speaker: Speaker
  parts: string[]
  id?: string
}

function claudeTurn(entry: Record<string, unknown>): Turn | null {
  const role = entry['type']
  if ((role !== 'user' && role !== 'assistant') || !('message' in entry) || entry['isSidechain'] === true || entry['isMeta'] === true) return null
  return { speaker: role === 'user' ? 'USER' : 'ASSISTANT', parts: textParts(record(entry['message'])['content'], ['text']) }
}

function codexTurn(entry: Record<string, unknown>): Turn | null {
  if (entry['type'] !== 'response_item') return null
  const payload = record(entry['payload'])
  const role = payload['role']
  if (payload['type'] !== 'message' || (role !== 'user' && role !== 'assistant')) return null
  const parts = textParts(payload['content'], ['input_text', 'output_text'])
  if (role === 'user' && parts.some((part) => CODEX_PREAMBLES.some((preamble) => part.trimStart().startsWith(preamble)))) return null
  return { speaker: role === 'user' ? 'USER' : 'ASSISTANT', parts }
}

function geminiTurn(entry: Record<string, unknown>): Turn | null {
  const role = entry['type']
  if ((role !== 'user' && role !== 'gemini') || !('content' in entry) || 'message' in entry) return null
  const id = typeof entry['id'] === 'string' ? entry['id'] : undefined
  return { speaker: role === 'user' ? 'USER' : 'ASSISTANT', parts: textParts(entry['content'], [undefined, 'text']), ...(id === undefined ? {} : { id }) }
}

function turnOf(entry: Record<string, unknown>): Turn | null {
  return claudeTurn(entry) ?? codexTurn(entry) ?? geminiTurn(entry)
}

function render(turn: Turn): string | null {
  const joined = stripTags(turn.parts.join('\n'))
  return joined.length === 0 ? null : `${turn.speaker}: ${joined}`
}

export function turnText(line: string): string | null {
  const entry = parseLine(line)
  if (entry === null) return null
  const turn = turnOf(entry)
  return turn === null ? null : render(turn)
}

export function transcriptFrom(raw: string, skipLines: number): TranscriptSlice {
  const lines = raw.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let text = ''
  let fresh = 0
  let invalid = 0
  const seen = new Set<string>()
  lines.forEach((line, index) => {
    if (line.trim().length === 0) return
    const entry = parseLine(line)
    const turn = entry === null ? null : turnOf(entry)
    const repeated = turn?.id !== undefined && seen.has(turn.id)
    const rendered = turn === null || repeated ? null : render(turn)
    if (rendered !== null && turn?.id !== undefined) seen.add(turn.id)
    if (index < skipLines) return
    fresh += 1
    if (entry === null) invalid += 1
    if (rendered !== null) text += `${rendered}\n\n`
  })
  return { text, lines: lines.length, fresh, invalid }
}

export async function readTranscript(path: string, skipLines: number): Promise<TranscriptSlice> {
  return transcriptFrom(await readFile(path, 'utf8'), skipLines)
}

export function tailChars(text: string, maxChars: number): string {
  const chars = [...text]
  return chars.length <= maxChars ? text : chars.slice(chars.length - maxChars).join('')
}
