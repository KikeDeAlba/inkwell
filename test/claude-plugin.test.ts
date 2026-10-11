import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { platformContext } from '@kikedealba/kit/platform'
import { CLAUDE_PLUGIN, installAgents, integration, uninstallAgents } from '../src/setup.ts'
import { PACKAGE_ROOT, VERSION } from '../src/version.ts'
import { sandbox } from './helpers/sandbox.ts'

const SKILL_DIR = join(PACKAGE_ROOT, 'skills', 'inkwell')

function frontMatter(text: string): string {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  assert.ok(match, 'SKILL.md has front matter')
  return match[1] as string
}

test('the plugin manifests are valid and match the package version', () => {
  const plugin = JSON.parse(readFileSync(join(PACKAGE_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
  const marketplace = JSON.parse(readFileSync(join(PACKAGE_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'))
  assert.equal(plugin.name, 'inkwell')
  assert.equal(plugin.version, VERSION)
  assert.equal(plugin.mcpServers, undefined)
  assert.equal(marketplace.name, CLAUDE_PLUGIN.marketplaceName)
  assert.equal(marketplace.plugins.length, 1)
  assert.equal(marketplace.plugins[0].name, CLAUDE_PLUGIN.plugin)
  assert.equal(marketplace.plugins[0].source, './')
  assert.equal(marketplace.plugins[0].version, VERSION)
  assert.equal(CLAUDE_PLUGIN.marketplace, 'KikeDeAlba/inkwell')
})

test('the skill stays lean and links every supporting file that exists', () => {
  const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8')
  const header = frontMatter(skill)
  assert.match(header, /^name: inkwell$/m)
  assert.match(header, /^description: /m)
  assert.ok(skill.split('\n').length < 250, 'SKILL.md under 250 lines')
  assert.doesNotMatch(skill, /rovo/i)
  for (const file of ['writing.md', 'diagrams.md', 'confluence.md', 'entry-notes.md']) {
    assert.ok(existsSync(join(SKILL_DIR, file)), file)
    assert.ok(skill.includes(`](${file})`), `SKILL.md links ${file}`)
  }
  assert.match(skill, /--brief/)
  assert.match(skill, /--section/)
  assert.match(readFileSync(join(SKILL_DIR, 'writing.md'), 'utf8'), /\| Así no \| Así sí \|/)
  assert.doesNotMatch(skill, /Así no/, 'the writing rules live only in writing.md')
})

interface Call {
  command: string
  args: readonly string[]
}

function fakeAgents(t: { after: (fn: () => void) => void }, listed: unknown[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'inkwell-agents-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = platformContext({ home: dir, env: { HOME: dir, XDG_DATA_HOME: join(dir, 'data'), XDG_CONFIG_HOME: join(dir, 'config') } })
  const homes = {
    claude: join(dir, '.claude'),
    opencode: join(dir, 'config', 'opencode'),
    codex: join(dir, '.codex'),
    agentsSkills: join(dir, '.agents', 'skills'),
    gemini: join(dir, '.gemini'),
  }
  const calls: Call[] = []
  const exec = async (command: string, args: readonly string[]): Promise<string> => {
    calls.push({ command, args })
    if (!args.includes('--json')) return ''
    return JSON.stringify(args[1] === 'list' ? listed : [])
  }
  const locate = async (command: string): Promise<string | null> => join(dir, 'bin', command)
  return { dir, ctx, homes, calls, exec, locate }
}

test('installAgents installs the Claude Code plugin, removes the legacy files and keeps the skill for the other agents', async (t) => {
  const fake = fakeAgents(t)
  mkdirSync(join(fake.homes.claude, 'skills'), { recursive: true })
  symlinkSync(SKILL_DIR, join(fake.homes.claude, 'skills', 'inkwell'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(fake.homes.claude, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(inkwell tree:*)', 'Bash(ls:*)'] } }))

  const steps = await installAgents(['claude', 'codex'], { ctx: fake.ctx, homes: fake.homes, exec: fake.exec, locate: fake.locate })
  assert.equal(steps.some((step) => step.state === 'failed'), false, JSON.stringify(steps))

  const claudeCalls = fake.calls.filter((call) => call.command.endsWith('claude')).map((call) => call.args.join(' '))
  assert.ok(claudeCalls.includes('plugin marketplace add KikeDeAlba/inkwell'), claudeCalls.join('\n'))
  assert.ok(claudeCalls.includes('plugin marketplace update inkwell'))
  assert.ok(claudeCalls.includes('plugin install inkwell@inkwell --scope user'))
  assert.ok(claudeCalls.includes('mcp add --scope user drawio -- npx -y @drawio/mcp'), claudeCalls.join('\n'))

  assert.equal(existsSync(join(fake.homes.claude, 'skills', 'inkwell')), false)
  const settings = JSON.parse(readFileSync(join(fake.homes.claude, 'settings.json'), 'utf8'))
  assert.ok(settings.permissions.allow.includes('Bash(ls:*)'))
  assert.ok(settings.permissions.allow.includes('Bash(inkwell tree:*)'))
  assert.ok(settings.permissions.allow.includes('Bash(inkwell guide:*)'))

  const codexSkill = join(fake.homes.agentsSkills, 'inkwell')
  assert.ok(lstatSync(codexSkill))
  assert.ok(existsSync(join(codexSkill, 'writing.md')))
  assert.ok(steps.some((step) => step.agent === 'codex'))
})

test('installAgents leaves the legacy Claude files alone when the plugin could not be installed', async (t) => {
  const fake = fakeAgents(t)
  mkdirSync(join(fake.homes.claude, 'skills'), { recursive: true })
  symlinkSync(SKILL_DIR, join(fake.homes.claude, 'skills', 'inkwell'), process.platform === 'win32' ? 'junction' : 'dir')
  const steps = await installAgents(['claude'], { ctx: fake.ctx, homes: fake.homes, exec: fake.exec, locate: async () => null })
  assert.equal(steps[0]?.state, 'unavailable')
  assert.ok(existsSync(join(fake.homes.claude, 'skills', 'inkwell')))
})

test('a failed marketplace update does not keep the legacy skill once the plugin is installed', async (t) => {
  const fake = fakeAgents(t)
  mkdirSync(join(fake.homes.claude, 'skills'), { recursive: true })
  symlinkSync(SKILL_DIR, join(fake.homes.claude, 'skills', 'inkwell'), process.platform === 'win32' ? 'junction' : 'dir')
  const exec = async (command: string, args: readonly string[]): Promise<string> => {
    if (args.join(' ') === 'plugin marketplace update inkwell') throw new Error('network down')
    return fake.exec(command, args)
  }
  const steps = await installAgents(['claude'], { ctx: fake.ctx, homes: fake.homes, exec, locate: fake.locate, drawio: false })
  assert.ok(steps.some((step) => step.item === 'plugin inkwell@inkwell' && step.state === 'installed'))
  assert.equal(existsSync(join(fake.homes.claude, 'skills', 'inkwell')), false)
  assert.equal(fake.calls.some((call) => call.args[0] === 'mcp'), false, '--no-drawio registers no MCP and removes none')
})

test('uninstallAgents removes the Claude Code plugin', async (t) => {
  const fake = fakeAgents(t, [{ id: 'inkwell@inkwell', scope: 'user' }])
  const steps = await uninstallAgents({ ctx: fake.ctx, homes: fake.homes, exec: fake.exec, locate: fake.locate })
  assert.ok(fake.calls.some((call) => call.args.join(' ') === 'plugin uninstall inkwell@inkwell --scope user'))
  assert.ok(steps.some((step) => step.agent === 'claude' && step.state === 'removed'))
})

test('the integration ships the skill directory with its supporting files', () => {
  const skills = integration().skills ?? []
  assert.deepEqual(skills.map((skill) => skill.dir), [SKILL_DIR])
})

test('setup installs the plugin through the claude found on PATH', (t) => {
  const box = sandbox(t)
  const log = join(box.dir, 'claude-calls.log')
  const script = join(box.dir, 'fake-claude.mjs')
  writeFileSync(
    script,
    `import { appendFileSync } from 'node:fs'\nconst args = process.argv.slice(2)\nappendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')\nif (args.includes('--json')) process.stdout.write('[]')\n`,
  )
  const bin = join(box.dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const windows = process.platform === 'win32'
  const shim = join(bin, windows ? 'claude.cmd' : 'claude')
  writeFileSync(shim, windows ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(shim, 0o755)
  const inherited = process.env['PATH'] ?? process.env['Path'] ?? ''
  for (const key of Object.keys(box.env)) if (key.toUpperCase() === 'PATH') delete box.env[key]
  box.env['PATH'] = `${bin}${delimiter}${inherited}`

  const data = box.ok('setup', '--agents', 'claude')
  const calls = readFileSync(log, 'utf8').trim().split('\n')
  assert.ok(calls.includes('plugin marketplace add KikeDeAlba/inkwell'), calls.join('\n'))
  assert.ok(calls.includes('plugin install inkwell@inkwell --scope user'))
  assert.ok(data.steps.some((step: { agent: string; item: string; state: string }) => step.agent === 'claude' && step.item === 'plugin inkwell@inkwell' && step.state === 'installed'))
  assert.equal(existsSync(join(box.dir, '.claude', 'skills', 'inkwell')), false)
})
