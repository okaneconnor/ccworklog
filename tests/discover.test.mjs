import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveClaudeRoot, discoverTranscripts } from '../skills/worklog/scripts/lib/discover.mjs';
import { makeCorpus } from './helpers/corpus.mjs';

test('resolveClaudeRoot honors CLAUDE_CONFIG_DIR', () => {
  assert.equal(resolveClaudeRoot({ CLAUDE_CONFIG_DIR: '/x/claude' }), '/x/claude');
  assert.ok(resolveClaudeRoot({}).endsWith('/.claude'));
});

test('discovery excludes sidechain files, non-jsonl, agent-*, and stale mtimes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccw-'));
  makeCorpus(root, [
    { project: '-p-alpha', id: 'aaa', lines: [{ type: 'user' }], sidechainFiles: 2 },
    { project: '-p-alpha', id: 'old', lines: [{ type: 'user' }], mtime: new Date('2020-01-01') },
    { project: '-p-beta', id: 'bbb', lines: [{ type: 'user' }] },
  ]);
  // decoys
  writeFileSync(join(root, 'projects', '-p-alpha', 'agent-zzz.jsonl'), '{}\n');
  writeFileSync(join(root, 'projects', '-p-alpha', 'notes.txt'), 'hi\n');
  mkdirSync(join(root, 'projects', '-p-alpha', 'memory'), { recursive: true });

  const found = discoverTranscripts(root, new Date('2025-01-01').getTime());
  const names = found.map((f) => f.path.split('/').pop()).sort();
  assert.deepEqual(names, ['aaa.jsonl', 'bbb.jsonl']);
  assert.ok(found.every((f) => f.size > 0 && f.mtimeMs > 0));
});

test('missing projects dir returns empty, never throws', () => {
  assert.deepEqual(discoverTranscripts('/nonexistent-root-xyz', 0), []);
});
