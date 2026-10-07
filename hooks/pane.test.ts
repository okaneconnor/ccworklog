import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { VIEW } from './fixture'

const PANE = {
  component: 'Pane' as const,
  requestId: 'worklog',
  props: { title: 'Worklog', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
}

const SURFACES = ['terminal', 'desktop'] as const

const MANIFEST = {
  label: '2026-10-07', empty: false, git: [{}],
  packs: [{ sessionId: 's1', packPath: '/d/evidence/s1.json', digestPath: '/d/digests/s1.json', digestValid: false, trivial: false }],
  parseHealth: {}, dataDir: '/d',
}
const FILES: Record<string, string> = {
  '/d/evidence/s1.json': '{"prompts":["a","b"]}',
  '/d/reports/2026-10-07.reduce-input.json': '{"workstreams":[]}',
  '/d/reports/2026-10-07.view.json': JSON.stringify(VIEW),
}

/** Answers, beneath the plugin, everything a /worklog run reaches outside the mod. */
const fakeHost = (on: On) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const [, script = '', sub] = e.argv as string[]
    const stdout =
      script.endsWith('collect.mjs') && sub === 'collect' ? JSON.stringify(MANIFEST)
      : script.endsWith('collect.mjs') && sub === 'premerge' ? JSON.stringify({ reduceInputPath: '/d/reports/2026-10-07.reduce-input.json', inputHash: 'h', invalidDigests: [] })
      : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', ($, e) => ({ value: (e.path as string) in FILES }))
  on('fs.read', ($, e) => ({ value: FILES[e.path as string] ?? '' }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"days":["2026-10-07"]}', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }))
}

test('before any run the pane says how to start one', async $ => {
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'ccworklog', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /Run \/worklog/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/worklog runs the pipeline and the pane shows the report, tab by tab', async ($, on) => {
  fakeHost(on)
  const ran = await $.command.run({
    command: 'worklog', args: 'today', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 },
  })
  expect(ran.text).toBe('Building the worklog for today in the pane.')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'ccworklog', surface, ...PANE })
    const texts = JSON.stringify((await ui.findAll({ type: 'Text' })).map(t => t.text))
    expect(await ui.find({ type: 'Text', text: /◆ WORKLOG/ }), texts).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^2h30m$/ }), texts).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Synced the qBittorrent port/ }), texts).toBeDefined()

    await ui.press({ key: 'tab-log' })
    expect(await ui.find({ type: 'Text', text: /Port sync/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^connection refused$/ })).toBeDefined()

    await ui.press({ key: 'tab-threads' })
    expect(await ui.find({ type: 'Text', text: /Add tracker list/ })).toBeDefined()

    await ui.press({ key: 'tab-timeline' })
    expect(await ui.find({ type: 'Text', text: /Wed 07/ })).toBeDefined()

    await ui.press({ key: 'tab-standup' })
    await ui.unmount()
  }
})
