import { findTool, invokeTool, type FoundTool } from '@kikedealba/kit/registry'
import { ConflictError } from '../errors.ts'

export const ATL_INSTALL_HINT = 'npm install -g @kikedealba/atl && atl setup && atl site add https://<name>.atlassian.net --email <you@company.com>'

export interface RemotePage {
  id: string
  title: string
  version: number
  spaceId: string | null
  parentId: string | null
  status: string | null
  url: string | null
  markdown: string
}

export interface RemoteChild {
  id: string
  title: string
  status: string | null
}

export interface RemoteSpace {
  id: string
  key: string
  homepageId: string | null
}

export interface AttachmentInfo {
  attachmentId: string
  filename: string
  fileId: string | null
  mediaType: string
  downloadUrl: string | null
}

export interface ConfluenceGateway {
  readonly site: string
  spaceByKey(key: string): Promise<RemoteSpace>
  page(id: string): Promise<RemotePage>
  children(id: string): Promise<RemoteChild[]>
  updatePage(input: { id: string; title: string; markdown: string; message: string }): Promise<{ id: string; version: number }>
  createPage(input: { spaceId: string; parentId: string; title: string; markdown: string }): Promise<{ id: string; version: number }>
  attach(pageId: string, file: string, comment?: string): Promise<AttachmentInfo>
}

export class RemoteError extends ConflictError {
  readonly status: number | null

  constructor(message: string, code: string, status: number | null, hint?: string) {
    super(message, code, hint)
    this.name = 'RemoteError'
    this.status = status
  }
}

export function isGone(error: unknown): boolean {
  return error instanceof RemoteError && (error.status === 404 || error.code === 'CONFLUENCE_NOT_FOUND')
}

export async function requireAtl(capability: string | string[] = 'confluence.page.write'): Promise<FoundTool> {
  const found = await findTool('atl', { capability })
  if (found) return found
  throw new ConflictError(
    `atl is not installed (or it is too old to offer ${[capability].flat().join(', ')}), and Confluence goes through it.`,
    'ATL_MISSING',
    ATL_INSTALL_HINT,
  )
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return null
}

export class AtlConfluence implements ConfluenceGateway {
  readonly site: string
  readonly tool: FoundTool
  readonly siteArg: string | null

  constructor(tool: FoundTool, site: string, siteArg: string | null) {
    this.tool = tool
    this.site = site
    this.siteArg = siteArg
  }

  static async connect(siteArg: string | null): Promise<AtlConfluence> {
    const tool = await requireAtl()
    const site = siteArg ?? (await defaultSite(tool)) ?? 'default'
    return new AtlConfluence(tool, site, siteArg)
  }

  private async call(args: string[], input?: string): Promise<unknown> {
    const full = [...args, ...(this.siteArg ? ['--site', this.siteArg] : [])]
    const { envelope } = await invokeTool(this.tool, full, input === undefined ? {} : { input })
    if (!envelope.ok) {
      const error = envelope.error
      const status = typeof error?.status === 'number' ? error.status : error?.code === 'NOT_FOUND' ? 404 : null
      const code = error?.code === 'NOT_FOUND' ? 'CONFLUENCE_NOT_FOUND' : `ATL_${error?.code ?? 'FAILED'}`
      throw new RemoteError(`atl ${args.slice(0, 3).join(' ')}: ${error?.message ?? 'failed'}`, code, status, error?.hint)
    }
    return envelope.data
  }

  async spaceByKey(key: string): Promise<RemoteSpace> {
    const data = await this.call(['confluence', 'space', 'ls', '--keys', key])
    const spaces = Array.isArray(data) ? data.map(record) : []
    const space = spaces.find((candidate) => text(candidate['key'])?.toLowerCase() === key.toLowerCase()) ?? spaces[0]
    if (!space) throw new RemoteError(`There is no Confluence space ${key}, or it is not visible.`, 'CONFLUENCE_SPACE', 404)
    return { id: text(space['id']) ?? '', key: text(space['key']) ?? key, homepageId: text(space['homepageId']) }
  }

  async page(id: string): Promise<RemotePage> {
    const page = record(await this.call(['confluence', 'page', 'get', id, '--format', 'markdown']))
    return {
      id: text(page['id']) ?? id,
      title: text(page['title']) ?? '',
      version: typeof page['version'] === 'number' ? page['version'] : 1,
      spaceId: text(page['spaceId']),
      parentId: text(page['parentId']),
      status: text(page['status']),
      url: text(page['url']),
      markdown: text(page['body']) ?? '',
    }
  }

  async children(id: string): Promise<RemoteChild[]> {
    const data = await this.call(['confluence', 'page', 'children', id])
    return (Array.isArray(data) ? data : []).map(record).map((child) => ({ id: text(child['id']) ?? '', title: text(child['title']) ?? '', status: text(child['status']) }))
  }

  async updatePage(input: { id: string; title: string; markdown: string; message: string }): Promise<{ id: string; version: number }> {
    const page = record(await this.call(['confluence', 'page', 'update', input.id, '--title', input.title, '--body', '@-', '--format', 'markdown', '--message', input.message], input.markdown))
    return { id: text(page['id']) ?? input.id, version: typeof page['version'] === 'number' ? page['version'] : 1 }
  }

  async createPage(input: { spaceId: string; parentId: string; title: string; markdown: string }): Promise<{ id: string; version: number }> {
    const page = record(await this.call(['confluence', 'page', 'create', input.spaceId, input.title, '--body', '@-', '--format', 'markdown', '--parent-id', input.parentId], input.markdown))
    return { id: text(page['id']) ?? '', version: typeof page['version'] === 'number' ? page['version'] : 1 }
  }

  async attach(pageId: string, file: string, comment?: string): Promise<AttachmentInfo> {
    const data = record(await this.call(['confluence', 'attach', pageId, file, ...(comment ? ['--comment', comment] : [])]))
    return {
      attachmentId: text(data['attachmentId']) ?? '',
      filename: text(data['filename']) ?? file.split(/[\\/]/).pop() ?? file,
      fileId: text(data['fileId']),
      mediaType: text(data['mediaType']) ?? 'application/octet-stream',
      downloadUrl: text(data['downloadUrl']),
    }
  }
}

async function defaultSite(tool: FoundTool): Promise<string | null> {
  try {
    const { envelope } = await invokeTool(tool, ['site', 'ls'])
    if (!envelope.ok) return null
    const data = envelope.data
    const sites = (Array.isArray(data) ? data : Array.isArray(record(data)['sites']) ? (record(data)['sites'] as unknown[]) : []).map(record)
    const chosen = sites.find((site) => site['default'] === true) ?? (sites.length === 1 ? sites[0] : undefined)
    return chosen ? text(chosen['url']) ?? text(chosen['name']) : null
  } catch {
    return null
  }
}
