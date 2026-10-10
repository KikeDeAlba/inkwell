export function issueUrl(siteUrl: string | undefined, issueKey: string): string | null {
  if (!siteUrl) return null
  const base = siteUrl.replace(/\/+$/, '')
  if (base.length === 0) return null
  return `${base}/browse/${issueKey}`
}
