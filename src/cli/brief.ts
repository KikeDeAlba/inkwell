import { findSection, parseDocument, sectionMarkdown, stripFrontMatter } from '../docs/markdown.ts'
import { NotFoundError } from '../errors.ts'

export interface BriefBody {
  sections: string[]
  section?: string
  markdown: string | null
}

export function briefBody(raw: string | null, section: string | undefined): BriefBody {
  if (raw === null) {
    if (section !== undefined) throw new NotFoundError(`There is no section "${section}": the file is missing.`, 'SECTION_NOT_FOUND')
    return { sections: [], markdown: null }
  }
  const parsed = parseDocument(raw)
  const sections = parsed.sections.map((item) => item.heading)
  if (section === undefined) return { sections, markdown: stripFrontMatter(raw) }
  const found = findSection(parsed, section)
  if (!found) {
    throw new NotFoundError(
      `There is no section "${section}".`,
      'SECTION_NOT_FOUND',
      sections.length > 0 ? `Sections: ${sections.join(', ')}.` : 'The document has no sections.',
    )
  }
  return { sections, section: found.heading, markdown: sectionMarkdown(found) }
}
