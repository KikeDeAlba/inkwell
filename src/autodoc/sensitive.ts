export const REDACTED = '[REDACTED]'

const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'aws-key', pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/ },
  { name: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'github-token', pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'gitlab-token', pattern: /glpat-[A-Za-z0-9_-]{20,}/ },
  { name: 'api-key', pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'api-key', pattern: /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/ },
  { name: 'slack-token', pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'npm-token', pattern: /npm_[A-Za-z0-9]{36}/ },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'bearer', pattern: /bearer\s+[A-Za-z0-9._~+/-]{16,}=*/i },
  { name: 'basic-auth', pattern: /basic\s+[A-Za-z0-9+/]{16,}={0,2}/i },
  { name: 'uri-credentials', pattern: /[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/:@]{1,64}:[^\s/@]{1,128}@/i },
  {
    name: 'credential',
    pattern: /(?:password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key|clave|contraseña|contrasena)["']?\s*[:=]\s*\S{8,}/i,
  },
]

const CREDENTIAL_INPUT = /(?:password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key|clave|contraseña|contrasena)["']?\s*[:=]\s*\S{4,}/gi
const GLOBAL_PATTERNS = [...SECRET_PATTERNS.map(({ pattern }) => new RegExp(pattern.source, `${pattern.flags}g`)), CREDENTIAL_INPUT]
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$(?![\s\S]))/g
const INVISIBLE = /\p{Cf}+/gu
const CARD_RUN = /(?<![0-9])[0-9](?:[^\p{L}0-9]{0,5}[0-9]){12,18}(?![0-9])/gu
const CARD_PREFIX = /^(?:4|5[0-9]|6|2[2-7]|3[04-9])/
const CARD_MIN_DIGITS = 13

export function passesLuhn(digits: string): boolean {
  let sum = 0
  for (let index = 0; index < digits.length; index += 1) {
    let digit = digits.charCodeAt(digits.length - 1 - index) - 48
    if (index % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return digits.length > 0 && sum % 10 === 0
}

export function isCardNumber(candidate: string): boolean {
  const digits = candidate.replace(/[^0-9]/g, '')
  return digits.length >= CARD_MIN_DIGITS && digits.length <= 19 && CARD_PREFIX.test(digits) && passesLuhn(digits)
}

export function scanText(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '')
}

export function hasCardSequence(text: string): boolean {
  for (const match of text.matchAll(CARD_RUN)) if (isCardNumber(match[0])) return true
  return false
}

export function sensitiveContent(text: string): string | null {
  const scanned = scanText(text)
  if (hasCardSequence(scanned)) return 'card'
  return SECRET_PATTERNS.find((entry) => entry.pattern.test(scanned))?.name ?? null
}

function redactLine(line: string): string {
  let out = line.replace(CARD_RUN, (match) => (isCardNumber(match) ? REDACTED : match))
  for (const pattern of GLOBAL_PATTERNS) out = out.replace(pattern, REDACTED)
  return sensitiveContent(out) === null ? out : REDACTED
}

export function redactSensitive(text: string): string {
  return text.replace(PEM_BLOCK, REDACTED).split('\n').map(redactLine).join('\n')
}
