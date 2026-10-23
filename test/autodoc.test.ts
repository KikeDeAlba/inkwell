import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { platformContext } from '@kikedealba/kit/platform'
import { cleanMarkdown, comparableTitle, forbiddenHeadings, oneLine, safeHref, unsafeMarkdown } from '../src/autodoc/actions.ts'
import { runEnvironment } from '../src/autodoc/env.ts'
import { claimSession, sessionLockPath, setAside } from '../src/autodoc/lock.ts'
import { readdirSync } from 'node:fs'
import { redactSensitive, sensitiveContent } from '../src/autodoc/sensitive.ts'
import { advanceAutodocCursor, autodocCursor } from '../src/db/autodoc-runs.ts'
import { agents } from '@kikedealba/kit'
import { binEnvVar, failureOf, modelArguments, modelExtras, modelFor, parseActions, resolveAgent } from '../src/autodoc/model.ts'
import { configPath, loadAutodocConfig } from '../src/autodoc/config.ts'
import { stripTags, transcriptFrom, turnText } from '../src/autodoc/transcript.ts'
import { spaceForRepoSlug } from '../src/autodoc/space.ts'
import { autodocDataDir, autodocLogPath, openLog, runArguments, sessionEndInput, transcriptSessionId } from '../src/cli/commands/autodoc.ts'
import { openDatabase, openMemoryDatabase, readSchemaVersion } from '../src/db/open.ts'
import { MIGRATIONS } from '../src/db/schema.ts'
import { insertPage } from '../src/db/pages.ts'
import { insertSpace } from '../src/db/spaces.ts'
import { nodeLauncher, sandbox, type Sandbox } from './helpers/sandbox.ts'

const isolated = mkdtempSync(join(tmpdir(), 'inkwell-autodoc-'))
process.env['INKWELL_DB_PATH'] = join(isolated, 'unused.db')
process.env['INKWELL_DOCS_DIR'] = join(isolated, 'unused-docs')

const SESSION = 'abcdef12-3456-7890-abcd-ef1234567890'
const LONG = 'El servicio de cobros publica cada pago confirmado en la cola pagos-confirmados y el conciliador lo consume cada cinco minutos para cuadrar contra el banco. '.repeat(6)

function line(value: unknown): string {
  return JSON.stringify(value)
}

function transcriptLines(extra = ''): string[] {
  return [
    line({ type: 'summary', summary: 'ignored' }),
    line({ type: 'user', message: { role: 'user', content: `¿Cómo concilia el servicio de cobros?<system-reminder>secreto del arnés</system-reminder>` } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: LONG + extra }, { type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] } }),
    line({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta que no cuenta' } }),
    line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagente que no cuenta' }] } }),
  ]
}

function writeTranscript(box: Sandbox, lines: string[]): string {
  const path = join(box.dir, 'transcript.jsonl')
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

interface FakeAnswer {
  exit?: number
  sleep?: number
  result?: unknown
  isError?: boolean
}

const ANSWER_FORMATS: Record<string, string> = {
  claude: `process.stdout.write(JSON.stringify({ type: 'result', result, is_error: answer.isError === true, session_id: 's' }))`,
  codex: `process.stdout.write([{ type: 'thread.started', thread_id: 't' }, { type: 'item.completed', item: { type: 'agent_message', text: result } }].map((event) => JSON.stringify(event)).join('\\n') + '\\n')`,
}

function fakeClaude(box: Sandbox, agent: 'claude' | 'codex' = 'claude'): { answer(next: FakeAnswer): void; calls(): number; lastPrompt(): string; lastArgs(): string[]; last(): any; bin: string } {
  const dir = join(box.dir, `fake-${agent}`)
  mkdirSync(dir, { recursive: true })
  const script = join(dir, `${agent}.mjs`)
  const answerFile = join(dir, 'answer.json')
  const callsFile = join(dir, 'calls.jsonl')
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync } from 'node:fs'
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const prompt = Buffer.concat(chunks).toString('utf8')
const env = {}
for (const key of ['INKWELL_AUTODOC', 'GAZE_HARVEST', 'BITA_NO_HOOKS', 'KIT_NO_EVENTS', 'KIT_HEADLESS', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_SAFE_MODE']) if (process.env[key] !== undefined) env[key] = process.env[key]
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd(), keys: Object.keys(process.env), env }) + '\\n')
const answer = JSON.parse(readFileSync(${JSON.stringify(answerFile)}, 'utf8'))
if (answer.sleep) await new Promise((done) => setTimeout(done, answer.sleep))
if (answer.exit) {
  process.stderr.write('boom')
  process.exit(answer.exit)
}
const result = typeof answer.result === 'string' ? answer.result : JSON.stringify(answer.result ?? [])
${ANSWER_FORMATS[agent]}
`,
  )
  const bin = nodeLauncher(dir, agent, script)
  box.env[binEnvVar(agent)] = bin
  const calls = (): string[] => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean) : [])
  const last = (): { args: string[]; prompt: string } => JSON.parse(calls().at(-1) ?? '{}')
  return {
    bin,
    last,
    answer: (next) => writeFileSync(answerFile, JSON.stringify(next)),
    calls: () => calls().length,
    lastPrompt: () => last().prompt,
    lastArgs: () => last().args,
  }
}

function fakeBitaRepo(box: Sandbox, projectId: number, projectName: string): void {
  const script = join(box.dir, 'fake-bita.mjs')
  writeFileSync(
    script,
    `const args = process.argv.slice(2).filter((arg) => arg !== '--json')
