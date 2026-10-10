import { projectSlug } from './slug.ts'

export const MAX_PAGE_DEPTH = 4

export interface PagePathInput {
  projectName: string | null
  ancestorSlugs: readonly string[]
  slug: string
}

export function pageRelPath(input: PagePathInput): string {
  return [projectSlug(input.projectName), ...input.ancestorSlugs, `${input.slug}.md`].join('/')
}
