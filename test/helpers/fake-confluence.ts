import type { AttachmentInfo, ConfluenceGateway, RemoteChild, RemotePage, RemoteSpace } from '../../src/confluence/gateway.ts'
import { RemoteError } from '../../src/confluence/gateway.ts'

export interface FakePage {
  id: string
  title: string
  version: number
  spaceId: string
  parentId: string | null
  storage: string
  status?: string
}

export interface FakeCall {
  method: string
  path: string
  body: unknown
}

export class FakeConfluence implements ConfluenceGateway {
  readonly site: string
  readonly pages = new Map<string, FakePage>()
  readonly spaces = new Map<string, { id: string; key: string; homepageId: string }>()
  readonly calls: FakeCall[] = []
  readonly attachments: { pageId: string; file: string; comment: string | undefined }[] = []
  private nextId = 9000

  constructor(site = 'https://acme.atlassian.net') {
    this.site = site
  }

  add(page: Omit<FakePage, 'version' | 'spaceId'> & { version?: number; spaceId?: string }): FakePage {
    const created: FakePage = { version: 1, spaceId: 'S1', ...page }
    this.pages.set(created.id, created)
    return created
  }

  edit(id: string, storage: string, title?: string): void {
    const page = this.pages.get(id)
    if (!page) throw new Error(`no fake page ${id}`)
    page.storage = storage
    if (title !== undefined) page.title = title
    page.version += 1
  }

  writes(): FakeCall[] {
    return this.calls.filter((call) => call.method !== 'GET')
  }

  private view(page: FakePage): RemotePage {
    return {
      id: page.id,
      title: page.title,
      version: page.version,
      spaceId: page.spaceId,
      parentId: page.parentId,
      status: page.status ?? 'current',
      url: `${this.site}/wiki/spaces/K/pages/${page.id}`,
      markdown: page.storage,
    }
  }

  async spaceByKey(key: string): Promise<RemoteSpace> {
    this.calls.push({ method: 'GET', path: `space ${key}`, body: null })
    const space = this.spaces.get(key)
    if (!space) throw new RemoteError(`There is no Confluence space ${key}.`, 'CONFLUENCE_SPACE', 404)
    return space
  }

  async page(id: string): Promise<RemotePage> {
    this.calls.push({ method: 'GET', path: `page ${id}`, body: null })
    const page = this.pages.get(id)
    if (!page) throw new RemoteError(`Not found: ${id}`, 'CONFLUENCE_NOT_FOUND', 404)
    return this.view(page)
  }

  async children(id: string): Promise<RemoteChild[]> {
    this.calls.push({ method: 'GET', path: `children ${id}`, body: null })
    return [...this.pages.values()].filter((page) => page.parentId === id).map((page) => ({ id: page.id, title: page.title, status: page.status ?? 'current' }))
  }

  async updatePage(input: { id: string; title: string; markdown: string; message: string }): Promise<{ id: string; version: number }> {
    this.calls.push({ method: 'PUT', path: `page ${input.id}`, body: input })
    const page = this.pages.get(input.id)
    if (!page) throw new RemoteError(`Not found: ${input.id}`, 'CONFLUENCE_NOT_FOUND', 404)
    page.title = input.title
    page.storage = input.markdown
    page.version += 1
    return { id: page.id, version: page.version }
  }

  async createPage(input: { spaceId: string; parentId: string; title: string; markdown: string }): Promise<{ id: string; version: number }> {
    this.calls.push({ method: 'POST', path: 'pages', body: input })
    if ([...this.pages.values()].some((page) => page.title === input.title && page.spaceId === input.spaceId)) {
      throw new RemoteError('A page with this title already exists', 'ATL_HTTP', 400)
    }
    this.nextId += 1
    const page = this.add({ id: String(this.nextId), title: input.title, parentId: input.parentId, storage: input.markdown, spaceId: input.spaceId })
    return { id: page.id, version: page.version }
  }

  async attach(pageId: string, file: string, comment?: string): Promise<AttachmentInfo> {
    this.calls.push({ method: 'PUT', path: `attach ${pageId}`, body: { file, comment } })
    this.attachments.push({ pageId, file, comment })
    const filename = file.split(/[\\/]/).pop() ?? file
    return { attachmentId: `att-${this.attachments.length}`, filename, fileId: `file-${this.attachments.length}`, mediaType: filename.endsWith('.png') ? 'image/png' : 'application/octet-stream', downloadUrl: null }
  }
}