const ok = args[0] === 'repo' && args[1] === 'which'
const data = ok ? { slug: 'acme/cobros', projectId: ${projectId}, projectName: ${JSON.stringify(projectName)} } : null
process.stdout.write(JSON.stringify({ schemaVersion: 3, ok: true, command: args.join(' '), generatedAt: new Date().toISOString(), data }) + '\\n')
`,
  )
  const registry = box.env['KIT_REGISTRY_DIR'] as string
  mkdirSync(registry, { recursive: true })
  writeFileSync(
    join(registry, 'bita.json'),
    JSON.stringify({ manifestVersion: 1, name: 'bita', version: '1.3.1', bin: [process.execPath, script], envelope: 1, capabilities: ['time.entries.read'], emits: [], subscribes: [] }),
  )
}

function writeConfig(box: Sandbox, autodoc: Record<string, unknown>): void {
  const path = configPath(box.env)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ autodoc }))
}

function linkSpace(box: Sandbox, spaceId: number, projectId: number): void {
  const db = new DatabaseSync(box.env['INKWELL_DB_PATH'] as string)
  db.prepare('UPDATE spaces SET external_ref = ? WHERE id = ?').run(`bita:project:${projectId}`, spaceId)
  db.close()
}

function cursorOf(box: Sandbox): number | null {
  const db = new DatabaseSync(box.env['INKWELL_DB_PATH'] as string)
  const row = db.prepare('SELECT lines FROM autodoc_runs WHERE session_id = ?').get(SESSION) as { lines: number } | undefined
  db.close()
  return row?.lines ?? null
}

interface World {
  box: Sandbox
  claude: ReturnType<typeof fakeClaude>
  transcript: string
  cwd: string
  spaceId: number
  rootId: number
  childId: number
  otherPageId: number
  run(): any
}

function world(t: { after: (fn: () => void) => void }): World {
  const box = sandbox(t, { UNRELATED_SECRET: 'nope' })
  const claude = fakeClaude(box)
  box.ok('space', 'add', 'Cobros', '--key', 'COB')
  box.ok('space', 'add', 'Otro', '--key', 'OTR')
  const root = box.ok('page', 'new', 'Arquitectura', '--project', 'COB').page
  box.ok('page', 'write', String(root.pageId), '--body', '# Arquitectura\n\n## Red\n\nTodo pasa por el balanceador.\n\n## Datos\n\nPostgres 16.')
  const child = box.ok('page', 'new', 'Conciliación', '--project', 'COB', '--parent', String(root.pageId)).page
  const otherPage = box.ok('page', 'new', 'Ajena', '--project', 'OTR').page
  fakeBitaRepo(box, 7, 'Cobros')
  linkSpace(box, root.spaceId, 7)
  const cwd = join(box.dir, 'work')
  mkdirSync(cwd, { recursive: true })
  const transcript = writeTranscript(box, transcriptLines())
  return {
    box,
    claude,
    transcript,
    cwd,
    spaceId: root.spaceId,
    rootId: root.pageId,
    childId: child.pageId,
    otherPageId: otherPage.pageId,
    run: () => box.ok('autodoc-run', '--transcript', transcript, '--session', SESSION, '--cwd', cwd),
  }
}

function docsGit(box: Sandbox, ...args: string[]): string {
  return execFileSync('git', args, { cwd: box.env['INKWELL_DOCS_DIR'] as string, encoding: 'utf8', env: box.env })
}

function pageFile(box: Sandbox, pageId: number): string {
  const page = box.ok('page', 'show', String(pageId))
  return readFileSync(join(box.env['INKWELL_DOCS_DIR'] as string, page.relPath), 'utf8')
}

test('stripTags removes harness tags, and only real user and assistant text turns count', () => {
  assert.equal(stripTags('hola<system-reminder>x</system-reminder> mundo<command-args>--y</command-args>'), 'hola mundo')
  assert.equal(stripTags('antes<task-notification>sin cierre'), 'antes')
  assert.equal(stripTags('<local-command-stdout>out</local-command-stdout><local-command-stderr>err</local-command-stderr><command-message>m</command-message>'), '')
  assert.equal(turnText(line({ type: 'user', message: { content: 'hola' } })), 'USER: hola')
  assert.equal(turnText(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] } })), 'ASSISTANT: a\nb')
  assert.equal(turnText(line({ type: 'user', isMeta: true, message: { content: 'x' } })), null)
  assert.equal(turnText(line({ type: 'assistant', isSidechain: true, message: { content: 'x' } })), null)
  assert.equal(turnText(line({ type: 'system', message: { content: 'x' } })), null)
  assert.equal(turnText(line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } })), null)
  assert.equal(turnText('{not json'), null)

  const slice = transcriptFrom(`${transcriptLines().join('\n')}\n`, 0)
  assert.equal(slice.lines, 5)
  assert.match(slice.text, /^USER: ¿Cómo concilia/)
  assert.doesNotMatch(slice.text, /secreto|meta que no cuenta|subagente/)
  assert.equal(transcriptFrom(`${transcriptLines().join('\n')}\n`, 2).text.startsWith('ASSISTANT:'), true)
  assert.equal(transcriptFrom(`${transcriptLines().join('\n')}\n`, 5).text, '')
})

test('codex and gemini transcripts read as plain user and assistant turns', () => {
  const codex = [
    line({ type: 'session_meta', payload: { id: 'x' } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'reglas del arnés' }] } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>x</INSTRUCTIONS>' }] } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '¿Cómo concilia?' }] } }),
    line({ type: 'response_item', payload: { type: 'reasoning', summary: [] } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Con la cola.' }] } }),
  ]
  assert.equal(transcriptFrom(`${codex.join('\n')}\n`, 0).text, 'USER: ¿Cómo concilia?\n\nASSISTANT: Con la cola.\n\n')

  const gemini = [
    line({ sessionId: 's', projectHash: 'h', kind: 'main' }),
    line({ id: 'a', type: 'user', content: [{ text: '<session_context>contexto</session_context>' }] }),
    line({ id: 'b', type: 'user', content: [{ text: '¿Cómo concilia?' }] }),
    line({ id: 'c', type: 'gemini', content: 'Con la cola.', model: 'm' }),
    line({ $set: { lastUpdated: 'x' } }),
    line({ id: 'c', type: 'gemini', content: 'Con la cola.', tokens: { total: 1 } }),
    line({ id: 'd', type: 'info', content: 'aviso' }),
  ]
  const raw = `${gemini.join('\n')}\n`
  assert.equal(transcriptFrom(raw, 0).text, 'USER: ¿Cómo concilia?\n\nASSISTANT: Con la cola.\n\n')
  assert.equal(transcriptFrom(raw, 5).text, '')

  const toolFirst = [
    line({ id: 'e', type: 'gemini', content: '', toolCalls: [{ name: 'read_file' }] }),
    line({ id: 'e', type: 'gemini', content: 'Leí el archivo.', toolCalls: [{ name: 'read_file' }] }),
    line({ id: 'e', type: 'gemini', content: 'Leí el archivo.', tokens: { total: 2 } }),
  ]
  assert.equal(transcriptFrom(`${toolFirst.join('\n')}\n`, 0).text, 'ASSISTANT: Leí el archivo.\n\n')
  assert.equal(transcriptFrom(`${toolFirst.join('\n')}\n`, 1).text, 'ASSISTANT: Leí el archivo.\n\n')
})

test('kit failures keep the log codes autodoc wrote before', () => {
  const code = (error: agents.HeadlessError) => failureOf(error).message
  assert.equal(code(new agents.HeadlessError('FAILED', 'claude', 'x', { exitCode: 1 })), 'exit-1')
  assert.equal(code(new agents.HeadlessError('FAILED', 'claude', 'x', { exitCode: null })), 'exit-signal')
  assert.equal(code(new agents.HeadlessError('FAILED', 'claude', 'x', { exitCode: 0 })), 'is-error')
  assert.equal(code(new agents.HeadlessError('PARSE', 'claude', 'x', { exitCode: 0 })), 'not-json')
  assert.equal(code(new agents.HeadlessError('TIMEOUT', 'codex', 'x')), 'timeout')
  assert.equal(code(new agents.HeadlessError('UNAVAILABLE', 'codex', 'x')), 'spawn')
  assert.equal(code(new agents.HeadlessError('PROMPT_TOO_LONG', 'antigravity', 'x')), 'prompt-too-long')
})

test('an agent that cannot run falls back to the first one installed, and the overrides apply to the fallback too', async (t) => {
  const box = sandbox(t)
  const dir = join(box.dir, 'bin')
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'noop.mjs')
  writeFileSync(script, '')
  const claude = nodeLauncher(dir, 'claude', script)
  const env: NodeJS.ProcessEnv = { PATH: dir, HOME: box.dir, USERPROFILE: box.dir, APPDATA: box.env['APPDATA'], LOCALAPPDATA: box.env['LOCALAPPDATA'], ...(process.platform === 'win32' ? { PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: process.env['SystemRoot'] } : {}) }
  const picked = await resolveAgent('vim', env)
  assert.equal(picked.agent, 'claude')
  assert.equal(picked.fallback, true)
  assert.equal(realpathSync(picked.bin), realpathSync(claude))
  assert.deepEqual(await resolveAgent('claude', env), { agent: 'claude', bin: picked.bin, fallback: false })
  const other = join(box.dir, 'other')
  mkdirSync(other, { recursive: true })
  const opencode = nodeLauncher(other, 'opencode', script)
  const missing = join(dir, 'missing')
  const viaOverride = await resolveAgent('vim', { ...env, PATH: other, INKWELL_OPENCODE_BIN: opencode, INKWELL_CLAUDE_BIN: missing, INKWELL_CODEX_BIN: missing, INKWELL_GEMINI_BIN: missing, INKWELL_ANTIGRAVITY_BIN: missing })
  assert.equal(viaOverride.fallback, true)
  assert.equal(realpathSync(viaOverride.bin), realpathSync(opencode))
})

test('autodoc runs on the agent from the config, without the claude model or flags', (t) => {
  const w = world(t)
  const codex = fakeClaude(w.box, 'codex')
  writeConfig(w.box, { agent: 'codex' })
  codex.answer({ result: [{ action: 'propose', pageId: w.rootId, section: 'Red', markdown: '## Red\n\nTodo pasa por el WAF.', reason: 'r' }] })
  const result = w.run()
  assert.equal(result.status, 'done')
  assert.equal(result.agent, 'codex')
  assert.equal(result.fallback, false)
  assert.equal(w.claude.calls(), 0)
  const args = codex.lastArgs()
  assert.equal(args[0], 'exec')
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only')
  assert.ok(!args.includes('-m') && !args.includes('--disallowedTools'))
  assert.deepEqual(codex.last().env, { INKWELL_AUTODOC: '1', GAZE_HARVEST: '1', BITA_NO_HOOKS: '1', KIT_NO_EVENTS: '1', KIT_HEADLESS: '1' })
  assert.match(codex.lastPrompt(), /<conversation>\nUSER: ¿Cómo concilia/)
})

test('actions come from the outermost JSON array, and claude runs without tools, settings or MCP', () => {
  assert.deepEqual(parseActions('Aquí va:\n[{"action":"create","title":"[x]"}]\nfin'), [{ action: 'create', title: '[x]' }])
  assert.equal(parseActions('nada que documentar'), null)
  const actions = [{ action: 'create', title: 'Cola [beta]', parentId: 1, markdown: 'a ] b', reason: 'r' }]
  assert.deepEqual(parseActions(`Nota [importante]\n${JSON.stringify(actions)}\nFin [ok]`), actions)
  assert.deepEqual(parseActions('Nota [importante]\n[]\nFin [ok]'), [])
  assert.equal(parseActions('[1, 2] y [{"no":"accion"}]'), null)
  const args = modelArguments('claude')
  for (const flag of ['--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(args.includes(flag), flag)
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'project')
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'Read,Grep,Glob')
  assert.ok(!args.includes('--add-dir'))
  assert.deepEqual(modelArguments('codex'), [])
  assert.equal(modelExtras('codex')['CLAUDE_CODE_SAFE_MODE'], undefined)
  assert.equal(modelExtras('codex')['INKWELL_AUTODOC'], '1')
  assert.equal(modelFor({ model: null }, { agent: 'claude' }), 'haiku')
  assert.equal(modelFor({ model: 'sonnet' }, { agent: 'claude' }), 'sonnet')
  assert.equal(modelFor({ model: 'sonnet' }, { agent: 'codex' }), undefined)
  assert.equal(modelFor({ model: 'sonnet', models: { codex: 'gpt-5' } }, { agent: 'codex' }), 'gpt-5')
  assert.equal(modelFor({ model: null, models: { gemini: 'flash' } }, { agent: 'opencode' }), undefined)
})

test('backlog and logbook headings are rejected, and titles compare without case or accents', () => {
  assert.deepEqual(forbiddenHeadings('# T\n\n## Red\n\nx\n\n## Pendiente\n\n- algo'), ['Pendiente'])
  assert.deepEqual(forbiddenHeadings('## Próximos pasos\n\nx\n\n## Bitácora\n\ny'), ['Próximos pasos', 'Bitácora'])
  assert.deepEqual(forbiddenHeadings('cuerpo', 'Hallazgos'), ['Hallazgos'])
  assert.deepEqual(forbiddenHeadings('# T\n\n## Red\n\nx'), [])
  assert.equal(comparableTitle('  Conciliación  Bancaria'), comparableTitle('conciliacion bancaria'))
})

test('the autodoc config falls back to its defaults and reads the autodoc block', (t) => {
  const box = sandbox(t)
  assert.deepEqual(loadAutodocConfig(box.env), { enabled: true, agent: 'claude', model: null, models: {}, maxChars: 40000, minChars: 600, maxActions: 5, timeoutSeconds: 240 })
  writeConfig(box, { enabled: false, agent: 'codex', model: 'sonnet', models: { codex: 'gpt-5', gemini: '', bad: 3 }, maxActions: 2 })
  const config = loadAutodocConfig(box.env)
  assert.equal(config.enabled, false)
  assert.equal(config.agent, 'codex')
  assert.deepEqual(config.models, { codex: 'gpt-5' })
  assert.equal(config.model, 'sonnet')
  assert.equal(config.maxActions, 2)
  assert.equal(config.minChars, 600)
})

test('a valid proposal lands on an autodoc branch and leaves the page on main as it was', (t) => {
  const w = world(t)
  const before = pageFile(w.box, w.rootId)
  w.claude.answer({ result: [{ action: 'propose', pageId: w.rootId, section: 'Red', markdown: '## Red\n\nTodo pasa por el balanceador y el WAF.', reason: 'El WAF quedó delante del balanceador.' }] })

  const result = w.run()
  assert.equal(result.status, 'done')
  assert.equal(result.outcomes.length, 1)
  const outcome = result.outcomes[0]
  assert.equal(outcome.kind, 'propose')
  assert.equal(outcome.branch, `autodoc/abcdef12-${w.rootId}`)
  assert.equal(pageFile(w.box, w.rootId), before)
  assert.equal(docsGit(w.box, 'branch', '--show-current').trim(), 'main')
  const proposed = docsGit(w.box, 'show', `${outcome.branch}:${w.box.ok('page', 'show', String(w.rootId)).relPath}`)
  assert.match(proposed, /## Red\n\nTodo pasa por el balanceador y el WAF\./)
  assert.match(proposed, /## Datos\n\nPostgres 16\./)
  const trailers = docsGit(w.box, 'log', '-1', '--format=%(trailers:only,unfold)', outcome.branch)
  assert.match(trailers, /Inkwell-Source: session/)
  assert.match(trailers, new RegExp(`Inkwell-Session: ${SESSION}`))

  const prompt = w.claude.lastPrompt()
  assert.match(prompt, new RegExp(`id=${w.rootId} «Arquitectura» parentId=null profundidad=0 ruta=cobros/arquitectura\\.md \\| H2: «Red», «Datos»`))
  assert.match(prompt, new RegExp(`id=${w.childId} «Conciliación» parentId=${w.rootId} profundidad=1`))
  assert.doesNotMatch(prompt, /Ajena/)
  assert.match(prompt, /<conversation>\nUSER: ¿Cómo concilia/)
  assert.doesNotMatch(prompt, /secreto del arnés/)
  assert.match(prompt, /Prohibido: «por decisión del usuario»/)
  assert.match(prompt, /«Qué es», «Cómo funciona», «Decisiones vigentes», «Límites» y «Cómo se verifica»/)
  assert.match(prompt, /`profundidad=` 3 o menos/)
  assert.doesNotMatch(prompt, /inkwell (page|backlog|guide)|--brief|Read/)
  assert.match(prompt, /\{"action":"propose"/)
  assert.match(prompt, new RegExp(`<page id="${w.rootId}">\n# Arquitectura\n\n## Red\n\nTodo pasa por el balanceador\\.`))
  const args = w.claude.lastArgs()
  assert.deepEqual(w.claude.last().env, { INKWELL_AUTODOC: '1', GAZE_HARVEST: '1', BITA_NO_HOOKS: '1', KIT_NO_EVENTS: '1', KIT_HEADLESS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_SAFE_MODE: '1' })
  assert.equal(args[args.indexOf('--model') + 1], 'haiku')
  assert.equal(result.agent, 'claude')
  assert.equal(result.fallback, false)
  const cwd = w.claude.last().cwd as string
  assert.ok(realpathSync(dirname(cwd)) === realpathSync(tmpdir()) && basename(cwd).startsWith('inkwell-autodoc-'))
  assert.equal(existsSync(cwd), false)
  assert.ok(!args.includes('--add-dir'))
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'Read,Grep,Glob')
  assert.ok(!args.includes('--safe-mode') && !args.includes('--restricted') && !args.includes('--help'))
  assert.equal(w.claude.calls(), 1)
  const keys = w.claude.last().keys as string[]
  assert.ok(!keys.includes('UNRELATED_SECRET'))

  docsGit(w.box, 'branch', `autodoc/abcdef12-${w.rootId}-2`, 'main')
  w.claude.answer({ result: [{ action: 'propose', pageId: w.rootId, section: 'Datos', markdown: 'Postgres 17.', reason: 'Se actualizó Postgres.' }] })
  writeTranscript(w.box, [...transcriptLines(), ...transcriptLines(' Segunda parte.')])
  assert.equal(w.run().outcomes[0].branch, `autodoc/abcdef12-${w.rootId}-3`)

  const listed = w.box.ok('autodoc', 'ls').proposals
  assert.deepEqual(listed.map((item: { branch: string }) => item.branch), [`autodoc/abcdef12-${w.rootId}`, `autodoc/abcdef12-${w.rootId}-3`])
  assert.equal(listed[0].commits[0].pageId, w.rootId)
  assert.equal(listed[0].commits[0].title, 'Arquitectura')
  assert.equal(listed[0].commits[0].reason, 'El WAF quedó delante del balanceador.')
  assert.equal(listed[0].commits[0].session, SESSION)
  assert.equal(listed[0].commits[0].section, 'Red')

  const applied = w.box.ok('branch', 'apply', outcome.branch, '--commit', outcome.sha)
  assert.equal(applied.pageId, w.rootId)
  assert.match(pageFile(w.box, w.rootId), /balanceador y el WAF/)
  assert.deepEqual(w.box.ok('autodoc', 'ls').proposals.map((item: { branch: string }) => item.branch), [`autodoc/abcdef12-${w.rootId}-3`])
})

