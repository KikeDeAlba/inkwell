import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { issueUrl } from '../src/domain/jira.ts'
import { MAX_PAGE_DEPTH, pageRelPath } from '../src/docs/layout.ts'
import { resolveDocPath } from '../src/docs/paths.ts'
import { slugify, titleSlug } from '../src/docs/slug.ts'

const ROOT = '/tmp/bita-docs'

test('a page path nests the space, its ancestors and its own slug', () => {
  assert.equal(
    pageRelPath({ projectName: 'Pharma STI', ancestorSlugs: ['bootstrap'], slug: 'credenciales-y-secretos' }),
    'pharma-sti/bootstrap/credenciales-y-secretos.md',
  )
})

test('a page without a project still lands inside the corpus', () => {
  assert.equal(pageRelPath({ projectName: null, ancestorSlugs: [], slug: 'suelta' }), '_no-project/suelta.md')
})

test('a hostile title cannot climb out of the docs root', () => {
  const hostile = ['../../etc/passwd', '..', 'a/b', '  ', '💥', 'C:\\Windows\\system32']

  for (const title of hostile) {
    const slug = titleSlug(title)
    const relPath = pageRelPath({ projectName: 'Pharma STI', ancestorSlugs: [], slug })
    const resolved = resolveDocPath(ROOT, relPath)

    assert.equal(resolved.startsWith(`${ROOT}/`), true, `escaped with "${title}"`)
    assert.equal(relPath.includes('..'), false, `kept a climb with "${title}"`)
  }
})

test('an ancestor slug is a slug, so a deep path stays inside too', () => {
  const ancestors = ['../..', 'a/b'].map((value) => slugify(value) || 'seccion')
  const relPath = pageRelPath({ projectName: 'Pharma STI', ancestorSlugs: ancestors, slug: 'hoja' })

  assert.equal(resolveDocPath(ROOT, relPath).startsWith(`${ROOT}/`), true)
})

test('the depth limit leaves room for space, page and subpage', () => {
  assert.equal(MAX_PAGE_DEPTH >= 2, true)
})

test('an issue url is composed from the site, with or without a trailing slash', () => {
  assert.equal(issueUrl('https://x.atlassian.net', 'PSTI-142'), 'https://x.atlassian.net/browse/PSTI-142')
  assert.equal(issueUrl('https://x.atlassian.net///', 'PSTI-142'), 'https://x.atlassian.net/browse/PSTI-142')
})

test('without a site there is no url, and that is not an error', () => {
  assert.equal(issueUrl(undefined, 'PSTI-142'), null)
  assert.equal(issueUrl('', 'PSTI-142'), null)
})
