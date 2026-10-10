import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findChrome } from '../docs/apps.ts'
import { assetsRelDir, extractDiagrams } from '../docs/diagrams.ts'
import { documentBody, outline, parseDocument } from '../docs/markdown.ts'
import { slugify } from '../docs/slug.ts'
import { escapeHtml, loadPrintStyles, markdownHtml, meetingDate, type MermaidRenderer } from './minutes.ts'
import { downloadsDir, mermaidRendererIn, printToPdf, processRunner, type PrintEnvironment } from './pdf.ts'

export interface PageExportEnvironment extends PrintEnvironment {
  renderMermaid: MermaidRenderer
  styles: () => Promise<string>
  downloadsDir: string
}

export async function defaultPageExportEnvironment(workDir: string): Promise<PageExportEnvironment> {
  return {
    run: processRunner,
    exists: existsSync,
    chromeApp: await findChrome(),
    renderMermaid: mermaidRendererIn(join(workDir, 'mermaid')),
    styles: () => loadPrintStyles(),
    downloadsDir: downloadsDir(),
  }
}

export interface PageDocument {
  title: string
  spaceName: string | null
  trail: string[]
  updatedAt: string
  timezone: string
  markdown: string
  pagePath: string
  relPath: string
}

export async function buildPageHtml(doc: PageDocument, options: { styles: string; renderMermaid: MermaidRenderer }): Promise<string> {
  const parsed = parseDocument(doc.markdown)
  const body = documentBody(parsed)
  const baseDir = dirname(doc.pagePath)
  const assetsDir = join(baseDir, assetsRelDir(doc.relPath.split('/').pop() ?? 'page.md'))
  const drawio = new Map(extractDiagrams(doc.markdown).filter((block) => block.kind === 'drawio').map((block) => [block.source, block.imageFile]))
  const html = await markdownHtml(body, baseDir, options.renderMermaid, (token) => {
    if (token.lang?.trim().split(/\s+/)[0]?.toLowerCase() !== 'drawio') return null
    const file = token.text.trim().split('\n')[0]?.trim() ?? ''
    const image = drawio.get(file.endsWith('.drawio') ? file : `${file}.drawio`)
    if (image === undefined) return null
    const path = join(assetsDir, image)
    if (!existsSync(path)) return null
    return `<figure class="md-drawio"><img src="${escapeHtml(pathToFileURL(path).href)}" alt="${escapeHtml(file)}"></figure>\n`
  })
  const sections = outline(parsed).filter((heading) => heading.level === 2)
  const kicker = doc.spaceName ?? 'Sin espacio'
  const updated = meetingDate(doc.updatedAt, doc.timezone)
  const crumb = [kicker, ...doc.trail, doc.title].join(' / ')

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${escapeHtml(doc.title)}</title>
<style>
${options.styles}
</style>
</head>
<body>
<div id="print-root" class="print-root">
<section class="print-cover">
<div class="print-kicker">${escapeHtml(kicker)}</div>
<h1 class="print-cover-title">${escapeHtml(doc.title)}</h1>
<div class="print-cover-meta">${escapeHtml(`Actualizado el ${updated}`)}</div>
${
  sections.length === 0
    ? ''
    : `<div class="print-index">
<h2 class="print-index-title">Contenido</h2>
${sections.map((heading, index) => `<div class="print-index-line"><span class="print-index-number">${index + 1}</span><span>${escapeHtml(heading.heading)}</span></div>`).join('\n')}
</div>`
}
</section>
<section class="print-page">
<div class="print-crumb">${escapeHtml(crumb)}</div>
<h1 class="print-title">${escapeHtml(doc.title)}</h1>
<article class="article">
${html}
</article>
</section>
</div>
</body>
</html>
`
}

export function defaultPagePdfPath(dir: string, title: string): string {
  return join(dir, `${slugify(title) || 'pagina'}.pdf`)
}

export async function exportPage(doc: PageDocument, out: string | undefined, workDir: string, env: PageExportEnvironment): Promise<string> {
  const html = await buildPageHtml(doc, { styles: await env.styles(), renderMermaid: env.renderMermaid })
  const target = resolve(out ?? defaultPagePdfPath(env.downloadsDir, doc.title))
  await mkdir(dirname(target), { recursive: true })
  await mkdir(workDir, { recursive: true, mode: 0o700 })
  const htmlPath = join(workDir, 'page.html')
  await writeFile(htmlPath, html, { mode: 0o600 })
  await printToPdf(htmlPath, target, workDir, env)
  return target
}
