import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { UsageError } from '../../errors.ts'
import { PACKAGE_ROOT } from '../../version.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean } from '../args.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'

export const GUIDES = ['writing', 'entry-notes', 'diagrams', 'confluence'] as const

export function guidePath(name: string): string {
  return path.join(PACKAGE_ROOT, 'skills', 'inkwell', `${name}.md`)
}

export async function runGuide(argv: string[]): Promise<number> {
  const args = parseCommandArgs(argv, {}, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const name = args.positionals[0]
  if (name === undefined) {
    if (json) writeJson(successEnvelope('guide', { guides: [...GUIDES] }))
    else writeOut(GUIDES.join('\n'))
    return 0
  }
  if (!(GUIDES as readonly string[]).includes(name)) throw new UsageError(`Unknown guide "${name}".`, `Use one of ${GUIDES.join(', ')}.`)
  const markdown = await readFile(guidePath(name), 'utf8')
  if (json) writeJson(successEnvelope('guide', { name, markdown }))
  else writeOut(markdown.trimEnd())
  return 0
}
