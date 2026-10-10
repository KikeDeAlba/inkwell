import { UsageError } from '../errors.ts'
import type { ConfluenceKind } from '../db/rows.ts'

export interface ParsedConfluenceRef {
  kind: ConfluenceKind
  ref: string
  site: string | null
}

export interface ConfluenceRefView {
  kind: ConfluenceKind
  url: string | null
  spaceKey: string | null
  pageId: string | null
  title: string | null
}

const SPACE_KEY = /^~?[A-Za-z0-9][A-Za-z0-9_-]*$/

export function normalizeSiteUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.length === 0 || !parsed.hostname.includes('.')) return null
  return `https://${parsed.host.toLowerCase()}`
}

export function parseConfluenceRef(raw: string): ParsedConfluenceRef | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.toLowerCase() === 'none') return null

  if (!/^https?:\/\//i.test(trimmed)) {
    if (SPACE_KEY.test(trimmed)) return { kind: 'space', ref: trimmed, site: null }
    throw new UsageError(`"${raw}" is neither a Confluence URL nor a space key.`)
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new UsageError(`"${raw}" is not a URL.`)
  }
  const site = normalizeSiteUrl(url.origin)
  const page = /\/wiki\/spaces\/([^/]+)\/pages\/(?:edit-v2\/)?(\d+)/.exec(url.pathname)
  if (page) return { kind: 'page', ref: `${url.origin}${url.pathname}`, site }
  const viewPage = url.searchParams.get('pageId')
  if (viewPage && /^\d+$/.test(viewPage)) return { kind: 'page', ref: `${url.origin}${url.pathname}?pageId=${viewPage}`, site }
  const space = /\/wiki\/spaces\/([^/]+)/.exec(url.pathname)
  if (space?.[1]) return { kind: 'space', ref: decodeURIComponent(space[1]), site }
  throw new UsageError(`"${raw}" does not point at a Confluence page or space.`)
}

export function confluenceRefView(kind: ConfluenceKind, ref: string, site: string | null): ConfluenceRefView {
  if (kind === 'space') {
    return { kind, url: site ? `${site}/wiki/spaces/${encodeURIComponent(ref)}` : null, spaceKey: ref, pageId: null, title: null }
  }
  let url: URL | null = null
  try {
    url = new URL(ref)
  } catch {
    url = null
  }
  const match = url ? /\/wiki\/spaces\/([^/]+)\/pages\/(?:edit-v2\/)?(\d+)(?:\/([^/?#]+))?/.exec(url.pathname) : null
  const pageId = match?.[2] ?? url?.searchParams.get('pageId') ?? null
  const slug = match?.[3]
  return {
    kind,
    url: ref,
    spaceKey: match?.[1] ? decodeURIComponent(match[1]) : null,
    pageId,
    title: slug ? decodeURIComponent(slug.replace(/\+/g, ' ')) : null,
  }
}
