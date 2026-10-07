import { expect, test } from 'claude-code/testing'

import { PALETTE, age, bar, colorOf, daysBetween, prettyRange, projectColors, ruler, slotProjects, statTiles, wsName } from './view'
import { VIEW } from './fixture'

test('stat tiles count sessions, active time, commits incl. "+N more", workstreams and threads', () => {
  expect(statTiles(VIEW).map(t => `${t.value} ${t.label}`)).toEqual([
    '2 sessions', '2h30m active', '4 commits', '1 workstream', '1 open thread',
  ])
})

test('workstream names drop an empty branch and keep a real one', () => {
  expect(wsName('connorokane@HEAD')).toBe('connorokane')
  expect(wsName('infra@-')).toBe('infra')
  expect(wsName('infra@feat/x')).toBe('infra · feat/x')
  expect(wsName('PLAT-42')).toBe('PLAT-42')
})

test('each workstream and project keeps one color', () => {
  expect(colorOf(VIEW, 'homelab@main')).toBe(PALETTE[0])
  const colors = projectColors(VIEW)
  expect(colors.get('blog')).toBe(PALETTE[1])
  expect(colorOf(VIEW, 'nope')).toBe('#7A8599')
})

test('slots carry the project active in them, null where idle', () => {
  const cells = slotProjects(VIEW.activity.sessions, '2026-10-07', 24)
  expect(cells[8]).toBe(null)
  expect(cells[9]).toBe('homelab')
  expect(cells[10]).toBe('blog')
  expect(cells[11]).toBe('homelab')
  expect(cells[12]).toBe(null)
})

test('thread age badges go from new to amber to red', () => {
  const t = { id: 't', text: 'x', firstSeen: '2026-10-04' }
  expect(age(t, '2026-10-04')).toEqual({ text: 'new', color: 'success' })
  expect(age(t, '2026-10-07')).toEqual({ text: '3d', color: 'warning' })
  expect(age(t, '2026-10-12')).toEqual({ text: '8d', color: 'error' })
  expect(daysBetween('2026-10-07', '2026-10-07')).toBe(0)
})

test('the ruler puts each hour label at its slot', () => {
  const r = ruler(48)
  expect(r.length).toBe(48)
  expect(r.slice(0, 2)).toBe('00')
  expect(r.slice(24, 26)).toBe('12')
})

test('dates and bars read well', () => {
  expect(prettyRange(['2026-10-07'], 'x')).toBe('Wed 7 Oct 2026')
  expect(prettyRange(['2026-10-06', '2026-10-12'], 'x')).toBe('Tue 6 Oct 2026 – Mon 12 Oct 2026')
  expect(prettyRange([], 'fallback')).toBe('fallback')
  expect(bar(3, 6, 10)).toEqual({ filled: '━━━━━', empty: '━━━━━' })
})
