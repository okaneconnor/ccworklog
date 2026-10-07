// The /worklog pipeline, run by the mod in code rather than by the model
// following SKILL.md: collect → digest (≤4 at once) → premerge → reduce →
// render. Everything outside this file comes in through `Deps`, so tests can
// drive it without a session.
import type { PluginState } from 'claude-code'

import {
  DIGEST_MODEL, DIGEST_SYSTEM, REDUCE_MODEL, REDUCE_SYSTEM, digestPrompt, reducePrompt,
} from './prompts'

export type Run = PluginState['ccworklog']['run']

export type Deps = {
  /** Runs one of skills/worklog/scripts/*.mjs with node. */
  node: (script: string, args: readonly string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>
  read: (path: string) => Promise<string | null>
  complete: (model: string, system: string, prompt: string, maxTokens: number) => Promise<string | null>
  progress: (patch: Partial<Run>) => Promise<void>
  confirm: (sessions: number) => Promise<boolean>
}

export type Outcome =
  | { kind: 'done'; viewPath: string }
  | { kind: 'empty'; message: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'error'; message: string }

type Pack = { sessionId: string; packPath: string; digestPath: string; digestValid: boolean; trivial: boolean }
type Manifest = {
  label: string
  empty: boolean
  packs: Pack[]
  git: unknown[]
  parseHealth: unknown
  dataDir: string
}

export const COLD_RUN_LIMIT = 15
const CONCURRENCY = 4

export const parseArgs = (args: string): { isPurge: boolean; range: string; isFresh: boolean } => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const isPurge = words[0] === 'purge'
  const rest = isPurge ? words.slice(1) : words
  return {
    isPurge,
    range: rest.find(w => !w.startsWith('--')) ?? 'today',
    isFresh: rest.includes('--fresh'),
  }
}

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? ''

const json = <T>(stdout: string): T | null => {
  try {
    return JSON.parse(stdout) as T
  } catch {
    return null
  }
}

/** Runs `work` over `items` with at most `limit` in flight. */
export const pool = async <T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> => {
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++] as T)
  })
  await Promise.all(lanes)
}

const digestOnce = async (pack: Pack, d: Deps): Promise<boolean> => {
  const text = await d.read(pack.packPath)
  if (text === null) return false
  const reply = await d.complete(DIGEST_MODEL, DIGEST_SYSTEM, digestPrompt(text), 4096)
  if (reply === null) return false
  const saved = await d.node('save.mjs', ['digest', pack.packPath, pack.digestPath], reply)
  return saved.code === 0
}

/** One retry, as the skill does; a pack that fails twice is reported, never dropped silently. */
const digest = async (pack: Pack, d: Deps): Promise<boolean> =>
  (await digestOnce(pack, d)) || (await digestOnce(pack, d))

export const purge = async (range: string, d: Deps): Promise<string> => {
  const r = await d.node('collect.mjs', ['purge', range])
  const out = json<{ removed: string[] }>(r.stdout)
  if (r.code !== 0 || out === null) return `Purge failed: ${firstLine(r.stderr)}`
  return out.removed.length === 0 ? `Nothing stored for ${range}.` : `Removed ${out.removed.length} stored file(s) for ${range}.`
}

export const runWorklog = async (range: string, isFresh: boolean, d: Deps): Promise<Outcome> => {
  await d.progress({ phase: 'collecting' })
  const collected = await d.node('collect.mjs', ['collect', range])
  const m = json<Manifest>(collected.stdout)
  if (collected.code !== 0 || m === null) {
    return { kind: 'error', message: `Collect failed: ${firstLine(collected.stderr) || 'no output'}` }
  }
  await d.progress({ label: m.label, sessions: m.packs.length, commits: m.git.length })

  if (m.empty) {
    const threads = json<{ open?: { firstSeen?: string }[] }>((await d.read(`${m.dataDir}/threads.json`)) ?? '')
    const open = threads?.open ?? []
    const oldest = open.map(t => t.firstSeen ?? '').filter(Boolean).sort()[0]
    const tail = open.length > 0 ? ` Open threads: ${open.length}${oldest ? ` (oldest since ${oldest})` : ''}.` : ''
    return { kind: 'empty', message: `No Claude Code activity or commits for ${m.label}.${tail}` }
  }

  const todo = m.packs.filter(p => !p.digestValid && !p.trivial)
  if (todo.length > COLD_RUN_LIMIT) {
    await d.progress({ phase: 'confirm', total: todo.length })
    if (!(await d.confirm(todo.length))) {
      return { kind: 'cancelled', message: `Cancelled. Try a smaller range, such as /worklog today.` }
    }
  }

  const missed: string[] = []
  let done = 0
  await d.progress({ phase: 'digesting', done, total: todo.length })
  await pool(todo, CONCURRENCY, async pack => {
    if (!(await digest(pack, d))) missed.push(pack.sessionId)
    done += 1
    await d.progress({ done, missed: [...missed] })
  })

  await d.progress({ phase: 'merging' })
  const premerge = async () => {
    const r = await d.node('collect.mjs', ['premerge', range])
    return r.code === 0 ? json<{ reduceInputPath: string; inputHash: string; invalidDigests: { digestPath: string }[] }>(r.stdout) : null
  }
  let pm = await premerge()
  if (pm === null) return { kind: 'error', message: 'Premerge failed.' }
  if (pm.invalidDigests.length > 0) {
    const redo = m.packs.filter(p => pm?.invalidDigests.some(i => i.digestPath === p.digestPath))
    await pool(redo, CONCURRENCY, async pack => {
      if (!(await digestOnce(pack, d)) && !missed.includes(pack.sessionId)) missed.push(pack.sessionId)
    })
    pm = await premerge()
    if (pm === null) return { kind: 'error', message: 'Premerge failed.' }
  }

  const reportPath = `${m.dataDir}/reports/${m.label}.report.json`
  const cached = json<{ inputHash?: string; promptVersion?: string }>((await d.read(reportPath)) ?? '')
  const isCached = !isFresh && cached?.inputHash === pm.inputHash && cached?.promptVersion === 'v1'

  if (!isCached) {
    await d.progress({ phase: 'reducing', missed: [...missed] })
    const reduceInput = json<Record<string, unknown>>((await d.read(pm.reduceInputPath)) ?? '')
    if (reduceInput === null) return { kind: 'error', message: 'Could not read the reduce input.' }
    // The activity appendix is deterministic data render.mjs reads itself; the model never sees it.
    const { activity: _activity, ...forModel } = reduceInput
    const prompt = reducePrompt({
      reduceInput: JSON.stringify(forModel),
      threads: (await d.read(`${m.dataDir}/threads.json`)) ?? '{"open":[]}',
      parseHealth: JSON.stringify(m.parseHealth),
      missed,
    })
    let isSaved = false
    for (let attempt = 0; attempt < 2 && !isSaved; attempt++) {
      const reply = await d.complete(REDUCE_MODEL, REDUCE_SYSTEM, prompt, 16000)
      if (reply !== null) isSaved = (await d.node('save.mjs', ['report', reportPath, pm.inputHash], reply)).code === 0
    }
    if (!isSaved) return { kind: 'error', message: 'The reduce step did not return a valid report. Try /worklog again.' }
  }

  await d.progress({ phase: 'rendering', isCached })
  const rendered = await d.node('render.mjs', isCached ? [reportPath] : [reportPath, '--update-threads'])
  if (rendered.code !== 0) return { kind: 'error', message: `Render failed: ${firstLine(rendered.stderr)}` }

  return { kind: 'done', viewPath: reportPath.replace(/\.report\.json$/, '.view.json') }
}
