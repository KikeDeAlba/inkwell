import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { DRAFT_TITLE_SLUG, NO_PROJECT_SLUG, projectSlug, slugify, titleSlug } from '../src/docs/slug.ts'

test('strips accents and lowercases', () => {
  assert.equal(slugify('Migración del Worker'), 'migracion-del-worker')
  assert.equal(slugify('Análisis y estimación'), 'analisis-y-estimacion')
})

test('collapses punctuation and trims the edges', () => {
  assert.equal(slugify('  ¡Ajustar el pipeline (de despliegue)!  '), 'ajustar-el-pipeline-de-despliegue')
  assert.equal(slugify('feature/ssm-deploy_pipeline'), 'feature-ssm-deploy-pipeline')
})

test('emits nothing but lowercase letters, digits and dashes', () => {
  for (const input of ['../../etc/passwd', 'C:\\Windows\\系统', 'a  b\tc\nd', '🚀 deploy 🚀']) {
    const slug = slugify(input)
    if (slug.length > 0) assert.match(slug, /^[a-z0-9-]+$/, `"${input}" produced "${slug}"`)
  }
})

test('never lets a path separator or a dot segment through', () => {
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd')
  assert.equal(slugify('..'), '')
})

test('cuts long titles at a word boundary', () => {
  const long = 'palabra '.repeat(40).trim()
  const slug = slugify(long)
  assert.ok(slug.length <= 60)
  assert.ok(!slug.endsWith('-'))
  assert.ok(!slug.startsWith('-'))
  assert.match(slug, /^(palabra-)*palabra$/)
})

test('a cut with no word boundary still fits', () => {
  const slug = slugify('a'.repeat(200))
  assert.equal(slug.length, 60)
})

test('falls back when there is nothing to slug', () => {
  assert.equal(projectSlug(null), NO_PROJECT_SLUG)
  assert.equal(projectSlug(''), NO_PROJECT_SLUG)
  assert.equal(projectSlug('¿?'), NO_PROJECT_SLUG)
  assert.equal(titleSlug(''), DRAFT_TITLE_SLUG)
  assert.equal(titleSlug(null), DRAFT_TITLE_SLUG)
  assert.equal(titleSlug('---'), DRAFT_TITLE_SLUG)
})