test('a proposal for a section that does not exist, or one outside the space, is dropped', (t) => {
  const w = world(t)
  w.claude.answer({
    result: [
      { action: 'propose', pageId: w.rootId, section: 'Seguridad', markdown: 'Algo.', reason: 'r' },
      { action: 'propose', pageId: w.otherPageId, markdown: '# Ajena\n\nx', reason: 'r' },
      { action: 'propose', pageId: w.rootId, section: 'Red', markdown: 'x\n\n## Pendiente\n\n- revisar', reason: 'r' },
    ],
  })
  const result = w.run()
  assert.deepEqual(result.outcomes.map((item: { reason: string }) => item.reason), ['section-not-found', 'page-outside-space', 'forbidden-heading'])
  assert.deepEqual(w.box.ok('branch', 'ls').branches, [])
})

test('a new page hangs from a valid parent with the right depth and title', (t) => {
  const w = world(t)
  w.claude.answer({ result: [{ action: 'create', title: 'Cola de pagos', parentId: w.childId, markdown: '## Qué es\n\nLa cola pagos-confirmados guarda cada pago confirmado.', reason: 'Documenta la cola.' }] })
  const result = w.run()
  assert.equal(result.outcomes[0].kind, 'create')
  assert.equal(result.outcomes[0].parentId, w.childId)
  const page = w.box.ok('page', 'show', String(result.outcomes[0].pageId))
  assert.equal(page.parentId, w.childId)
  assert.equal(page.depth, 2)
  assert.equal(page.spaceId, w.spaceId)
  assert.equal(page.relPath, 'cobros/arquitectura/conciliacion/cola-de-pagos.md')
  const body = pageFile(w.box, page.pageId)
  assert.match(body, /\n# Cola de pagos\n\n## Qué es\n\nLa cola pagos-confirmados/)
  assert.match(docsGit(w.box, 'log', '-1', '--format=%(trailers:only,unfold)'), /Inkwell-Source: session/)
})

test('a new page without a parent, with a parent from another space or with a repeated title is not created', (t) => {
  const w = world(t)
  const count = () => w.box.ok('page', 'ls').pages.length
  const before = count()
  w.claude.answer({
    result: [
      { action: 'create', title: 'Suelta', markdown: 'x', reason: 'r' },
      { action: 'create', title: 'Prestada', parentId: w.otherPageId, markdown: 'x', reason: 'r' },
      { action: 'create', title: 'CONCILIACION', parentId: w.rootId, markdown: 'x', reason: 'r' },
      { action: 'create', title: 'Con pendientes', parentId: w.rootId, markdown: '## Pendiente\n\n- algo', reason: 'r' },
      { action: 'create', title: 'Profunda', parentId: 999, markdown: 'x', reason: 'r' },
    ],
  })
  const result = w.run()
  assert.deepEqual(result.outcomes.map((item: { reason: string }) => item.reason), ['no-parent', 'parent-outside-space', 'duplicate-title', 'forbidden-heading', 'parent-not-found'])
  assert.equal(count(), before)
  assert.equal(result.status, 'done')
})

test('a failing model leaves the cursor alone; a good run moves it, and nothing new skips the model', (t) => {
  const w = world(t)
  w.claude.answer({ exit: 1 })
  assert.equal(w.run().status, 'model-failed')
  assert.equal(cursorOf(w.box), null)

  w.claude.answer({ result: 'error', isError: true })
  assert.equal(w.run().status, 'model-failed')
  assert.equal(cursorOf(w.box), null)

  w.claude.answer({ result: [] })
  const good = w.run()
  assert.equal(good.status, 'done')
  assert.deepEqual(good.outcomes, [])
  assert.equal(cursorOf(w.box), 5)
  assert.equal(w.claude.calls(), 3)

  const again = w.run()
  assert.equal(again.status, 'nothing-new')
  assert.equal(w.claude.calls(), 3)
  assert.equal(cursorOf(w.box), 5)
})

test('a model that runs past its timeout is killed and the cursor stays', (t) => {
  const w = world(t)
  writeConfig(w.box, { timeoutSeconds: 1 })
  w.claude.answer({ sleep: 5000, result: [] })
  const started = Date.now()
  assert.equal(w.run().status, 'model-failed')
  assert.ok(Date.now() - started < 4500)
  assert.equal(cursorOf(w.box), null)
})

test('an empty space takes its first page at the root', (t) => {
  const box = sandbox(t)
  const claude = fakeClaude(box)
  box.ok('space', 'add', 'Vacio', '--key', 'VAC')
  const spaceId = box.ok('space', 'show', 'VAC').id
  fakeBitaRepo(box, 9, 'Vacio')
  linkSpace(box, spaceId, 9)
  claude.answer({ result: [{ action: 'create', title: 'Visión general', markdown: 'El sistema cobra y concilia.', reason: 'r' }, { action: 'create', title: 'Otra raíz', markdown: 'x', reason: 'r' }] })
  const result = box.ok('autodoc-run', '--transcript', writeTranscript(box, transcriptLines()), '--session', SESSION, '--cwd', box.dir)
  assert.equal(result.outcomes[0].kind, 'create')
  assert.equal(result.outcomes[0].parentId, null)
  assert.equal(result.outcomes[1].reason, 'no-parent')
  assert.equal(box.ok('page', 'show', String(result.outcomes[0].pageId)).depth, 0)
})

test('the repository fallback picks a space only when every page of that repo agrees', () => {
  const db = openMemoryDatabase()
  const now = '2026-10-18T00:00:00.000Z'
  const one = insertSpace(db, { name: 'Uno', createdAt: now })
  const two = insertSpace(db, { name: 'Dos', createdAt: now })
  const page = (spaceId: number, slug: string, repoSlug: string) =>
    insertPage(db, { spaceId, parentId: null, slug, title: slug, relPath: `${slug}.md`, depth: 0, source: 'cli', repoSlug, now })
  page(one.id, 'a', 'acme/app')
  page(one.id, 'b', 'acme/app')
  page(one.id, 'c', 'acme/mixed')
  page(two.id, 'd', 'acme/mixed')
  assert.equal(spaceForRepoSlug(db, 'acme/app')?.id, one.id)
  assert.equal(spaceForRepoSlug(db, 'acme/mixed'), null)
  assert.equal(spaceForRepoSlug(db, 'acme/none'), null)
})

test('without a mapped space the run stops before calling the model', (t) => {
  const box = sandbox(t)
  const claude = fakeClaude(box)
  box.ok('space', 'add', 'Cobros', '--key', 'COB')
  const transcript = writeTranscript(box, transcriptLines())
  const result = box.ok('autodoc-run', '--transcript', transcript, '--session', SESSION, '--cwd', box.dir)
  assert.equal(result.status, 'no-space')
  assert.equal(claude.calls(), 0)
  assert.equal(box.ok('space', 'ls').spaces?.length ?? box.ok('space', 'ls').length, 1)
})

test('the session-end hook reads its input and stays quiet when autodoc is off', (t) => {
  const box = sandbox(t)
  assert.equal(sessionEndInput({ transcript_path: '/t.jsonl', session_id: 's', cwd: '/w' }, { ...box.env, INKWELL_AUTODOC: '1' }), null)
  assert.equal(sessionEndInput({ transcript_path: '/t.jsonl' }, { ...box.env, INKWELL_NO_AUTODOC: '1' }), null)
  assert.equal(sessionEndInput({ session_id: 's' }, box.env), null)
  assert.deepEqual(sessionEndInput({ transcript_path: '/t.jsonl', session_id: 's', cwd: '/w' }, { ...box.env, INKWELL_AUTODOC: '0' }), { transcript: '/t.jsonl', session: 's', cwd: '/w' })
  assert.equal(sessionEndInput({ transcript_path: '/t.jsonl' }, { ...box.env, CLAUDE_PROJECT_DIR: '/p' })?.cwd, '/p')
  assert.equal(sessionEndInput({ transcript_path: '/t.jsonl' }, { ...box.env, KIT_HEADLESS: '1' }), null)
  assert.equal(sessionEndInput({ transcript_path: '/t.jsonl' }, { ...box.env, GEMINI_PROJECT_DIR: '/g', CLAUDE_PROJECT_DIR: '/p' }, 'gemini')?.cwd, '/g')
  assert.equal(sessionEndInput({ transcript_path: '/t.jsonl' }, { ...box.env, CLAUDE_PROJECT_DIR: '/p' }, 'codex')?.cwd, process.cwd())
  assert.equal(autodocLogPath(box.env), join(platformContext({ env: box.env }).platform === 'win32' ? join(box.dir, 'localappdata') : join(box.dir, 'data'), 'inkwell', 'autodoc.log'))
})

test('hook session-end inside a headless agent launches nothing, and an unknown harness is refused', async (t) => {
  const box = sandbox(t, { KIT_HEADLESS: '1' })
  const claude = fakeClaude(box)
  const transcript = writeTranscript(box, transcriptLines())
  const result = box.run(['hook', 'session-end', '--harness', 'gemini'], JSON.stringify({ transcript_path: transcript, session_id: SESSION, cwd: box.dir }))
  assert.equal(result.status, 0)
  assert.notEqual(box.run(['hook', 'session-end', '--harness', 'vim'], '{}').status, 0)
  await new Promise((done) => setTimeout(done, 1500))
  assert.equal(existsSync(autodocLogPath(box.env)), false)
  assert.equal(claude.calls(), 0)
})

test('hook session-end with INKWELL_AUTODOC set launches nothing', async (t) => {
  const box = sandbox(t, { INKWELL_AUTODOC: '1' })
  const claude = fakeClaude(box)
  const transcript = writeTranscript(box, transcriptLines())
  const result = box.run(['hook', 'session-end'], JSON.stringify({ transcript_path: transcript, session_id: SESSION, cwd: box.dir }))
  assert.equal(result.status, 0)
  await new Promise((done) => setTimeout(done, 1500))
  assert.equal(existsSync(autodocLogPath(box.env)), false)
  assert.equal(claude.calls(), 0)
})

test('hook session-end launches the run in the background and returns at once', async (t) => {
  const box = sandbox(t)
  delete box.env['INKWELL_AUTODOC']
  fakeClaude(box)
  const transcript = writeTranscript(box, [line({ type: 'user', message: { content: 'hola' } })])
  const started = Date.now()
  const result = box.run(['hook', 'session-end'], JSON.stringify({ transcript_path: transcript, session_id: SESSION, cwd: box.dir }))
  assert.equal(result.status, 0)
  assert.ok(Date.now() - started < 5000)
  const log = autodocLogPath(box.env)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !(existsSync(log) && /nothing-new/.test(readFileSync(log, 'utf8')))) await new Promise((done) => setTimeout(done, 100))
  assert.match(readFileSync(log, 'utf8'), /^\S+ autodoc abcdef12 \[-\] 12 chars -> skip:nothing-new$/m)
  if (process.platform !== 'win32') assert.equal(statSync(log).mode & 0o777, 0o600)
  await new Promise((done) => setTimeout(done, 1000))
})

