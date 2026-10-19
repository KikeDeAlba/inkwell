import { findSection, emptyDocument, parseDocument, renderDocument, upsertSection } from './markdown.ts'
import { commitDocs, commitToBranch, docsSubject, requireDocsRepo, type DocsSource } from './git.ts'
import type { DocsContext } from './context.ts'
import type { DocPageRow } from '../db/pages.ts'
import { UsageError } from '../errors.ts'

export interface ProposalSource {
  source: DocsSource
  entryId: number | null
  sessionId: string | null
}

export function proposalSource(raw: string | undefined): ProposalSource {
  if (raw === undefined || raw === 'manual') return { source: 'manual', entryId: null, sessionId: null }
  const session = /^session:([A-Za-z0-9._-]+)$/.exec(raw)
  if (session?.[1] !== undefined) return { source: 'session', entryId: null, sessionId: session[1] }
  const match = /^meeting(?::(\d+))?$/.exec(raw)
  if (!match) throw new UsageError(`Unknown --source "${raw}". Use meeting:<entryId>, session:<sessionId> or manual.`)
  return { source: 'meeting', entryId: match[1] === undefined ? null : Number(match[1]), sessionId: null }
}

export interface ProposedChange {
  body: string
  section?: string | undefined
  afterSection?: string | undefined
}

export function proposedContent(base: string | null, title: string, change: ProposedChange): string {
  let doc = base === null ? emptyDocument(new Map(), title) : parseDocument(base)
  if (change.section !== undefined) {
    const anchor = change.afterSection === undefined || findSection(doc, change.section) !== undefined ? undefined : findSection(doc, change.afterSection)
    if (anchor === undefined) {
      doc = upsertSection(doc, change.section, change.body).doc
    } else {
      const sections = [...doc.sections]
      sections.splice(sections.indexOf(anchor) + 1, 0, { heading: change.section.normalize('NFC'), body: change.body.trim() })
      doc = { ...doc, sections }
    }
  } else {
    const replacement = parseDocument(change.body)
    doc = { ...doc, preamble: replacement.preamble, sections: replacement.sections }
  }
  return renderDocument(doc)
}

export interface Proposal {
  branch: string
  fresh?: boolean | undefined
  body: string
  section?: string | undefined
  afterSection?: string | undefined
  reason: string
  origin: ProposalSource
}

export async function proposePage(ctx: DocsContext, page: DocPageRow, proposal: Proposal): Promise<{ sha: string; base: string; branch: string }> {
  const { branch, body, section, afterSection, reason, origin } = proposal
  await requireDocsRepo(ctx.docsRoot)
  await commitDocs(ctx.docsRoot, [page.relPath], {
    source: 'manual',
    subject: docsSubject(page.relPath, 'record outside edits to', page.title),
    pageId: page.id,
    reason: 'external edit',
  })

  const trailers: Record<string, string> = {
    ...(section !== undefined ? { 'Inkwell-Section': section } : {}),
    ...(origin.sessionId !== null ? { 'Inkwell-Session': origin.sessionId } : {}),
  }
  return commitToBranch(ctx.docsRoot, {
    branch,
    fresh: proposal.fresh,
    relPath: page.relPath,
    build: (current) => proposedContent(current, page.title, { body, section, afterSection }),
    intent: {
      source: origin.source,
      subject: docsSubject(page.relPath, section === undefined ? 'propose a rewrite of' : `propose "${section}" for`, page.title),
      pageId: page.id,
      entryId: origin.entryId,
      reason,
      ...(Object.keys(trailers).length > 0 ? { trailers } : {}),
    },
  })
}
