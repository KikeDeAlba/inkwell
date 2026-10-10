import { ConflictError, NotFoundError, UsageError, MergeConflictError, exitCodeOf } from '../errors.ts'
import { VERSION } from '../version.ts'
import { errorEnvelope, writeErr, writeJson, writeOut } from './output.ts'

const GIT_ACTIONS = new Set(['init', 'status', 'commit', 'normalize', 'propose'])

export const HELP = `inkwell ${VERSION} — living technical documentation

Pages:
  inkwell tree [--all] [--months]                        spaces with their page trees
  inkwell ls [--project X] [--limit N] [--offset N]      pages, last edited first
  inkwell show <pageId> | --path <relPath>               same as page show
  inkwell search "<text>" [--project X] [--section H2]
  inkwell page ls [--project X] [--tree] [--entry ID]
  inkwell page show <pageId> [--rev SHA] [--no-markdown]
  inkwell page new "<title>" [--project X] [--parent ID] [--slug S] [--from-entry ID]
  inkwell page write <pageId> --md FILE | --body TEXT [--section "<H2>"]
  inkwell page rename <pageId> "<title>" | move <pageId> [--parent ID|-] [--project X]
  inkwell page link <pageId> --entry IDS | --issue KEY [--role R --summary S --status S --status-category C] | --from-entries
  inkwell page unlink <pageId> --entry IDS | --issue KEY
  inkwell page ref add|ls|rm <pageId> [--url U --title T --kind confluence|jira|drive|link]
  inkwell page asset path <pageId> <file> [--create]
  inkwell page rm <pageId> [--recursive]
  inkwell page history <pageId> [--limit N] | diff <pageId> [SHA] | restore <pageId> <SHA>

Entry notes (one markdown note per bita entry):
  inkwell note path <entryId> [--create] | --draft
  inkwell note show <entryId> | --path <relPath> [--no-markdown]
  inkwell note get <entryId> [--raw]
  inkwell note save <entryId> [--section "<H2>"] [--md FILE|-] [--note-md FILE|-] [--file F --command C --resource R]
  inkwell note ls <entryId> | ls [today|yesterday|week|last-week|month|last-month] [--from D --to D] [--project X] [--limit N]
  inkwell note search "<text>" [--project X] [--section H2]
  --entry <id> works in place of the positional id.

Spaces:
  inkwell space ls [--all] | show <space>
  inkwell space add <name> [--key K] [--confluence <url|KEY>] [--site <url>] [--pull on|off] [--push on|off]
  inkwell space set <space> [--name N] [--key K] [--active on|off] [--confluence <url|KEY>|none] [--site <url>|none] [--pull on|off] [--push on|off]
  --project (or --space) takes a name, a key, an id or a migrated bita project id.

Backlog:
  inkwell backlog ls [--project X] [--page ID] [--kind pending|finding] [--status open|resolved|all]
  inkwell backlog add --kind pending|finding --title "..." [--md FILE|--body TEXT] [--project X|--page ID|--entry ID]
  inkwell backlog resolve <KEY> [--resolution "..."] | reopen <KEY> | edit <KEY> [...] | rm <KEY>
  inkwell backlog extract [--page ID|--project X] [--dry-run]

History and proposals:
  inkwell git init | status | commit [paths] [--message M] | normalize [--dry-run]
  inkwell git propose <pageId> --branch B --reason "..." --md FILE|--body TEXT [--section H2] [--source meeting:<entryId>]
  inkwell branch ls | diff <branch> [--commit SHA] | apply <branch> --commit SHA | drop <branch>

Diagrams and export:
  inkwell diagrams ls|render <pageId> [--force]
  inkwell export page <pageId> [--out FILE.pdf] [--html FILE.html]
  inkwell export meeting --bita-entry <entryId> [--out FILE.pdf]

Confluence (through atl):
  inkwell confluence sync <space>|--all [--dry-run] | status <space> [--offline]
  inkwell confluence conflict ls [space] | resolve <pageId> --keep local|remote|both
  inkwell confluence publish-diagrams <pageId> --to <confluencePageId>

Setup:
  inkwell setup [--agents detected|all|claude,opencode,codex,gemini] [--no-agents] [--no-drawio]
  inkwell uninstall
  inkwell migrate --from-bita [--dry-run] [--bita-db PATH] [--bita-docs DIR] | migrate status
  inkwell migrate notes --from-bita [--dry-run] [--bita-db PATH] [--bita-docs DIR]
  inkwell config get | set <timezone|site> <value>
  inkwell capabilities [--json]

Every command takes --json. Data lives in INKWELL_DB_PATH and INKWELL_DOCS_DIR (default ${'~/.local/share/inkwell'}, %LOCALAPPDATA%\\inkwell on Windows).`