test('only maxActions actions are applied and the rest are skipped, even inside a fenced answer', (t) => {
  const w = world(t)
  writeConfig(w.box, { maxActions: 2 })
  const actions = [1, 2, 3, 4].map((n) => ({ action: 'create', title: `Extra ${n}`, parentId: w.rootId, markdown: `Cuerpo ${n}`, reason: 'r' }))
  w.claude.answer({ result: `Esto propongo:\n\`\`\`json\n${JSON.stringify(actions)}\n\`\`\`\nFin.` })
  const result = w.run()
  assert.deepEqual(result.outcomes.map((item: { kind: string; reason?: string }) => item.reason ?? item.kind), ['create', 'create', 'max-actions', 'max-actions'])
  const titles = w.box.ok('page', 'ls').pages.map((page: { title: string }) => page.title)
  assert.ok(titles.includes('Extra 1') && titles.includes('Extra 2'))
  assert.ok(!titles.includes('Extra 3') && !titles.includes('Extra 4'))
})

test('string page ids are accepted, bad ids are skipped and a page past the depth limit is refused', (t) => {
  const w = world(t)
  let parent = w.childId
  for (let level = 0; level < 3; level += 1) parent = w.box.ok('page', 'new', `Nivel ${level}`, '--project', 'COB', '--parent', String(parent)).page.pageId
  w.claude.answer({
    result: [
      { action: 'create', title: 'Con id texto', parentId: String(w.rootId), markdown: 'Cuerpo', reason: 'r' },
      { action: 'create', title: 'Id basura', parentId: 'abc', markdown: 'Cuerpo', reason: 'r' },
      { action: 'create', title: 'Id fraccion', parentId: '1.5', markdown: 'Cuerpo', reason: 'r' },
      { action: 'create', title: 'Demasiado hondo', parentId: parent, markdown: 'Cuerpo', reason: 'r' },
      { action: 'propose', pageId: String(w.rootId), section: 'Red', markdown: '## Red\n\nTodo pasa por un balanceador ALB.', reason: 'r' },
      { action: 'delete', pageId: w.rootId },
    ],
  })
  const result = w.run()
  assert.deepEqual(
    result.outcomes.map((item: { kind: string; reason?: string }) => item.reason ?? item.kind),
    ['create', 'no-parent', 'no-parent', 'too-deep', 'propose', 'unknown-action'],
  )
  assert.equal(result.outcomes[0].parentId, w.rootId)
})

