export const DOC_SCHEMA_VERSION = 1

export const PAGE_SPLIT_SECTIONS = 6

export const PAGE_SPLIT_BYTES = 12 * 1024

export const DOC_LOCK_TIMEOUT_MS = 2_000
export const DOC_LOCK_STALE_MS = 30_000

export const DOCS_GIT_LOCK_TIMEOUT_MS = 5_000
export const DOCS_GIT_LOCK_STALE_MS = 60_000

export const MEETING_KINDS: readonly string[] = ['meeting', 'remote-meeting', 'in-person-meeting']

export const ENTRY_NOTE_SECTIONS: readonly string[] = [
  'Contexto',
  'Qué se hizo',
  'Decisiones',
  'Hallazgos',
  'Verificación',
  'Pendiente',
  'Tocado',
]

export const ENTRY_NOTE_SECTIONS_REQUIRED: readonly string[] = ['Contexto', 'Qué se hizo', 'Pendiente']
