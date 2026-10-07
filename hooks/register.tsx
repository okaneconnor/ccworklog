// ccworklog as a mod: /worklog runs the pipeline in code and draws the report
// in a pane beside the transcript. Where no pane can be placed, /worklog falls
// through to the skill (skills/worklog/SKILL.md), which works without mods.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginState, Register } from 'claude-code'

import { parseArgs, purge, runWorklog } from './pipeline'
import type { Deps, Run } from './pipeline'
import { Banner, LogTab, StandupTab, ThreadsTab, TimelineTab, Tiles } from './tabs'
import type { Kit } from './tabs'
import { SPINNER, bar, prettyRange, wsName } from './view'
import type { View } from './view'

type Tab = PluginState['ccworklog']['tab']

const PANE = 'worklog'
const IDLE: Run = {
  phase: 'idle', range: 'today', label: '', done: 0, total: 0, sessions: 0, commits: 0, isCached: false, message: '', missed: [],
}
const RUNNING: readonly Run['phase'][] = ['collecting', 'confirm', 'digesting', 'merging', 'reducing', 'rendering']
const STEPS: readonly { phase: Run['phase']; label: string; doing: string }[] = [
  { phase: 'collecting', label: 'Collect', doing: 'reading transcripts and git' },
  { phase: 'digesting', label: 'Digest', doing: 'summarising sessions on Haiku' },
  { phase: 'merging', label: 'Merge', doing: 'grouping into workstreams' },
  { phase: 'reducing', label: 'Reduce', doing: 'writing the report on Sonnet' },
  { phase: 'rendering', label: 'Render', doing: 'building the HTML report' },
]

const run = atom({ plugin: 'ccworklog', key: 'run' } as const, IDLE)
const view = atom({ plugin: 'ccworklog', key: 'view' } as const, null)
const tab = atom({ plugin: 'ccworklog', key: 'tab' } as const, 'standup')
const page = atom({ plugin: 'ccworklog', key: 'page' } as const, 0)
const frame = atom({ plugin: 'ccworklog', key: 'frame' } as const, 0)

// Held by the module, not state: a reload drops the running pipeline with them,
// and session.start then marks the run interrupted.
let isRunning = false
let answerConfirm: ((isYes: boolean) => void) | null = null

const today = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const depsFor = ($: EngineInterface): Deps => ({
  node: async (script, args, stdin) => {
    const r = await $.process.run(['node', `${$.plugin.root}/skills/worklog/scripts/${script}`, ...args], {
      timeoutMs: 600_000,
      ...(stdin === undefined ? {} : { stdin }),
    })
    return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  },
  read: async path => ((await $.fs.exists(path)) ? await $.fs.read(path) : null),
  complete: async (model, system, prompt, maxTokens) => {
    const r = await $.model.complete({ model, system, prompt, maxTokens, timeoutMs: 300_000 })
    return r.isAnswered ? r.text : null
  },
  progress: async patch => {
    await update($, run, r => ({ ...r, ...patch }))
  },
  confirm: () => new Promise(resolve => {
    answerConfirm = resolve
  }),
})

const start = async ($: EngineInterface, range: string, isFresh: boolean): Promise<void> => {
  if (isRunning) return
  isRunning = true
  await update($, run, () => ({ ...IDLE, phase: 'collecting', range, label: range }))
  const spinner = await $.clock.every(120, () => void update($, frame, n => (n + 1) % SPINNER.length))
  try {
    const out = await runWorklog(range, isFresh, depsFor($))
    if (out.kind === 'done') {
      const loaded = JSON.parse(await $.fs.read(out.viewPath)) as View
      await update($, view, () => loaded)
      await update($, page, () => 0)
      await update($, run, (r): Run => ({ ...r, phase: 'done' }))
      $.ui.toast(`Worklog for ${loaded.label} is ready`)
    } else {
      await update($, run, (r): Run => ({ ...r, phase: out.kind, message: out.message }))
    }
  } catch (err) {
    await update($, run, (r): Run => ({ ...r, phase: 'error', message: String(err) }))
  } finally {
    spinner.cancel()
    isRunning = false
    answerConfirm = null
  }
}