test('a transcript that does not exist or is not JSON never reaches the model', (t) => {
  const w = world(t)
  const missing = w.box.run(['autodoc-run', '--transcript', join(w.box.dir, 'missing.jsonl'), '--session', SESSION, '--cwd', w.cwd])
  assert.equal(missing.status, 0)
  assert.equal(missing.json.data.status, 'transcript-unreadable')
  assert.match(missing.stdout, /^\S+ autodoc abcdef12 \[-\] 0 chars -> skip:transcript-unreadable$/m)
  const corrupt = join(w.box.dir, 'corrupt.jsonl')
  writeFileSync(corrupt, 'not json\n{broken\n')
  const result = w.box.run(['autodoc-run', '--transcript', corrupt, '--session', SESSION, '--cwd', w.cwd])
  assert.equal(result.status, 0)
  assert.equal(result.json.data.status, 'transcript-unreadable')
  assert.equal(w.claude.calls(), 0)
  assert.equal(cursorOf(w.box), null)
})

test('secrets are redacted before the model sees them and actions that still carry one are dropped', (t) => {
  assert.equal(redactSensitive('clave\npassword: hunter22 y AKIAABCDEFGHIJKLMNOP\npago 4111 1111 1111 1111'), 'clave\n[REDACTED] y [REDACTED]\npago [REDACTED]')
  assert.equal(redactSensitive('escribe a ana@example.com'), 'escribe a ana@example.com')
  assert.equal(sensitiveContent('ghp_' + 'a'.repeat(36)), 'github-token')
  assert.equal(sensitiveContent('la cola de pagos'), null)

  const w = world(t)
  writeTranscript(w.box, transcriptLines(' El token: sk-abcdefghijklmnopqrstuvwxyz123456 y la tarjeta 4111-1111-1111-1111.'))
  w.claude.answer({
    result: [
      { action: 'create', title: 'Credenciales', parentId: w.rootId, markdown: 'Usa AKIAABCDEFGHIJKLMNOP para entrar.', reason: 'r' },
      { action: 'create', title: 'Pagos', parentId: w.rootId, markdown: 'Ok.', reason: 'Vimos la tarjeta 4111 1111 1111 1111' },
      { action: 'propose', pageId: w.rootId, section: 'Red', markdown: 'Conecta con postgres://app:s3cret@db:5432/app.', reason: 'r' },
    ],
  })
  const result = w.run()
  assert.deepEqual(result.outcomes.map((item: { reason: string }) => item.reason), ['sensitive-content', 'sensitive-content', 'sensitive-content'])
  const prompt = w.claude.lastPrompt()
  assert.doesNotMatch(prompt, /sk-abcdefghij|4111/)
  assert.match(prompt, /\[REDACTED\]/)
})

