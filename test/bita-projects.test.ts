import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { openMemoryDatabase } from '../src/db/open.ts'
import { listSpaces, resolveSpaceArg } from '../src/db/spaces.ts'
import { matchProject, setBitaProjectLookup, toBitaProject, type BitaProject } from '../src/integrations/bita-projects.ts'

const PROJECT: BitaProject = {
  id: 5,
  name: 'kikedealba-e2e',
  key: 'KE',
  clientName: null,
  active: true,
  site: 'https://gruposti.atlassian.net',
  confluence: { ref: 'DOC', kind: 'space' },
  syncPull: true,
  syncPush: false,
}

test('bita project payloads are read and matched by id, name or key', () => {
  const parsed = toBitaProject({
    id: 5,
    key: 'KE',
    name: 'kikedealba-e2e',
    active: true,
    clientName: null,
    atlassian: { site: 'https://gruposti.atlassian.net', via: 'mcp', confluence: { ref: 'DOC', kind: 'space' }, sync: { pull: true, push: false, lastSyncAt: null } },
  })
  assert.deepEqual(parsed, PROJECT)
  assert.equal(toBitaProject({ name: 'x' }), null)
  const list = [PROJECT]
  assert.equal(matchProject(list, '5'), PROJECT)
  assert.equal(matchProject(list, 'KIKEDEALBA-E2E'), PROJECT)
  assert.equal(matchProject(list, 'ke'), PROJECT)
  assert.equal(matchProject(list, 'nope'), null)
})

test('a bita project that inkwell does not know yet becomes a space on first use', (t) => {
  const db = openMemoryDatabase()
  const asked: string[] = []
  t.after(
    setBitaProjectLookup((ref) => {
      asked.push(ref)
      return matchProject([PROJECT], ref)
    }),
  )
  const space = resolveSpaceArg(db, 'kikedealba-e2e')
  assert.equal(space.name, 'kikedealba-e2e')
  assert.equal(space.key, 'KE')
  assert.equal(space.externalRef, 'bita:project:5')
  assert.equal(space.atlassianSite, 'https://gruposti.atlassian.net')
  assert.equal(space.confluenceRef, 'DOC')
  assert.equal(space.syncPull, true)
  assert.equal(resolveSpaceArg(db, '5').id, space.id)
  assert.equal(resolveSpaceArg(db, 'KE').id, space.id)
  assert.equal(listSpaces(db).length, 1)
  assert.deepEqual(asked, ['kikedealba-e2e'])
  assert.throws(() => resolveSpaceArg(db, 'ghost'), /No space named or keyed "ghost"/)
})

test('an existing space with the same name is linked instead of duplicated', (t) => {
  const db = openMemoryDatabase()
  db.prepare("INSERT INTO spaces (name, active, created_at) VALUES ('kikedealba-e2e', 1, '2026-10-10T00:00:00.000Z')").run()
  t.after(setBitaProjectLookup((ref) => matchProject([PROJECT], ref)))
  const space = resolveSpaceArg(db, '5')
  assert.equal(space.externalRef, 'bita:project:5')
  assert.equal(listSpaces(db).length, 1)
})

test('an inactive space left by a deleted project with a reused id is not inherited', (t) => {
  const db = openMemoryDatabase()
  db.prepare("INSERT INTO spaces (name, key, external_ref, active, created_at) VALUES ('viejo', 'VJ', 'bita:project:5', 0, '2026-10-10T00:00:00.000Z')").run()
  t.after(setBitaProjectLookup((ref) => matchProject([{ ...PROJECT, name: 'nuevo', key: 'NU' }], ref)))
  const space = resolveSpaceArg(db, '5')
  assert.equal(space.name, 'nuevo')
  assert.equal(space.externalRef, 'bita:project:5')
  const old = listSpaces(db).find((candidate) => candidate.name === 'viejo')
  assert.equal(old?.externalRef, null)
})
