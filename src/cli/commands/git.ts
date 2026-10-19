import { readFile } from 'node:fs/promises'
import { requirePage, type DocPageRow } from '../../db/pages.ts'
import { withEventBatch } from '../../docs/events.ts'
import {
  assertOnBranch,
  branchCommits,
  commitDiff,
  commitDocs,
  commitInfo,
  commitPaths,
  docsStatus,
  docsSubject,
  dropBranch,
  headSha,
  initDocsRepo,
  isDocsRepo,
  listBranches,
  mergeCommitIntoMain,
  readBlob,
  requireBranch,
  requireDocsRepo,
  resolveRev,
  DOCS_SOURCES,
  trailer,
  type DocsSource,
} from '../../docs/git.ts'
import { normalizeDatabaseText, normalizeDocFiles } from '../../docs/normalize.ts'
import { recordPageDoc } from '../../docs/page-record.ts'
import { proposalSource, proposePage } from '../../docs/proposals.ts'
import { NotFoundError, UsageError } from '../../errors.ts'
import { BASE_OPTIONS, parseCommandArgs, readBoolean, readString, type ParsedArgs } from '../args.ts'
import { createLocalContext, type LocalContext } from '../context.ts'
import { successEnvelope, writeJson, writeOut } from '../output.ts'

const OPTIONS = {
  branch: { type: 'string' as const },
  md: { type: 'string' as const },
  body: { type: 'string' as const },
  section: { type: 'string' as const },
  reason: { type: 'string' as const },
  source: { type: 'string' as const },
  commit: { type: 'string' as const },
  message: { type: 'string' as const },
  all: { type: 'boolean' as const, default: false },
  'dry-run': { type: 'boolean' as const, default: false },
}

const BRANCH_ACTIONS = new Set(['ls', 'diff', 'apply', 'drop'])

export const DOCS_GIT_SUBCOMMANDS = new Set(['git', 'status', 'commit', 'propose', 'branch', 'normalize'])

export async function runGit(first: string, argv: string[]): Promise<number> {
  const head = argv[0]
  const explicit = head !== undefined && !head.startsWith('-')
  const grouped = first === 'git' || first === 'branch'
  const action = grouped ? (explicit ? head : first === 'branch' ? 'ls' : '') : null
  if (first === 'git' && action !== 'init') throw new UsageError('Usage: inkwell git <init|status|commit|normalize|propose>')
  if (first === 'branch' && (action === null || !BRANCH_ACTIONS.has(action))) {
    throw new UsageError(`Usage: inkwell branch <${[...BRANCH_ACTIONS].join('|')}>`)
  }

  const rest = grouped && explicit ? argv.slice(1) : argv
  const args = parseCommandArgs(rest, OPTIONS, BASE_OPTIONS)
  const json = readBoolean(args, 'json')
  const ctx = createLocalContext(args)

  try {
    if (first === 'git') return await runInit(ctx, json)
    if (first === 'status') return await runStatus(ctx, json)
    if (first === 'commit') return await runCommit(ctx, args, json)
    if (first === 'normalize') return await runNormalize(ctx, args, json)
    if (first === 'propose') return await runPropose(ctx, args, json)
    if (action === 'ls') return await runBranchList(ctx, json)
    if (action === 'diff') return await runBranchDiff(ctx, args, json)
    if (action === 'apply') return await runBranchApply(ctx, args, json)
    return await runBranchDrop(ctx, args, json)
  } finally {
    ctx.db.close()
  }
}

async function runInit(ctx: LocalContext, json: boolean): Promise<number> {
  const state = await initDocsRepo(ctx.docsRoot)
  if (json) {
    writeJson(successEnvelope('git init', state))
    return 0
  }
  writeOut(state.initialized ? `Started the docs history in ${state.root}.` : `${state.root} already has a history.`)
  if (state.head !== null) writeOut(`main is at ${state.head.slice(0, 7)}`)
  return 0
}

async function runStatus(ctx: LocalContext, json: boolean): Promise<number> {
  const dirty = await docsStatus(ctx.docsRoot)
  const data = { root: ctx.docsRoot, dirty }
  if (json) {
    writeJson(successEnvelope('git status', data, { repo: isDocsRepo(ctx.docsRoot) }))
    return 0
  }
  if (!isDocsRepo(ctx.docsRoot)) {
    writeOut(`${ctx.docsRoot} has no history yet. Run "inkwell git init".`)
    return 0
  }
  if (dirty.length === 0) {
    writeOut('Every document is committed.')
    return 0
  }
  for (const file of dirty) writeOut(`${file.status.padEnd(10)} ${file.path}`)
  return 0
}