test('images, raw HTML and data URIs never reach a page', (t) => {
  assert.equal(unsafeMarkdown('![x](y.png)'), 'image')
  assert.equal(unsafeMarkdown('<script>alert(1)</script>'), 'html')
  assert.equal(unsafeMarkdown('[a](data:text/html;base64,AAAA)'), 'link')
  assert.equal(unsafeMarkdown('```html\n<div>ok</div>\n```\n\nUsa `<br>` y a < b > c.'), null)
  assert.equal(unsafeMarkdown('\\`<img src=x onerror=alert(1)>\\`'), 'html')
  assert.equal(unsafeMarkdown('```a`b\n<img src=x onerror=alert(1)>\n```'), 'html')
  assert.equal(unsafeMarkdown('- uno\n  - dos <b onclick=x>y</b>'), 'html')
  assert.equal(unsafeMarkdown('> cita\n>\n> ![a](b.png)'), 'image')
  assert.equal(unsafeMarkdown('| a |\n|---|\n| <i>x</i> |'), 'html')
  assert.equal(unsafeMarkdown('[x](javascript:alert(1))'), 'link')
  assert.equal(unsafeMarkdown('[x](JaVaScRiPt:alert(1))'), 'link')
  assert.equal(unsafeMarkdown('[x](<java\tscript:alert(1)>)'), 'link')
  assert.equal(unsafeMarkdown('[r]: vbscript:x\n\n[a][r]'), 'link')
  assert.equal(unsafeMarkdown('[x](//evil.example/a)'), 'link')
  assert.equal(unsafeMarkdown('[x](mailto:a@b.c)'), 'link')
  assert.equal(unsafeMarkdown('[a](https://example.com) [b](../otra.md) [c](#red) <https://example.com>'), null)

  const w = world(t)
  w.claude.answer({
    result: [
      { action: 'create', title: 'Diagrama', parentId: w.rootId, markdown: '![red](red.png)', reason: 'r' },
      { action: 'create', title: 'Html', parentId: w.rootId, markdown: '<iframe src="x"></iframe>', reason: 'r' },
      { action: 'propose', pageId: w.rootId, section: 'Red', markdown: '[x](data:image/png;base64,AAAA)', reason: 'r' },
    ],
  })
  assert.deepEqual(w.run().outcomes.map((item: { reason: string }) => item.reason), ['unsafe-markdown', 'unsafe-markdown', 'unsafe-markdown'])
})

test('titles, reasons and sections are one clean line, so a newline or ESC injects nothing', (t) => {
  assert.equal(oneLine('Cola\n---\nfoo: bar\u001b[31m rojo\u200b', 120), 'Cola --- foo: bar [31m rojo')
  assert.equal(oneLine('x'.repeat(200), 120)?.length, 120)
  assert.equal(cleanMarkdown('a\u001b[2Jb\r\nc\td'), 'a[2Jb\nc\td')

  const w = world(t)
  w.claude.answer({ result: [{ action: 'create', title: 'Cola\n---\ninjected: yes\u001b[31m', parentId: w.rootId, markdown: 'Cuerpo \u001b[31mrojo.', reason: 'r\u001b]0;x\u0007' }] })
  const result = w.run()
  assert.equal(result.outcomes[0].kind, 'create')
  const page = w.box.ok('page', 'show', String(result.outcomes[0].pageId))
  assert.equal(page.title, 'Cola --- injected: yes [31m')
  assert.equal(page.doc.frontMatter.injected, undefined)
  const file = pageFile(w.box, page.pageId)
  assert.doesNotMatch(file, /\u001b|\u0007/)
  assert.doesNotMatch(file, /^injected:/m)
})

test('new pages wait for approval, and approve or a human page write releases them', (t) => {
  const w = world(t)
  w.claude.answer({
    result: [
      { action: 'create', title: 'Cola de pagos', parentId: w.rootId, markdown: 'La cola guarda cada pago.', reason: 'r' },
      { action: 'create', title: 'Reintentos', parentId: w.rootId, markdown: 'Tres reintentos.', reason: 'r' },
    ],
  })
  const [first, second] = w.run().outcomes
  const pending = () => w.box.ok('autodoc', 'ls').pending.map((item: { pageId: number }) => item.pageId)
  assert.deepEqual(pending(), [first.pageId, second.pageId])
  assert.equal(w.box.ok('autodoc', 'ls').pending[0].session, SESSION)
  assert.deepEqual(w.box.ok('autodoc', 'approve', String(first.pageId)), { pageId: first.pageId, title: 'Cola de pagos', approved: true, wasPending: true })
  assert.deepEqual(pending(), [second.pageId])
  w.box.ok('page', 'write', String(second.pageId), '--body', '# Reintentos\n\nTres reintentos con espera exponencial.')
  assert.deepEqual(pending(), [])
  assert.equal(w.box.ok('autodoc', 'approve', String(second.pageId)).wasPending, false)
  assert.equal(w.box.run(['autodoc', 'approve', '999']).json.error.code, 'PAGE_NOT_FOUND')
})

test('a proposal is only made over a page the prompt carried in full', (t) => {
  const w = world(t)
  const long = `# Conciliación\n\n## Detalle\n\n${'linea larga del proceso de conciliación. '.repeat(400)}`
  w.box.ok('page', 'write', String(w.childId), '--body', long)
  w.claude.answer({
    result: [
      { action: 'propose', pageId: w.childId, markdown: '# Conciliación\n\nCorta.', reason: 'r' },
      { action: 'propose', pageId: w.childId, section: 'Detalle', markdown: 'Se concilia cada cinco minutos.', reason: 'r' },
    ],
  })
  const result = w.run()
  assert.deepEqual(result.outcomes.map((item: { kind: string; reason?: string }) => item.reason ?? item.kind), ['page-truncated', 'propose'])
  assert.match(w.claude.lastPrompt(), new RegExp(`<page id="${w.childId}" recortada="sí">`))
})

