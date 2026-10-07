// Pure builders for the pane: what each tab shows, from the redacted view.json
// render.mjs writes. No `$` here, so every function is testable on its own.
import type { PluginState } from 'claude-code'

export type View = NonNullable<PluginState['ccworklog']['view']>
type Session = View['activity']['sessions'][number]
type Thread = View['threads']['open'][number]

const DAY_MS = 86_400_000

/** One color per workstream, in report order, carried across every tab. */
export const PALETTE = ['#D97757', '#5B8DEF', '#3FB68B', '#B07FE0', '#E0B341', '#4CB8C4', '#E06C9F'] as const
const NEUTRAL = '#7A8599'

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** "repo@HEAD" and "repo@-" say no more than "repo"; "repo@branch" reads "repo · branch". */
export const wsName = (ws: string): string => {
  const [project, branch] = ws.split('@')
  return !branch || branch === 'HEAD' || branch === '-' ? (project ?? ws) : `${project} · ${branch}`
}

const workstreams = (v: View): string[] => {
  const names = [...v.personal.map(p => p.workstream), ...v.standup.map(s => s.workstream)]
  return [...new Set(names)]
}

export const colorOf = (v: View, ws: string): string => {
  const at = workstreams(v).indexOf(ws)
  return at === -1 ? NEUTRAL : (PALETTE[at % PALETTE.length] as string)
}

/** Each project's color: the color of the first workstream it belongs to. */
export const projectColors = (v: View): Map<string, string> => {
  const colors = new Map<string, string>()
  for (const ws of workstreams(v)) {
    const project = v.standup.find(s => s.workstream === ws)?.project ?? ws.split('@')[0] ?? ws
    if (!colors.has(project)) colors.set(project, colorOf(v, ws))
  }
  // Projects with sessions but no workstream (nothing digested) still get a color of their own.
  for (const s of v.activity.sessions) {
    if (s.project && !colors.has(s.project)) colors.set(s.project, PALETTE[colors.size % PALETTE.length] as string)
  }
  return colors
}

const countCommits = (v: View): number => {
  const lines = [...v.personal.flatMap(p => p.commits ?? []), ...v.alsoShipped.flatMap(a => a.commits ?? [])]
  return lines.reduce((sum, line) => {
    const more = line.match(/^\+(\d+) more$/)
    return sum + (more ? Number(more[1]) : 1)
  }, 0)
}

/** Local minutes since midnight of `day` (YYYY-MM-DD), clamped to that day. */
const minuteOfDay = (ts: string, day: string): number => {
  const [y, m, d] = day.split('-').map(Number)
  const start = new Date(y as number, (m as number) - 1, d as number).getTime()
  return Math.min(1440, Math.max(0, (Date.parse(ts) - start) / 60_000))
}

const spanMinutes = (s: Session): number =>
  s.firstTs && s.lastTs ? minuteOfDay(s.lastTs, s.day) - minuteOfDay(s.firstTs, s.day) : 0

export const formatDuration = (minutes: number): string => {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return h === 0 ? `${m}m` : `${h}h${String(m).padStart(2, '0')}m`
}

export type Tile = { value: string; label: string }

export const statTiles = (v: View): Tile[] => {
  const sessions = v.activity.sessions.length
  const commits = countCommits(v)
  const threads = v.threads.open.length
  return [
    { value: String(sessions), label: sessions === 1 ? 'session' : 'sessions' },
    { value: formatDuration(v.activity.sessions.reduce((sum, s) => sum + spanMinutes(s), 0)), label: 'active' },
    { value: String(commits), label: commits === 1 ? 'commit' : 'commits' },
    { value: String(v.personal.length), label: v.personal.length === 1 ? 'workstream' : 'workstreams' },
    { value: String(threads), label: threads === 1 ? 'open thread' : 'open threads' },
  ]
}

export const daysBetween = (from: string, to: string): number =>
  Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS))

