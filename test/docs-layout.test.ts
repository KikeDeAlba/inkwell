import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { pageRelPath } from '../src/docs/layout.ts'
import { NO_PROJECT_SLUG } from '../src/docs/slug.ts'

test('a page path mirrors the space and the slugs of its ancestors', () => {
  assert.equal(pageRelPath({ projectName: 'Apartados', ancestorSlugs: ['arquitectura', 'red'], slug: 'nat' }), 'apartados/arquitectura/red/nat.md')
})

test('a page outside every space lands in its own folder', () => {
  assert.equal(pageRelPath({ projectName: null, ancestorSlugs: [], slug: 'notas' }), `${NO_PROJECT_SLUG}/notas.md`)
})

test('the space name is slugged the same way as the titles', () => {
  assert.equal(pageRelPath({ projectName: 'Pharma STI', ancestorSlugs: [], slug: 'runbook' }), 'pharma-sti/runbook.md')
})
