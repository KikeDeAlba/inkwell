import { readFile } from 'node:fs/promises'

const STRIPPED_TAGS = [
  'system-reminder',
  'local-command-stdout',
  'local-command-stderr',
  'command-message',
  'command-args',
  'task-notification',
]

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

export function turnText(line: string): string | null {
  const entry = parseLine(line)
  if (entry === null) return null
  const role = entry['type']
  if ((role !== 'user' && role !== 'assistant') || entry['isSidechain'] === true || entry['isMeta'] === true) return null
  const content = record(entry['message'])['content']
  const parts: string[] = []
  if (typeof content === 'string') parts.push(content)
  else if (Array.isArray(content)) {
    for (const item of content) {
      const block = record(item)
      if (block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text'])
    }
  }
  const joined = stripTags(parts.join('\n'))
  if (joined.length === 0) return null
  return `${role === 'user' ? 'USER' : 'ASSISTANT'}: ${joined}`
}

export function transcriptFrom(raw: string, skipLines: number): TranscriptSlice {
  const lines = raw.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let text = ''
  let fresh = 0
  let invalid = 0
  lines.forEach((line, index) => {
    if (index < skipLines || line.trim().length === 0) return
    fresh += 1
    if (parseLine(line) === null) invalid += 1
    const turn = turnText(line)
    if (turn !== null) text += `${turn}\n\n`
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