/** Answers /worklog; `fallback` hands the command to the skill where no pane can be placed. */
const worklog = async <T,>($: EngineInterface, raw: string, fallback: () => Promise<T>): Promise<T | { text: string }> => {
  const args = parseArgs(raw)
  if (args.isPurge) return { text: await purge(args.range, depsFor($)) }
  const opened = await $.ui.open({ id: PANE, title: 'Worklog', focus: true })
  if (!opened.isPlaced) return fallback()
  if (isRunning) return { text: 'A worklog is already running in the pane.' }
  void start($, args.range, args.isFresh)
  return { text: `Building the worklog for ${args.range} in the pane.` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await read($, run)
    if (RUNNING.includes(r.phase)) {
      await update($, run, () => ({ ...r, phase: 'error', message: 'The run was interrupted. Run /worklog again: digests are cached.' }))
    }
    return next(e)
  })

  on('command.run', { command: 'worklog' }, ($, e, next) => worklog($, e.args, () => next(e)))
  on('command.run', { command: 'ccworklog:worklog' }, ($, e, next) => worklog($, e.args, () => next(e)))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const kit: Kit = { ...elements, Raster: 'Raster' in elements ? elements.Raster : null }
    const { Box, Text, Button } = kit
    const r = await read($, run)
    const v = await read($, view)
    const width = Math.max(30, e.props.bodyColumns ?? 80)

    if (RUNNING.includes(r.phase) && r.phase !== 'confirm') {
      const spin = SPINNER[(await read($, frame)) % SPINNER.length]
      const at = STEPS.findIndex(s => s.phase === r.phase)
      return (
        <Box flexDirection="column">
          {Banner(kit, r.label)}
          <Box flexDirection="column" paddingX={1} marginTop={1}>
            {STEPS.map((s, i) => {
              const isDone = i < at
              const isNow = i === at
              const progress = s.phase === 'digesting' && (isNow || isDone) && r.total > 0 ? bar(r.done, r.total, Math.min(28, width - 30)) : null
              const note =
                s.phase === 'digesting' && isDone && r.total === 0 ? 'all cached'
                : s.phase === 'reducing' && isDone && r.isCached ? 'cached'
                : s.phase === 'collecting' && isDone ? `${r.sessions} sessions · ${r.commits} commits`
                : isNow && progress === null ? s.doing
                : ''
              return (
                <Text>
                  <Text color={isDone ? 'success' : isNow ? 'claude' : 'subtle'}>{isDone ? '✓  ' : isNow ? `${spin}  ` : '○  '}</Text>
                  <Text bold={isNow} dimColor={!isDone && !isNow}>{s.label.padEnd(9)}</Text>
                  {progress && <Text color="claude">{progress.filled}</Text>}
                  {progress && <Text dimColor>{progress.empty + `  ${r.done}/${r.total}`}</Text>}
                  <Text dimColor>{note}</Text>
                </Text>
              )
            })}
          </Box>
          {r.missed.length > 0 && (
            <Box marginTop={1} paddingX={1}>
              <Text color="warning">{`⚠ ${r.missed.length} session(s) could not be digested; the report will name them.`}</Text>
            </Box>
          )}
        </Box>
      )
    }

    if (r.phase === 'confirm') {
      const minutes = Math.max(1, Math.round((r.total / 4) * 0.3))
      return (
        <Box flexDirection="column">
          {Banner(kit, r.label)}
          <Box borderStyle="round" borderColor="warning" paddingX={1} flexDirection="column" marginTop={1}>
            <Text bold color="warning">{`${r.total} sessions need digesting`}</Text>
            <Text>{`About ${minutes} min on Haiku. Digests are cached, so stopping part-way loses nothing.`}</Text>
          </Box>
          <Box marginTop={1} gap={1}>
            <Button key="yes" label="Continue" hotkey="y" variant="primary" autoFocus onPress={() => answerConfirm?.(true)} />
            <Button key="no" label="Cancel" hotkey="n" onPress={() => answerConfirm?.(false)} />
          </Box>
        </Box>
      )
    }

    if (r.phase === 'error' || r.phase === 'empty' || r.phase === 'cancelled' || v === null) {
      const isIdle = r.phase === 'idle' || v === null && r.phase === 'done'
      const color = r.phase === 'error' ? 'error' : r.phase === 'empty' ? 'success' : 'claude'
      return (
        <Box flexDirection="column">
          {Banner(kit, r.label || 'ccworklog')}
          <Box borderStyle="round" borderColor={color} paddingX={1} marginTop={1}>
            <Text color={r.phase === 'error' ? 'error' : undefined}>
              {isIdle ? 'Run /worklog [today|yesterday|week|lastweek|YYYY-MM-DD] to build a report.' : r.message}
            </Text>
          </Box>
          {!isIdle && (
            <Box marginTop={1}>
              <Button key="again" label="Run again" hotkey="r" onPress={() => void start($, r.range, false)} />
            </Box>
          )}
        </Box>
      )
    }

    const current = await read($, tab)
    const at = Math.min(await read($, page), Math.max(0, v.personal.length - 1))
    const tabs: readonly { tab: Tab; label: string; hotkey: string }[] = [
      { tab: 'standup', label: 'Standup', hotkey: '1' },
      { tab: 'log', label: `Log ${v.personal.length}`, hotkey: '2' },
      { tab: 'threads', label: `Threads ${v.threads.open.length}`, hotkey: '3' },
      { tab: 'timeline', label: 'Timeline', hotkey: '4' },
    ]

    const body =
      current === 'standup' ? StandupTab(kit, v)
      : current === 'log' ? (
        <Box flexDirection="column">
          {v.personal.length > 1 && (
            <Box gap={1} marginBottom={1}>
              <Button key="prev" label="◀" hotkey="p" onPress={() => update($, page, n => Math.max(0, n - 1))} />
              <Text dimColor>{`${at + 1} / ${v.personal.length}`}</Text>
              <Button key="next" label="▶" hotkey="n" onPress={() => update($, page, n => Math.min(v.personal.length - 1, n + 1))} />
              <Text dimColor>{v.personal.map((p, i) => (i === at ? '●' : '○')).join(' ') + '  ' + wsName(v.personal[at]?.workstream ?? '')}</Text>
            </Box>
          )}
          {LogTab(kit, v, at)}
        </Box>
      )
      : current === 'threads' ? ThreadsTab(kit, v, today())
      : TimelineTab(kit, v, width >= 80 ? 48 : 24)

    const missed = v.footer.missedSessions?.length ?? 0
    return (
      <Box flexDirection="column">
        {Banner(kit, prettyRange(v.days, v.label))}
        {Tiles(kit, v)}
        <Box gap={1} marginY={1}>
          {tabs.map(t => (
            <Button
              key={`tab-${t.tab}`}
              label={t.label}
              hotkey={t.hotkey}
              variant={t.tab === current ? 'primary' : 'secondary'}
              onPress={() => update($, tab, () => t.tab)}
            />
          ))}
        </Box>
        {body}
        {missed > 0 && <Text color="warning">{`⚠ ${missed} session(s) not digested. Regenerate to fill the gaps.`}</Text>}
        <Text dimColor>{'─'.repeat(width)}</Text>
        <Box gap={1}>
          <Button
            key="copy"
            label="Copy standup"
            hotkey="c"
            variant="primary"
            onPress={async press => {
              const copied = await $.ui.copy({ text: v.standupMd, surface: press.surface })
              $.ui.toast(copied.isCopied ? 'Standup copied' : 'Could not reach the clipboard here')
            }}
          />
          <Button key="open" label="Open report" hotkey="o" onPress={() => void depsFor($).node('open.mjs', [v.htmlPath])} />
          <Button key="regen" label="Regenerate" hotkey="r" onPress={() => void start($, r.range, true)} />
        </Box>
      </Box>
    )
  })
}
