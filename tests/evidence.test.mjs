import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidencePacks } from '../skills/worklog/scripts/lib/evidence.mjs';

const meta = { sessionId: 's1', title: 'T', cwd: '/r', gitBranch: 'main', prLinks: [], unknownTypes: {}, skippedLines: 0 };

test('midnight-spanning session splits into one pack per local day', () => {
  const entries = [
    { kind: 'prompt', ts: '2026-06-18T22:30:00Z', text: 'before midnight (23:30 local)' },
    { kind: 'prompt', ts: '2026-06-18T23:30:00Z', text: 'after midnight (00:30 local next day)' },
  ];
  const packs = buildEvidencePacks({ meta, entries }, ['2026-06-18', '2026-06-19']);
  assert.deepEqual(packs.map((p) => p.day).sort(), ['2026-06-18', '2026-06-19']);
  assert.equal(packs.find((p) => p.day === '2026-06-19').prompts[0], 'after midnight (00:30 local next day)');
});

test('days outside wanted range are dropped; entries without ts are dropped', () => {
  const entries = [
    { kind: 'prompt', ts: '2026-07-10T10:00:00Z', text: 'in range' },
    { kind: 'prompt', ts: '2026-07-11T10:00:00Z', text: 'out of range' },
    { kind: 'prompt', ts: null, text: 'no timestamp' },
  ];
  const packs = buildEvidencePacks({ meta, entries }, ['2026-07-10']);
  assert.equal(packs.length, 1);
  assert.deepEqual(packs[0].prompts, ['in range']);
});

test('budget pressure drops assistant bulk first, keeps prompts and errors, sets elision marker', () => {
  const entries = [
    { kind: 'prompt', ts: '2026-07-10T10:00:00Z', text: 'the intent' },
    { kind: 'tool_error', ts: '2026-07-10T10:01:00Z', exitCode: 1, line: 'Error: the root cause' },
    ...Array.from({ length: 50 }, (_, i) => ({
      kind: 'assistant_text', ts: '2026-07-10T10:02:00Z', text: `bulk assistant text ${i} `.repeat(50),
    })),
  ];
  const packs = buildEvidencePacks({ meta, entries }, ['2026-07-10'], 5000);
  const p = packs[0];
  assert.ok(JSON.stringify(p).length <= 5000);
  assert.deepEqual(p.prompts, ['the intent']);
  assert.equal(p.errors[0].line, 'Error: the root cause');
  assert.equal(p.elided, true);
  assert.ok(p.note.includes('ELIDED'));
});

test('packs are redacted at build time', () => {
  const entries = [{ kind: 'prompt', ts: '2026-07-10T10:00:00Z', text: 'use key AKIAIOSFODNN7EXAMPLE now' }];
  const packs = buildEvidencePacks({ meta, entries }, ['2026-07-10']);
  assert.ok(packs[0].prompts[0].includes('[REDACTED:aws-access-key]'));
});

test('files and commands deduped from tool_use', () => {
  const entries = [
    { kind: 'tool_use', ts: '2026-07-10T10:00:00Z', tool: 'Edit', file: '/r/a.tf' },
    { kind: 'tool_use', ts: '2026-07-10T10:01:00Z', tool: 'Edit', file: '/r/a.tf' },
    { kind: 'tool_use', ts: '2026-07-10T10:02:00Z', tool: 'Bash', command: 'terraform apply' },
  ];
  const p = buildEvidencePacks({ meta, entries }, ['2026-07-10'])[0];
  assert.deepEqual(p.files, ['/r/a.tf']);
  assert.deepEqual(p.commands, ['terraform apply']);
});
