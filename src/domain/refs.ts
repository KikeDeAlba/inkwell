import type { RefKind } from '../db/page-refs.ts'

export function classifyUrl(url: string): RefKind | null {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return null
  }
  const host = parsedUrl.hostname
  if (host.endsWith('.atlassian.net')) {
    if (parsedUrl.pathname.startsWith('/wiki/')) return 'confluence'
    if (parsedUrl.pathname.startsWith('/browse/')) return 'jira'
    return null
  }
  if (host === 'docs.google.com' || host === 'drive.google.com') return 'drive'
  return null
}
