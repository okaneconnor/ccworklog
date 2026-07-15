import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSession } from '../skills/worklog/scripts/lib/parse.mjs';

function session(lines) {
  const f = join(mkdtempSync(join(tmpdir(), 'ccw-')), 's.jsonl');
  writeFileSync(f, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return parseSession(f);
}

const T = '2026-07-15T10:00:00.000Z';

test('real prompts kept; tool_result carriers, isMeta and sidechains dropped', () => {
  const { entries } = session([
    { type: 'user', sessionId: 's1', timestamp: T, cwd: '/r', message: { content: 'fix the DNS sinkhole' } },
    { type: 'user', timestamp: T, message: { content: [{ type: 'tool_result', content: 'huge stdout' }] } },
    { type: 'user', timestamp: T, isMeta: true, message: { content: 'meta noise' } },
    { type: 'user', timestamp: T, isSidechain: true, message: { content: 'sidechain prompt' } },
    { type: 'user', timestamp: T, message: { content: [{ type: 'text', text: 'second real prompt' }] } },
  ]);
  const prompts = entries.filter((e) => e.kind === 'prompt').map((e) => e.text);
  assert.deepEqual(prompts, ['fix the DNS sinkhole', 'second real prompt']);
});

test('command wrappers and system reminders are stripped', () => {
  const { entries } = session([
    { type: 'user', timestamp: T, message: { content:
      '<command-name>/model</command-name><local-command-stdout>Set model</local-command-stdout>real question<system-reminder>ignore me</system-reminder>' } },
  ]);
  assert.deepEqual(entries.filter((e) => e.kind === 'prompt').map((e) => e.text), ['real question']);
});

test('assistant text and tool_use inputs extracted; tool errors from toolUseResult', () => {
  const { entries } = session([
    { type: 'assistant', timestamp: T, message: { content: [
      { type: 'text', text: 'I will edit the config' },
      { type: 'tool_use', name: 'Bash', input: { command: 'terraform plan' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/main.tf' } },
    ] } },
    { type: 'user', timestamp: T, message: { content: [{ type: 'tool_result', content: 'x' }] },
      toolUseResult: { stdout: '', stderr: 'Error: cycle detected\nmore lines', exitCode: 1 } },
  ]);
  assert.equal(entries.find((e) => e.kind === 'assistant_text').text, 'I will edit the config');
  assert.equal(entries.find((e) => e.command).command, 'terraform plan');
  assert.equal(entries.find((e) => e.file).file, '/repo/main.tf');
  const err = entries.find((e) => e.kind === 'tool_error');
  assert.equal(err.exitCode, 1);
  assert.equal(err.line, 'Error: cycle detected');
});

test('ai-title and pr-link harvested to meta; unknown types counted not fatal; bad lines skipped', () => {
  const { meta } = session([
    { type: 'ai-title', sessionId: 's1', aiTitle: 'Fix gluetun port sync' },
    { type: 'pr-link', prUrl: 'https://github.com/o/r/pull/7', prNumber: 7, prRepository: 'o/r' },
    { type: 'brand-new-type-2027', payload: 1 },
    '{ not json at all',
    { type: 'user', sessionId: 's1', timestamp: T, cwd: '/repo/sub', gitBranch: 'feat/PLAT-42', message: { content: 'hi' } },
  ]);
  assert.equal(meta.title, 'Fix gluetun port sync');
  assert.deepEqual(meta.prLinks, [{ url: 'https://github.com/o/r/pull/7', number: 7, repo: 'o/r' }]);
  assert.equal(meta.unknownTypes['brand-new-type-2027'], 1);
  assert.equal(meta.skippedLines, 1);
  assert.equal(meta.sessionId, 's1');
  assert.equal(meta.cwd, '/repo/sub');
  assert.equal(meta.gitBranch, 'feat/PLAT-42');
});

test('unreadable file returns null', () => {
  assert.equal(parseSession('/no/such/file.jsonl'), null);
});