function commandName(argv: readonly string[]): string {
  const words: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('-')) break
    words.push(arg)
    if (words.length >= 3) break
  }
  const first = words[0]
  if (first === undefined) return 'help'
  if (['page', 'backlog', 'space', 'diagrams', 'branch', 'git', 'confluence', 'export', 'migrate', 'config', 'note'].includes(first) && words[1] !== undefined) {
    if (first === 'page' && words[1] === 'ref' && words[2] !== undefined) return `page ref ${words[2]}`
    if (first === 'confluence' && words[1] === 'conflict' && words[2] !== undefined) return `confluence conflict ${words[2]}`
    if (first === 'page' && words[1] === 'asset') return 'page asset path'
    if (first === 'note' && !['path', 'save', 'set', 'get', 'show', 'ls', 'search'].includes(words[1])) return 'note get'
    return `${first} ${words[1]}`
  }
  return first
}

async function dispatch(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      writeOut(HELP)
      return 0
    case '--version':
    case '-v':
    case 'version':
      writeOut(VERSION)
      return 0
    case 'capabilities':
      return (await import('./commands/admin.ts')).runCapabilities(rest)
    case 'tree':
    case 'ls':
    case 'show':
    case 'search':
      return (await import('./commands/docs.ts')).runDocs(command, rest)
    case 'note':
      return (await import('./commands/note.ts')).runNote(rest)
    case 'page':
      return (await import('./commands/page.ts')).runPage(rest)
    case 'space':
    case 'spaces':
      return (await import('./commands/space.ts')).runSpace(rest)
    case 'backlog':
      return (await import('./commands/backlog.ts')).runBacklog(rest)
    case 'git': {
      const action = rest[0]
      if (action === undefined || !GIT_ACTIONS.has(action)) throw new UsageError('Usage: inkwell git <init|status|commit|normalize|propose>')
      const { runGit } = await import('./commands/git.ts')
      return action === 'init' ? runGit('git', rest) : runGit(action, rest.slice(1))
    }
    case 'status':
    case 'commit':
    case 'normalize':
    case 'propose':
      return (await import('./commands/git.ts')).runGit(command, rest)
    case 'branch':
      return (await import('./commands/git.ts')).runGit('branch', rest)
    case 'diagrams':
      return (await import('./commands/diagrams.ts')).runDiagrams(rest)
    case 'confluence':
      return (await import('./commands/confluence.ts')).runConfluence(rest)
    case 'export':
      return (await import('./commands/export.ts')).runExport(rest)
    case 'migrate':
      return (await import('./commands/admin.ts')).runMigrate(rest)
    case 'setup':
      return (await import('./commands/admin.ts')).runSetup(rest)
    case 'uninstall':
      return (await import('./commands/admin.ts')).runUninstall(rest)
    case 'config':
      return (await import('./commands/admin.ts')).runConfig(rest)
    case 'bita-hook':
      return (await import('./commands/hook.ts')).runBitaHook(rest)
    default:
      throw new UsageError(`Unknown command "${command}".`, 'Run "inkwell help" for the list.')
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const json = argv.includes('--json')
  const command = commandName(argv)
  try {
    return await dispatch([...argv])
  } catch (error) {
    const known = error instanceof UsageError || error instanceof NotFoundError || error instanceof ConflictError
    const code = known ? error.code : ((error as { code?: unknown }).code as string | undefined) ?? 'UNEXPECTED'
    const message = error instanceof Error ? error.message : String(error)
    const hint = known ? error.hint : (error as { hint?: unknown }).hint
    const paths = error instanceof MergeConflictError ? error.paths : undefined
    if (json) {
      writeJson(errorEnvelope(command, { code: typeof code === 'string' ? code : 'UNEXPECTED', message, ...(typeof hint === 'string' ? { hint } : {}), ...(paths ? { paths } : {}) }))
    } else {
      writeErr(`Error: ${message}`)
      if (typeof hint === 'string') writeErr(hint)
      if (!known && process.env['INKWELL_DEBUG'] && error instanceof Error && error.stack) writeErr(error.stack)
    }
    return exitCodeOf(error)
  }
}