async function runCommit(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  await requireDocsRepo(ctx.docsRoot)
  const named = args.positionals
  const paths = named.length > 0 ? named : (await docsStatus(ctx.docsRoot)).map((file) => file.path)
  const message = readString(args, 'message')?.trim()
  const subject = message !== undefined && message.length > 0 ? message : 'docs: record edits made outside inkwell'
  const sha = paths.length === 0 ? null : await commitPaths(ctx.docsRoot, paths, { source: 'manual', subject, reason: 'external edit' })
  const data = { sha, paths }

  if (json) {
    writeJson(successEnvelope('git commit', data, { root: ctx.docsRoot }))
    return 0
  }
  writeOut(sha === null ? 'Nothing to commit.' : `Committed ${paths.length} path${paths.length === 1 ? '' : 's'} as ${sha.slice(0, 7)}.`)
  return 0
}

async function runNormalize(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  const dryRun = readBoolean(args, 'dry-run')
  const files = await normalizeDocFiles(ctx.docsRoot, dryRun)
  const columns = normalizeDatabaseText(ctx.db, dryRun)
  const sha =
    dryRun || files.length === 0
      ? null
      : await withEventBatch(() =>
          commitDocs(ctx.docsRoot, files, { source: 'manual', subject: 'docs: normalize text to nfc', reason: 'unicode normalization' }),
        )
  const data = { dryRun, sha, files, columns }

  if (json) {
    writeJson(successEnvelope('git normalize', data, { root: ctx.docsRoot }))
    return 0
  }
  const rows = columns.reduce((total, column) => total + column.rows, 0)
  if (files.length === 0 && rows === 0) {
    writeOut('Every document and database value is already in NFC.')
    return 0
  }
  const verb = dryRun ? 'Would normalize' : 'Normalized'
  writeOut(`${verb} ${files.length} document${files.length === 1 ? '' : 's'} and ${rows} database value${rows === 1 ? '' : 's'}.`)
  for (const column of columns) writeOut(`  ${column.table}.${column.column}: ${column.rows}`)
  if (sha !== null) writeOut(`Committed as ${sha.slice(0, 7)}.`)
  return 0
}

function pageArg(ctx: LocalContext, raw: string | undefined): DocPageRow {
  const id = Number(raw)
  if (raw === undefined || !Number.isInteger(id) || id <= 0) throw new UsageError(`"${raw ?? ''}" is not a page id.`)
  return requirePage(ctx.db, id)
}

function sourceOf(value: string | undefined): DocsSource {
  return value !== undefined && (DOCS_SOURCES as readonly string[]).includes(value) ? (value as DocsSource) : 'manual'
}

async function proposalBody(args: ParsedArgs): Promise<string> {
  const file = readString(args, 'md')
  if (file !== undefined) return await readFile(file, 'utf8')
  const body = readString(args, 'body')
  if (body === undefined) throw new UsageError('Pass --md <file> or --body <text>.')
  return body
}

async function runPropose(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  const branch = readString(args, 'branch')
  if (branch === undefined) throw new UsageError('Pass --branch <name>.')
  const page = pageArg(ctx, args.positionals[0])
  const reason = readString(args, 'reason')?.trim()
  if (reason === undefined || reason.length === 0) throw new UsageError('Pass --reason "<why the page changes>".')
  const body = await proposalBody(args)
  const section = readString(args, 'section')
  const origin = proposalSource(readString(args, 'source'))

  const { sha, base } = await proposePage(ctx, page, { branch, body, section, reason, origin })

  const data = { branch, sha, pageId: page.id, path: page.relPath, base }
  if (json) {
    writeJson(successEnvelope('git propose', data, { root: ctx.docsRoot }))
    return 0
  }
  writeOut(`Proposed ${sha.slice(0, 7)} on ${branch} for #${page.id} ${page.title}.`)
  return 0
}

async function runBranchList(ctx: LocalContext, json: boolean): Promise<number> {
  const branches = await listBranches(ctx.docsRoot)
  if (json) {
    writeJson(successEnvelope('branch ls', { branches }, { root: ctx.docsRoot }))
    return 0
  }
  if (branches.length === 0) {
    writeOut('No proposal branches.')
    return 0
  }
  for (const branch of branches) {
    writeOut(`${branch.name}  ${branch.head.slice(0, 7)}  ${branch.commits.length} commit${branch.commits.length === 1 ? '' : 's'}`)
    for (const commit of branch.commits) writeOut(`  ${commit.sha.slice(0, 7)}  ${commit.subject}`)
  }
  return 0
}