test('the cursor stays when the answer is unparseable or every write fails, and never moves back', (t) => {
  const w = world(t)
  w.claude.answer({ result: 'No hay nada durable.' })
  const unparseable = w.run()
  assert.equal(unparseable.status, 'unparseable')
  assert.equal(cursorOf(w.box), null)

  const blocker = join(w.box.env['INKWELL_DOCS_DIR'] as string, 'cobros', 'arquitectura', 'conciliacion')
  writeFileSync(blocker, 'not a folder')
  w.claude.answer({ result: [{ action: 'create', title: 'Bloqueada', parentId: w.childId, markdown: 'x', reason: 'r' }] })
  const failed = w.run()
  assert.equal(failed.status, 'write-failed')
  assert.deepEqual(failed.outcomes.map((item: { reason: string }) => item.reason), ['write-failed'])
  assert.equal(cursorOf(w.box), null)
  assert.equal(w.box.ok('page', 'ls').pages.some((page: { title: string }) => page.title === 'Bloqueada'), false)

  const db = openMemoryDatabase()
  advanceAutodocCursor(db, 's', 10, 'a')
  advanceAutodocCursor(db, 's', 4, 'b')
  assert.equal(autodocCursor(db, 's'), 10)
})

test('a session already being documented is not documented twice at once', (t) => {
  const w = world(t)
  const dir = autodocDataDir(w.box.env)
  const release = claimSession(dir, SESSION, 60_000)
  assert.ok(release)
  assert.equal(claimSession(dir, SESSION, 60_000), null)
  w.claude.answer({ result: [] })
  const busy = w.run()
  assert.equal(busy.status, 'busy')
  assert.equal(w.claude.calls(), 0)
  release()
  assert.equal(w.run().status, 'done')

  mkdirSync(dirname(sessionLockPath(dir, 'stale')), { recursive: true })
  writeFileSync(sessionLockPath(dir, 'stale'), JSON.stringify({ pid: 2 ** 22 + 7, at: 'x' }))
  const reclaimed = claimSession(dir, 'stale', 60_000)
  assert.ok(reclaimed)
  reclaimed()
})

test('the hook hands values over with "=", hashes a missing session id and keeps a private log', (t) => {
  const box = sandbox(t)
  const input = sessionEndInput({ transcript_path: '/t/x.jsonl', cwd: '-weird' }, box.env)
  assert.equal(input?.session, transcriptSessionId('/t/x.jsonl'))
  assert.match(input?.session ?? '', /^[0-9a-f]{32}$/)
  assert.deepEqual(runArguments({ transcript: '/t/x.jsonl', session: '-s', cwd: '-weird' }), ['autodoc-run', '--transcript=/t/x.jsonl', '--session=-s', '--cwd=-weird'])

  fakeClaude(box)
  const transcript = writeTranscript(box, [line({ type: 'user', message: { content: 'hola' } })])
  const result = box.ok('autodoc-run', `--transcript=${transcript}`, '--session=-dash-session', `--cwd=${box.dir}`)
  assert.equal(result.status, 'nothing-new')

  const log = join(box.dir, 'private', 'autodoc.log')
  closeSync(openLog(log))
  if (process.platform !== 'win32') assert.equal(statSync(log).mode & 0o777, 0o600)
})

test('the children get an allow-listed environment', () => {
  const env = {
    PATH: '/bin',
    HOME: '/h',
    LANG: 'es_MX.UTF-8',
    LC_ALL: 'C',
    ANTHROPIC_API_KEY: 'k',
    CLAUDE_CODE_USE_BEDROCK: '1',
    HTTPS_PROXY: 'http://p',
    INKWELL_DB_PATH: '/db',
    AWS_SECRET_ACCESS_KEY: 'no',
    GITHUB_TOKEN: 'no',
    XDG_DATA_HOME: '/x',
    KIT_REGISTRY_DIR: '/r',
  }
  const run = runEnvironment({ ...env, OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g', NVM_BIN: '/n' }, { INKWELL_AUTODOC: '1' })
  assert.ok(run['OPENAI_API_KEY'] === 'o' && run['GEMINI_API_KEY'] === 'g' && run['NVM_BIN'] === '/n' && run['ANTHROPIC_API_KEY'] === 'k')
  assert.ok(run['XDG_DATA_HOME'] === '/x' && run['KIT_REGISTRY_DIR'] === '/r')
  assert.equal(run['AWS_SECRET_ACCESS_KEY'], undefined)
  assert.equal(run['GITHUB_TOKEN'], undefined)
})

test('the redactor keeps plain prose, whole PEM keys go, and the text the model gets is not normalized', () => {
  assert.equal(redactSensitive('El token es de corta duración'), 'El token es de corta duración')
  assert.equal(redactSensitive('The password is hashed'), 'The password is hashed')
  assert.equal(redactSensitive('password: abc'), 'password: abc')
  assert.equal(redactSensitive('antes\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\nqwerty\n-----END RSA PRIVATE KEY-----\ndespués'), 'antes\n[REDACTED]\ndespués')
  assert.equal(redactSensitive('-----BEGIN PRIVATE KEY-----\nMIIE\nsin fin'), '[REDACTED]')
  assert.equal(redactSensitive('Ｆｕｌｌ\tancho ﬁ'), 'Ｆｕｌｌ\tancho ﬁ')
  assert.equal(redactSensitive('llave ＡＫＩＡＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰ'), '[REDACTED]')
  assert.equal(redactSensitive('id 1760854123450 y 4111111111111111'), 'id 1760854123450 y [REDACTED]')
  assert.equal(sensitiveContent('1760854123450'), null)
})

test('the model never gets a [REDACTED] marker back into a page', (t) => {
  const w = world(t)
  w.claude.answer({ result: [{ action: 'create', title: 'Acceso', parentId: w.rootId, markdown: 'La llave es [REDACTED].', reason: 'r' }] })
  assert.deepEqual(w.run().outcomes.map((item: { reason: string }) => item.reason), ['sensitive-content'])
})

test('afterSection adds a new H2 after an existing one, and an unknown section without it is dropped', (t) => {
  const w = world(t)
  w.claude.answer({
    result: [
      { action: 'propose', pageId: w.rootId, section: 'Seguridad', afterSection: 'Red', markdown: '## Seguridad\n\nEl WAF filtra el tráfico de entrada.', reason: 'r' },
      { action: 'propose', pageId: w.rootId, section: 'Costos', markdown: 'x', reason: 'r' },
      { action: 'propose', pageId: w.rootId, section: 'Costos', afterSection: 'Nada', markdown: 'x', reason: 'r' },
    ],
  })
  const result = w.run()
  assert.deepEqual(result.outcomes.map((item: { kind: string; reason?: string }) => item.reason ?? item.kind), ['propose', 'section-not-found', 'section-not-found'])
  const proposed = docsGit(w.box, 'show', `${result.outcomes[0].branch}:cobros/arquitectura.md`)
  assert.match(proposed, /## Red\n\nTodo pasa por el balanceador\.\n\n## Seguridad\n\nEl WAF filtra el tráfico de entrada\.\n\n## Datos/)
})

test('archived pages do not count, a parent must be active, and an empty space roots only its first page', (t) => {
  const w = world(t)
  const db = new DatabaseSync(w.box.env['INKWELL_DB_PATH'] as string)
  db.prepare("UPDATE pages SET status = 'archived' WHERE id = ?").run(w.childId)
  db.close()
  w.claude.answer({ result: [{ action: 'create', title: 'Hija de archivada', parentId: w.childId, markdown: 'x', reason: 'r' }] })
  assert.deepEqual(w.run().outcomes.map((item: { reason: string }) => item.reason), ['parent-archived'])

  const box = sandbox(t)
  const claude = fakeClaude(box)
  box.ok('space', 'add', 'Vacio', '--key', 'VAC')
  const spaceId = box.ok('space', 'show', 'VAC').id
  const archived = box.ok('page', 'new', 'Vieja', '--project', 'VAC').page.pageId
  const raw = new DatabaseSync(box.env['INKWELL_DB_PATH'] as string)
  raw.prepare("UPDATE pages SET status = 'archived' WHERE id = ?").run(archived)
  raw.close()
  fakeBitaRepo(box, 9, 'Vacio')
  linkSpace(box, spaceId, 9)
  claude.answer({ result: [] })
  const first = box.ok('autodoc-run', '--transcript', writeTranscript(box, transcriptLines()), '--session', SESSION, '--cwd', box.dir)
  assert.equal(first.status, 'done')
  const firstPage = (title: string, parentId?: number) => ({ action: 'create', title, ...(parentId === undefined ? {} : { parentId }), markdown: 'x', reason: '' })
  claude.answer({ result: [firstPage('Visión general'), firstPage('Otra raíz'), firstPage('Bajo vieja', archived)] })
  writeTranscript(box, [...transcriptLines(), ...transcriptLines(' más')])
  const result = box.ok('autodoc-run', '--transcript', join(box.dir, 'transcript.jsonl'), '--session', SESSION, '--cwd', box.dir)
  assert.deepEqual(result.outcomes.map((item: { kind: string; reason?: string }) => item.reason ?? item.kind), ['create', 'no-parent', 'parent-archived'])
  assert.equal(result.outcomes[0].parentId, null)
  const docs = box.env['INKWELL_DOCS_DIR'] as string
  assert.match(execFileSync('git', ['log', '-1', '--format=%(trailers:only,unfold)'], { cwd: docs, encoding: 'utf8', env: box.env }), /Inkwell-Reason: New page from a work session/)
})

test('a new page and its pending mark are written together or not at all', (t) => {
  const w = world(t)
  const db = new DatabaseSync(w.box.env['INKWELL_DB_PATH'] as string)
  db.exec('DROP TABLE autodoc_pending')
  db.close()
  const before = w.box.ok('page', 'ls').pages.length
  w.claude.answer({ result: [{ action: 'create', title: 'Huérfana', parentId: w.rootId, markdown: 'x', reason: 'r' }] })
  const result = w.run()
  assert.deepEqual(result.outcomes.map((item: { reason: string }) => item.reason), ['write-failed'])
  const check = new DatabaseSync(w.box.env['INKWELL_DB_PATH'] as string)
  try {
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM pages').get()?.['n'], before)
  } finally {
    check.close()
  }
})

test('a section write keeps the pending mark; only a full write or approve clears it', (t) => {
  const w = world(t)
  w.claude.answer({ result: [{ action: 'create', title: 'Cola de pagos', parentId: w.rootId, markdown: '## Qué es\n\nLa cola.', reason: 'r' }] })
  const id = w.run().outcomes[0].pageId
  const pending = () => w.box.ok('autodoc', 'ls').pending.map((item: { pageId: number }) => item.pageId)
  w.box.ok('page', 'write', String(id), '--section', 'Qué es', '--body', 'La cola guarda cada pago.')
  assert.deepEqual(pending(), [id])
  assert.equal(w.box.run(['confluence', 'publish-diagrams', String(id), '--to', '123']).json.error.code, 'AUTODOC_PENDING')
  w.box.ok('page', 'write', String(id), '--body', '# Cola de pagos\n\nLa cola guarda cada pago.')
  assert.deepEqual(pending(), [])
})

test('parseActions prefers the last array of actions and gives up on huge answers', () => {
  const one = [{ action: 'create', title: 'A' }]
  const two = [{ action: 'create', title: 'B' }]
  assert.deepEqual(parseActions(`${JSON.stringify(one)}\ny luego\n${JSON.stringify(two)}`), two)
  assert.deepEqual(parseActions(`Nota []\n${JSON.stringify(one)}\nFin [] y [ok]`), one)
  assert.deepEqual(parseActions('Nada que agregar: []'), [])
  assert.deepEqual(parseActions(`${JSON.stringify(one)}${' [x]'.repeat(60)}`), one)
  assert.equal(parseActions(`${JSON.stringify(one)}${' '.repeat(210 * 1024)}`), null)
})

test('a stale lock is set aside before it goes, and release never deletes a lock someone else owns', (t) => {
  const box = sandbox(t)
  const dir = join(box.dir, 'locks')
  const path = sessionLockPath(dir, 'stale')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 7, at: 'x' }))
  const release = claimSession(dir, 'stale', 60_000)
  assert.ok(release)
  assert.deepEqual(readdirSync(dirname(path)), [basename(path)])
  writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 9, at: 'x' }))
  release()
  assert.equal(existsSync(path), true)
})