/** A thread's age badge: what it says and how loud it is. */
export const age = (t: Thread, today: string): { text: string; color: 'success' | 'warning' | 'error' } => {
  const days = t.firstSeen ? daysBetween(t.firstSeen, today) : 0
  return days === 0 ? { text: 'new', color: 'success' }
    : { text: `${days}d`, color: days <= 3 ? 'warning' : 'error' }
}

/** A redaction marker in place of a path: drawn dim rather than as a path. */
export const isRedacted = (text: string): boolean => /\[REDACTED:/.test(text)

/** The project active in each of `slots` equal slices of `day`, local time; null where idle. */
export const slotProjects = (sessions: readonly Session[], day: string, slots: number): (string | null)[] => {
  const cells: (string | null)[] = Array.from({ length: slots }, () => null)
  const width = 1440 / slots
  for (const s of sessions) {
    if (s.day !== day || !s.firstTs || !s.lastTs) continue
    const from = Math.floor(minuteOfDay(s.firstTs, day) / width)
    const to = Math.min(slots - 1, Math.floor(minuteOfDay(s.lastTs, day) / width))
    for (let i = from; i <= to; i++) cells[i] = s.project ?? '?'
  }
  return cells
}

const hex = (color: string): number => Number.parseInt(color.slice(1), 16)
const DEFAULT = 0x01000000
const IDLE = 0x4a4a4a

/** One Raster row: a block per busy slot in its project's color, a dot where idle. */
export const stripCells = (slots: readonly (string | null)[], colors: ReadonlyMap<string, string>): string => {
  const words = new Uint32Array(slots.length * 3)
  slots.forEach((project, i) => {
    words[i * 3] = project === null ? 0x00b7 : 0x2588
    words[i * 3 + 1] = project === null ? IDLE : hex(colors.get(project) ?? NEUTRAL)
    words[i * 3 + 2] = DEFAULT
  })
  // toBase64 is in the hooks environment, ahead of TypeScript's es2023 lib.
  return (new Uint8Array(words.buffer) as Uint8Array & { toBase64(): string }).toBase64()
}

/** The hour ruler under the strips: 00, 06, 12, 18 placed at their slots. */
export const ruler = (slots: number): string => {
  const chars = Array.from({ length: slots }, () => ' ')
  for (const hour of [0, 6, 12, 18]) {
    const at = Math.round((hour / 24) * slots)
    String(hour).padStart(2, '0').split('').forEach((c, i) => {
      if (at + i < slots) chars[at + i] = c
    })
  }
  return chars.join('')
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const parts = (day: string) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return { y, m, d, weekday: WEEKDAYS[new Date(y, m - 1, d).getDay()] as string }
}

export const dayLabel = (day: string): string => {
  const { d, weekday } = parts(day)
  return `${weekday} ${String(d).padStart(2, '0')}`
}

const longDate = (day: string): string => {
  const { y, m, d, weekday } = parts(day)
  return `${weekday} ${d} ${MONTHS[m - 1]} ${y}`
}

/** "Wed 7 Oct 2026", or "Mon 6 Oct 2026 – Sun 12 Oct 2026" for a range. */
export const prettyRange = (days: readonly string[], fallback: string): string => {
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) return fallback
  return first === last ? longDate(first) : `${longDate(first)} – ${longDate(last)}`
}

export const daySummary = (v: View, day: string): string => {
  const sessions = v.activity.sessions.filter(s => s.day === day)
  if (sessions.length === 0) return 'quiet'
  const minutes = sessions.reduce((sum, s) => sum + spanMinutes(s), 0)
  return `${plural(sessions.length, 'session')} · ${formatDuration(minutes)}`
}

/** A progress bar's two halves, so the filled part can take a color of its own. */
export const bar = (done: number, total: number, width: number): { filled: string; empty: string } => {
  const n = total === 0 ? width : Math.round((done / total) * width)
  return { filled: '━'.repeat(n), empty: '━'.repeat(Math.max(0, width - n)) }
}

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