function branchArg(args: ParsedArgs): string {
  const branch = args.positionals[0] ?? readString(args, 'branch')
  if (branch === undefined) throw new UsageError('Name the branch.')
  return branch
}

async function commitOnBranch(ctx: LocalContext, branch: string, raw: string): Promise<string> {
  const sha = await resolveRev(ctx.docsRoot, raw)
  await assertOnBranch(ctx.docsRoot, branch, sha)
  return sha
}

async function runBranchDiff(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  await requireDocsRepo(ctx.docsRoot)
  const branch = branchArg(args)
  await requireBranch(ctx.docsRoot, branch)
  const only = readString(args, 'commit')
  const shas = only !== undefined
    ? [await commitOnBranch(ctx, branch, only)]
    : (await branchCommits(ctx.docsRoot, branch)).map((commit) => commit.sha)

  const commits = []
  for (const sha of shas) {
    const info = await commitInfo(ctx.docsRoot, sha)
    const { path, diff, hunks } = await commitDiff(ctx.docsRoot, sha)
    commits.push({ sha, pageId: info.pageId, path, reason: trailer(info.trailers, 'Reason') ?? null, hunks, diff })
  }

  if (json) {
    writeJson(successEnvelope('branch diff', { branch, commits }, { root: ctx.docsRoot }))
    return 0
  }
  for (const commit of commits) {
    writeOut(`commit ${commit.sha}${commit.reason ? `  (${commit.reason})` : ''}`)
    process.stdout.write(commit.diff)
  }
  return 0
}

async function runBranchApply(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  await requireDocsRepo(ctx.docsRoot)
  const branch = branchArg(args)
  await requireBranch(ctx.docsRoot, branch)
  const raw = readString(args, 'commit')
  if (raw === undefined) throw new UsageError('Pass --commit <sha>.')
  const sha = await commitOnBranch(ctx, branch, raw)
  const info = await commitInfo(ctx.docsRoot, sha)
  if (info.pageId === null) throw new UsageError(`${sha.slice(0, 7)} does not name the page it changes.`)
  const page = requirePage(ctx.db, info.pageId)

  await commitDocs(ctx.docsRoot, [page.relPath], {
    source: 'manual',
    subject: docsSubject(page.relPath, 'record outside edits to', page.title),
    pageId: page.id,
    reason: 'external edit',
  })

  const tree = await mergeCommitIntoMain(ctx.docsRoot, sha)
  let merged = await readBlob(ctx.docsRoot, tree, page.relPath)
  if (merged === null) {
    const touched = (await commitDiff(ctx.docsRoot, sha)).path
    merged = touched === null ? null : await readBlob(ctx.docsRoot, tree, touched)
  }
  if (merged === null) throw new NotFoundError(`The merge left no file for page #${page.id}.`, 'PAGE_NOT_FOUND')

  const recorded = await recordPageDoc(
    ctx,
    page,
    { body: merged },
    {
      source: sourceOf(trailer(info.trailers, 'Source')),
      action: 'apply a proposal to',
      reason: trailer(info.trailers, 'Reason') ?? null,
      entryId: trailer(info.trailers, 'Entry') === undefined ? null : Number(trailer(info.trailers, 'Entry')),
      trailers: {
        'Inkwell-Proposal': sha,
        ...(trailer(info.trailers, 'Session') !== undefined ? { 'Inkwell-Session': trailer(info.trailers, 'Session') as string } : {}),
      },
    },
  )
  const appliedSha = recorded.sha ?? (await headSha(ctx.docsRoot))
  const data = { branch, sha, appliedSha, pageId: page.id, path: page.relPath }

  if (json) {
    writeJson(successEnvelope('branch apply', data, { root: ctx.docsRoot, changed: recorded.changed }))
    return 0
  }
  writeOut(recorded.changed ? `Applied ${sha.slice(0, 7)} to main as ${appliedSha?.slice(0, 7) ?? '?'}.` : 'main already had that change.')
  return 0
}

async function runBranchDrop(ctx: LocalContext, args: ParsedArgs, json: boolean): Promise<number> {
  await requireDocsRepo(ctx.docsRoot)
  const branch = branchArg(args)
  await dropBranch(ctx.docsRoot, branch)
  if (json) {
    writeJson(successEnvelope('branch drop', { branch, dropped: true }, { root: ctx.docsRoot }))
    return 0
  }
  writeOut(`Dropped ${branch}.`)
  return 0
}