test('a version 2 database moves to the autodoc schema in one step', (t) => {
  const box = sandbox(t)
  const path = join(box.dir, 'v2.db')
  const db = new DatabaseSync(path)
  for (const migration of MIGRATIONS.filter((item) => item.version <= 2)) for (const statement of migration.statements) db.exec(statement)
  db.exec('PRAGMA user_version = 2')
  db.close()
  const migrated = openDatabase(path)
  assert.equal(readSchemaVersion(migrated), 3)
  const tables = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'autodoc_%' ORDER BY name").all().map((row) => row['name'])
  assert.deepEqual(tables, ['autodoc_pending', 'autodoc_runs'])
  migrated.close()
  assert.deepEqual(MIGRATIONS.map((item) => item.version), [1, 2, 3])
})

test('hrefs are allow-listed after refusing entities and percent escapes', () => {
  for (const href of ['&#106;avascript:alert(1)', '&#x6A;avascript:alert(1)', 'javascript&colon;alert(1)', 'docs%2Fx', 'javascript:alert(1)', 'mailto:a@b.c', 'otra:ruta', '//evil.example']) assert.equal(safeHref(href), false, href)
  for (const href of ['https://example.com/a?b=1', 'http://example.com', '#red', '../otra.md', 'sub/pagina.md']) assert.equal(safeHref(href), true, href)
  assert.equal(unsafeMarkdown('[x](&#106;avascript:alert(1))'), 'link')
  assert.equal(unsafeMarkdown('[x](&#x6A;avascript:alert(1))'), 'link')
  assert.equal(unsafeMarkdown('[x](javascript&colon;alert(1))'), 'link')
})

test('tag-like text outside code is refused even when the lexer does not see html', () => {
  assert.equal(unsafeMarkdown('<img src=//e/?d=1>'), 'html')
  assert.equal(unsafeMarkdown('- uno <!-- x -->'), 'html')
  assert.equal(unsafeMarkdown('Usa `<img src=x>` y\n\n```\n<div>\n```\n\na < b'), null)
})

test('parseActions walks the answer once and survives brackets inside the markdown', () => {
  const links = Array.from({ length: 80 }, (_, index) => `[x${index}](y${index}.md)`).join(' ')
  const actions = [{ action: 'create', title: 'Enlaces', parentId: 1, markdown: links, reason: 'r' }]
  assert.deepEqual(parseActions(`Antes [nota] y {llave}\n${JSON.stringify(actions)}\nFin [ok]`), actions)
  assert.deepEqual(parseActions(`${JSON.stringify(actions)} ${' [x]'.repeat(200)}`), actions)
})

test('cards from more networks, with any separator, are redacted; short passwords only on the way in', () => {
  for (const card of ['3530 1113 3330 0000', '3566002020360505', '4111.1111.1111.1111', '4222222222222', '6759 6498 2643 8453']) {
    assert.equal(redactSensitive(`pago ${card} fin`), 'pago [REDACTED] fin', card)
    assert.equal(sensitiveContent(card), 'card', card)
  }
  assert.equal(redactSensitive('password: hunter2'), '[REDACTED]')
  assert.equal(sensitiveContent('password: hunter2'), null)
  assert.equal(sensitiveContent('password: hunter22'), 'credential')
})

test('a lock that comes back to life after being set aside is restored and reported busy', (t) => {
  const box = sandbox(t)
  const path = join(box.dir, 'live.lock')
  writeFileSync(path, JSON.stringify({ pid: process.pid, at: 'x' }))
  assert.equal(setAside(path, 60_000), 'busy')
  assert.equal(readFileSync(path, 'utf8'), JSON.stringify({ pid: process.pid, at: 'x' }))
  assert.deepEqual(readdirSync(box.dir).filter((name) => name.startsWith('live.lock')), ['live.lock'])
  writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 7, at: 'x' }))
  assert.equal(setAside(path, 60_000), 'removed')
  assert.equal(existsSync(path), false)
})
