import { expect, test } from 'claude-code/testing'

import { COLD_RUN_LIMIT, parseArgs, pool, runWorklog } from './pipeline'
import type { Deps, Run } from './pipeline'

type Call = { script: string; args: readonly string[]; stdin?: string }

const pack = (id: string, over: Record<string, unknown> = {}) => ({
  sessionId: id, packPath: `/d/evidence/${id}.json`, digestPath: `/d/digests/${id}.json`,
  digestValid: false, trivial: false, ...over,
})

const manifest = (packs: unknown[], over: Record<string, unknown> = {}) => ({
  label: '2026-10-07', empty: false, packs, git: [{}, {}], parseHealth: { skippedLines: 0 }, dataDir: '/d', ...over,
})

/** A fake world: scripts answer from `script`, files from `files`, the model from `reply`. */
const world = (opts: {
  manifest: unknown
  files?: Record<string, string>
  reply?: (model: string) => string | null
  saveCode?: (args: readonly string[]) => number
  confirm?: boolean
}) => {
  const calls: Call[] = []
  const models: string[] = []
  const progress: Partial<Run>[] = []
  const files: Record<string, string> = {
    '/d/reports/2026-10-07.reduce-input.json': JSON.stringify({ workstreams: [], activity: { sessions: [1] } }),
    ...opts.files,
  }
  const deps: Deps = {
    node: async (script, args, stdin) => {
      calls.push({ script, args, stdin })
      if (script === 'collect.mjs' && args[0] === 'collect') return { code: 0, stdout: JSON.stringify(opts.manifest), stderr: '' }
      if (script === 'collect.mjs' && args[0] === 'premerge') {
        return { code: 0, stdout: JSON.stringify({ reduceInputPath: '/d/reports/2026-10-07.reduce-input.json', inputHash: 'h1', invalidDigests: [] }), stderr: '' }
      }
      if (script === 'save.mjs') return { code: opts.saveCode?.(args) ?? 0, stdout: '{}', stderr: '' }
      return { code: 0, stdout: 'recap', stderr: '' }
    },
    read: async path => files[path] ?? (path.startsWith('/d/evidence/') ? '{"prompts":[]}' : null),
    complete: async (model, _system, prompt) => {
      models.push(model)
      return opts.reply ? opts.reply(model) : model === 'haiku' ? '{"items":[]}' : `{"days":["2026-10-07"],"seen":${JSON.stringify(prompt.includes('activity'))}}`
    },
    progress: async patch => {
      progress.push(patch)
    },
    confirm: async () => opts.confirm ?? true,
  }
  return { deps, calls, models, progress }
}

test('parseArgs reads the range, --fresh and purge', () => {
  expect(parseArgs('')).toEqual({ isPurge: false, range: 'today', isFresh: false })
  expect(parseArgs('week --fresh')).toEqual({ isPurge: false, range: 'week', isFresh: true })
  expect(parseArgs('purge 2026-07-15')).toEqual({ isPurge: true, range: '2026-07-15', isFresh: false })
})

test('pool never runs more than its limit at once', async () => {
  let live = 0
  let peak = 0
  await pool([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async () => {
    live += 1
    peak = Math.max(peak, live)
    await Promise.resolve()
    live -= 1
  })
  expect(peak).toBe(4)
})

test('a fresh day digests non-trivial packs on haiku, reduces on sonnet, renders with --update-threads', async () => {
  const w = world({ manifest: manifest([pack('a'), pack('b', { trivial: true }), pack('c', { digestValid: true })]) })
  const out = await runWorklog('today', false, w.deps)
  expect(out).toEqual({ kind: 'done', viewPath: '/d/reports/2026-10-07.view.json' })
  expect(w.models).toEqual(['haiku', 'sonnet'])
  const saves = w.calls.filter(c => c.script === 'save.mjs')
  expect(saves.map(c => c.args[0])).toEqual(['digest', 'report'])
  expect(saves[1]?.args).toEqual(['report', '/d/reports/2026-10-07.report.json', 'h1'])
  const render = w.calls.find(c => c.script === 'render.mjs')
  expect(render?.args).toEqual(['/d/reports/2026-10-07.report.json', '--update-threads'])
})

test('the reduce prompt never carries the activity appendix', async () => {
  let reducePrompt = ''
  const w = world({ manifest: manifest([pack('a')]) })
  const complete = w.deps.complete
  w.deps.complete = async (model, system, prompt, max) => {
    if (model === 'sonnet') reducePrompt = prompt
    return complete(model, system, prompt, max)
  }
  await runWorklog('today', false, w.deps)
  expect(reducePrompt.includes('"workstreams"')).toBe(true)
  expect(reducePrompt.includes('"activity"')).toBe(false)
})

test('a cached report skips the reduce and renders without touching threads', async () => {
  const w = world({
    manifest: manifest([pack('a', { digestValid: true })]),
    files: { '/d/reports/2026-10-07.report.json': JSON.stringify({ inputHash: 'h1', promptVersion: 'v1' }) },
  })
  await runWorklog('today', false, w.deps)
  expect(w.models).toEqual([])
  expect(w.calls.find(c => c.script === 'render.mjs')?.args).toEqual(['/d/reports/2026-10-07.report.json'])
})

test('--fresh reduces even when the report is cached', async () => {
  const w = world({
    manifest: manifest([pack('a', { digestValid: true })]),
    files: { '/d/reports/2026-10-07.report.json': JSON.stringify({ inputHash: 'h1', promptVersion: 'v1' }) },
  })
  await runWorklog('today', true, w.deps)
  expect(w.models).toEqual(['sonnet'])
})

test('a pack that fails twice is retried once and then named as missed', async () => {
  const w = world({ manifest: manifest([pack('a'), pack('b')]), saveCode: args => (args[1]?.includes('/b.json') ? 1 : 0) })
  await runWorklog('today', false, w.deps)
  const bSaves = w.calls.filter(c => c.script === 'save.mjs' && c.args[1]?.includes('/b.json'))
  expect(bSaves.length).toBe(2)
  expect(w.progress.some(p => p.missed?.includes('b'))).toBe(true)
  expect(w.progress.some(p => p.missed?.includes('a'))).toBe(false)
})

test('a large backfill asks first and stops on cancel', async () => {
  const packs = Array.from({ length: COLD_RUN_LIMIT + 1 }, (_, i) => pack(`p${i}`))
  const w = world({ manifest: manifest(packs), confirm: false })
  const out = await runWorklog('lastweek', false, w.deps)
  expect(out.kind).toBe('cancelled')
  expect(w.progress.some(p => p.phase === 'confirm' && p.total === COLD_RUN_LIMIT + 1)).toBe(true)
  expect(w.models).toEqual([])
})

test('an empty range says so and counts open threads', async () => {
  const w = world({
    manifest: manifest([], { empty: true, git: [] }),
    files: { '/d/threads.json': JSON.stringify({ open: [{ firstSeen: '2026-10-03' }, { firstSeen: '2026-10-01' }] }) },
  })
  const out = await runWorklog('today', false, w.deps)
  expect(out).toEqual({ kind: 'empty', message: 'No Claude Code activity or commits for 2026-10-07. Open threads: 2 (oldest since 2026-10-01).' })
})

test('a reduce that never yields a valid report is an error, not a crash', async () => {
  const w = world({ manifest: manifest([pack('a', { digestValid: true })]), reply: () => null })
  const out = await runWorklog('today', false, w.deps)
  expect(out.kind).toBe('error')
  expect(w.calls.some(c => c.script === 'render.mjs')).toBe(false)
})
