const dayFormatters = new Map<string, Intl.DateTimeFormat>()
const partFormatters = new Map<string, Intl.DateTimeFormat>()

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    dayFormatters.set(timeZone, formatter)
  }
  return formatter
}

function partFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    partFormatters.set(timeZone, formatter)
  }
  return formatter
}

export function localDay(instant: Date | string, timeZone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant
  return dayFormatter(timeZone).format(date)
}

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function localParts(date: Date, timeZone: string): LocalParts {
  const parts = partFormatter(timeZone).formatToParts(date)
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type)
    return found ? Number(found.value) : 0
  }
  const hour = read('hour')
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    second: read('second'),
  }
}

export function offsetMinutes(instant: Date | string, timeZone: string): number {
  const date = typeof instant === 'string' ? new Date(instant) : instant
  const parts = localParts(date, timeZone)
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000)
}

function pad(value: number, width = 2): string {
  return String(Math.abs(value)).padStart(width, '0')
}

function formatOffset(totalMinutes: number, separator: string): string {
  const sign = totalMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(totalMinutes)
  return `${sign}${pad(Math.floor(absolute / 60))}${separator}${pad(absolute % 60)}`
}

export function toLocalIso(instant: Date | string, timeZone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant
  const parts = localParts(date, timeZone)
  const offset = offsetMinutes(date, timeZone)
  return (
    `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}` +
    `T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}` +
    formatOffset(offset, ':')
  )
}

export function toJiraStarted(instant: Date | string, timeZone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant
  const parts = localParts(date, timeZone)
  const offset = offsetMinutes(date, timeZone)
  const milliseconds = pad(date.getMilliseconds(), 3)
  return (
    `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}` +
    `T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${milliseconds}` +
    formatOffset(offset, '')
  )
}

export function addDays(isoDay: string, delta: number): string {
  const [year, month, day] = isoDay.split('-').map(Number)
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1))
  date.setUTCDate(date.getUTCDate() + delta)
  return date.toISOString().slice(0, 10)
}

export function isValidIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === (month ?? 1) - 1 &&
    date.getUTCDate() === day
  )
}

export function weekdayIndex(isoDay: string): number {
  const [year, month, day] = isoDay.split('-').map(Number)
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay()
}
