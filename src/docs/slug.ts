export const NO_PROJECT_SLUG = '_no-project'
export const DRAFT_TITLE_SLUG = 'draft'
export const SLUG_MAX = 60

export function slugify(value: string, maxLength = SLUG_MAX): string {
  const ascii = value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (ascii.length <= maxLength) return ascii

  const cut = ascii.slice(0, maxLength)
  const lastDash = cut.lastIndexOf('-')
  const trimmed = lastDash > 0 ? cut.slice(0, lastDash) : cut
  return trimmed.replace(/^-+|-+$/g, '')
}

export function projectSlug(projectName: string | null | undefined): string {
  if (!projectName) return NO_PROJECT_SLUG
  return slugify(projectName) || NO_PROJECT_SLUG
}

export function titleSlug(description: string | null | undefined): string {
  if (!description) return DRAFT_TITLE_SLUG
  return slugify(description) || DRAFT_TITLE_SLUG
}
