import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { binCommand } from '../src/setup.ts'
import { VERSION } from '../src/version.ts'
import { BIN, sandbox, type Sandbox } from './helpers/sandbox.ts'

function installShim(box: Sandbox, script: string): string {
  const dir = join(box.dir, 'shims')
  mkdirSync(dir, { recursive: true })
  const windows = process.platform === 'win32'
  const shim = join(dir, windows ? 'inkwell.cmd' : 'inkwell')
  writeFileSync(shim, windows ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(shim, 0o755)
  const inherited = process.env['PATH'] ?? process.env['Path'] ?? ''
  for (const key of Object.keys(box.env)) if (key.toUpperCase() === 'PATH') delete box.env[key]
  box.env['PATH'] = `${dir}${delimiter}${inherited}`
  return shim
}

function registered(box: Sandbox): any {
  return JSON.parse(readFileSync(join(box.env['KIT_REGISTRY_DIR'] as string, 'inkwell.json'), 'utf8'))
}

test('setup registers the inkwell found on PATH when it is this same version', (t) => {
  const box = sandbox(t)
  const shim = installShim(box, BIN)
  box.ok('setup', '--no-agents')
  const manifest = registered(box)
  assert.deepEqual(manifest.bin, [shim])
  assert.deepEqual(manifest.subscribes[0].command, [shim, 'bita-hook'])
})

test('setup falls back to the package script when the inkwell on PATH is another version', (t) => {
  const box = sandbox(t)
  const other = join(box.dir, 'other-inkwell.mjs')
  writeFileSync(
    other,
    `process.stdout.write(JSON.stringify({ schemaVersion: 3, ok: true, command: 'capabilities', generatedAt: new Date().toISOString(), data: { name: 'inkwell', version: '0.0.0-other', envelope: 1, capabilities: [] } }) + '\\n')\n`,
  )
  installShim(box, other)
  box.ok('setup', '--no-agents')
  const manifest = registered(box)
  assert.notEqual(VERSION, '0.0.0-other')
  assert.deepEqual(manifest.bin, binCommand())
  assert.deepEqual(manifest.subscribes[0].command, [...binCommand(), 'bita-hook'])
})
