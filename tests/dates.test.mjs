import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDayOf, resolveRange, isoWithOffset, localMidnight } from '../skills/worklog/scripts/lib/dates.mjs';

test('UTC evening maps to next local day in BST', () => {
  // 23:11 UTC on Jun 18 = 00:11 local Jun 19 (BST = UTC+1)
  assert.equal(localDayOf('2026-06-18T23:11:14.014Z'), '2026-06-19');
  assert.equal(localDayOf('2026-06-18T22:11:14.014Z'), '2026-06-18');
});

test('winter (GMT) day boundary is UTC midnight', () => {
  assert.equal(localDayOf('2026-01-10T23:30:00Z'), '2026-01-10');
});

test('invalid timestamp returns null', () => {
  assert.equal(localDayOf('garbage'), null);
});

test('resolveRange today/yesterday', () => {
  const now = new Date(2026, 6, 15, 14, 0); // local 2026-07-15 14:00
  assert.deepEqual(resolveRange('today', now).days, ['2026-07-15']);
  assert.deepEqual(resolveRange(undefined, now).days, ['2026-07-15']);
  assert.deepEqual(resolveRange('yesterday', now).days, ['2026-07-14']);
});

test('resolveRange week = ISO Monday through today; lastweek = full Mon–Sun', () => {
  const now = new Date(2026, 6, 15, 14, 0); // Wednesday
  assert.deepEqual(resolveRange('week', now).days, ['2026-07-13', '2026-07-14', '2026-07-15']);
  const lw = resolveRange('lastweek', now);
  assert.equal(lw.days[0], '2026-07-06');
  assert.equal(lw.days.at(-1), '2026-07-12');
  assert.equal(lw.days.length, 7);
});

test('explicit day and range', () => {
  assert.deepEqual(resolveRange('2026-07-10').days, ['2026-07-10']);
  assert.deepEqual(resolveRange('2026-07-01..2026-07-03').days,
    ['2026-07-01', '2026-07-02', '2026-07-03']);
  assert.throws(() => resolveRange('not-a-range'));
});

test('sinceISO/untilISO carry local offset and bound the range exclusively', () => {
  const r = resolveRange('2026-07-15');
  assert.match(r.sinceISO, /^2026-07-15T00:00:00\+01:00$/); // BST
  assert.match(r.untilISO, /^2026-07-16T00:00:00\+01:00$/);
  assert.equal(r.endMs - r.startMs, 24 * 3600 * 1000);
});

test('DST fall-back day is 25 hours long', () => {
  const r = resolveRange('2026-10-25'); // clocks back in Europe/London
  assert.equal(r.endMs - r.startMs, 25 * 3600 * 1000);
});

test('localMidnight constructs local 00:00', () => {
  const d = localMidnight('2026-07-15');
  assert.equal(d.getHours(), 0);
  assert.equal(d.getDate(), 15);
});
