import { localDay } from '../domain/timezone.ts'
import { projectSlug, titleSlug } from './slug.ts'

export const MAX_PAGE_DEPTH = 4

export interface PagePathInput {
  projectName: string | null
  ancestorSlugs: readonly string[]
  slug: string
}

export function pageRelPath(input: PagePathInput): string {
  return [projectSlug(input.projectName), ...input.ancestorSlugs, `${input.slug}.md`].join('/')
}

export interface NotePathInput {
  entryId: number
  startedAt: string
  timezone: string
  spaceName: string | null
  description: string
}

export function noteRelPath(input: NotePathInput): string {
  const [year, month, dayOfMonth] = localDay(input.startedAt, input.timezone).split('-')
  return [projectSlug(input.spaceName), year, month, `${dayOfMonth}-${input.entryId}-${titleSlug(input.description)}.md`].join('/')
}
