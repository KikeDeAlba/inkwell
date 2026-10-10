import { strict as assert } from 'node:assert'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { relativeDocPath, resolveDocPath } from '../src/docs/paths.ts'
import { DB_PATH_ENV_VAR, DOCS_DIR_ENV_VAR, databasePath, docsRoot } from '../src/paths.ts'

const unix = process.platform !== 'win32'

test('the explicit override wins over everything else', () => {
  assert.equal(docsRoot({ [DOCS_DIR_ENV_VAR]: '/somewhere/docs', XDG_DATA_HOME: '/data' }, '/tmp/x/inkwell.db'), '/somewhere/docs')
})

test('the documents follow a database moved with INKWELL_DB_PATH', () => {
  assert.equal(docsRoot({ [DB_PATH_ENV_VAR]: join('/tmp', 'x', 'inkwell.db') }, join('/tmp', 'x', 'inkwell.db')), join('/tmp', 'x', 'docs'))
})

test('without overrides the data lives under the XDG data home', { skip: !unix }, () => {
  assert.equal(databasePath({ XDG_DATA_HOME: '/data' }), '/data/inkwell/inkwell.db')
  assert.equal(docsRoot({ XDG_DATA_HOME: '/data' }), '/data/inkwell/docs')
})

test('on Windows the data lives under LOCALAPPDATA', { skip: unix }, () => {
  assert.equal(databasePath({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }), 'C:\\Users\\me\\AppData\\Local\\inkwell\\inkwell.db')
})

test('refuses a path that climbs out of the root', () => {
  assert.throws(() => resolveDocPath('/docs', '../escape.md'), /escapes the docs root/)
  assert.throws(() => resolveDocPath('/docs', 'a/../../escape.md'), /escapes the docs root/)
})

test('refuses an absolute path and an empty one', () => {
  assert.throws(() => resolveDocPath('/docs', '/etc/passwd'), /must be relative/)
  assert.throws(() => resolveDocPath('/docs', 'C:\\Windows\\win.ini'), /must be relative/)
  assert.throws(() => resolveDocPath('/docs', ''), /cannot be empty/)
})

test('resolves a well formed relative path', () => {
  assert.equal(resolveDocPath('/docs', 'project/sub/thing.md'), resolve('/docs', 'project', 'sub', 'thing.md'))
})

test('turns an absolute path back into a relative one with forward slashes', () => {
  assert.equal(relativeDocPath('/docs', resolve('/docs', 'project', 'sub', 'thing.md')), 'project/sub/thing.md')
  assert.throws(() => relativeDocPath('/docs', `${sep}elsewhere${sep}thing.md`), /not inside the docs root/)
})
