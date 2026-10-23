const BASE_NAMES = [
  'PATH',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LANGUAGE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CONFIG_DIR',
  'SHELL',
  'GAZE_HARVEST',
  'BITA_NO_HOOKS',
  'KIT_NO_EVENTS',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'PROGRAMDATA',
  'PROGRAMFILES',
]

const BASE_PREFIXES = ['LC_', 'NVM_', 'ANTHROPIC_', 'CLAUDE_CODE_', 'OPENAI_', 'CODEX_', 'GEMINI_', 'GOOGLE_', 'ANTIGRAVITY_', 'OPENCODE_', 'INKWELL_']

const RUN_NAMES = ['KIT_REGISTRY_DIR', 'KIT_CREDENTIALS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']

const RUN_PREFIXES = ['XDG_', 'GIT_AUTHOR_', 'GIT_COMMITTER_']

function pick(env: NodeJS.ProcessEnv, names: readonly string[], prefixes: readonly string[]): NodeJS.ProcessEnv {
  const wanted = new Set(names)
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (wanted.has(upper) || prefixes.some((prefix) => upper.startsWith(prefix))) out[key] = value
  }
  return out
}

export function runEnvironment(env: NodeJS.ProcessEnv, extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { ...pick(env, [...BASE_NAMES, ...RUN_NAMES], [...BASE_PREFIXES, ...RUN_PREFIXES]), ...extra }
}
