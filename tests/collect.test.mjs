import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { makeCorpus } from './helpers/corpus.mjs';

const SCRIPT = 'skills/worklog/scripts/collect.mjs';
const T = (h) => `2026-07-15T${h}:00:00.000Z`;

function run(args, env) {
  return JSON.parse(execFileSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }));
}

function fixtureEnv() {
  const tmp = mkdtempSync(join(tmpdir(), 'ccwit-'));
  const claudeRoot = join(tmp, 'claude');
  makeCorpus(claudeRoot, [
    {
      project: '-repo-alpha', id: 'sess-1', sidechainFiles: 1,
      lines: [
        { type: 'ai-title', sessionId: 'sess-1', aiTitle: 'Fix terraform cycle' },
        { type: 'user', sessionId: 'sess-1', timestamp: T('09'), cwd: '/tmp', gitBranch: 'feat/PLAT-7',
          message: { content: 'fix the terraform cycle error' } },
        { type: 'user', sessionId: 'sess-1', timestamp: T('10'),
          message: { content: 'now add the outputs' } },
        { type: 'assistant', sessionId: 'sess-1', timestamp: T('10'),
          message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/main.tf' } }] } },
        { type: 'weird-future-type' },
      ],
    },
    { // trivial session: one prompt only
      project: '-repo-beta', id: 'sess-2',
      lines: [{ type: 'user', sessionId: 'sess-2', timestamp: T('11'), message: { content: 'quick question' } }],
    },
  ]);
  return {
    CLAUDE_CONFIG_DIR: claudeRoot,
    CCWORKLOG_DATA_DIR: join(tmp, 'data'),
  };
}

test('collect writes packs, flags trivial, reports parse health', () => {
  const env = fixtureEnv();
  const m = run(['collect', '2026-07-15'], env);
  assert.equal(m.empty, false);
  assert.equal(m.packs.length, 2);
  const p1 = m.packs.find((p) => p.sessionId === 'sess-1');
  assert.equal(p1.trivial, false);
  assert.equal(p1.digestValid, false);
  assert.equal(m.packs.find((p) => p.sessionId === 'sess-2').trivial, true);
  assert.equal(m.packsToDigest, 1);
  const pack = JSON.parse(readFileSync(p1.packPath, 'utf8'));
  assert.deepEqual(pack.prompts, ['fix the terraform cycle error', 'now add the outputs']);
  assert.equal(pack.title, 'Fix terraform cycle');
  assert.ok(pack._digestKey.includes(':v1'));
  assert.equal(m.parseHealth.unknownTypes['weird-future-type'], 1);
});

test('collect on an empty day short-circuits', () => {
  const env = fixtureEnv();
  const m = run(['collect', '2026-01-01'], env);
  assert.equal(m.empty, true);
  assert.deepEqual(m.packs, []);
});

test('premerge validates digests and writes reduce-input', async () => {
  const env = fixtureEnv();
  const m = run(['collect', '2026-07-15'], env);
  const p1 = m.packs.find((p) => p.sessionId === 'sess-1');
  // simulate a digest subagent writing a valid digest
  const digest = {
    _key: JSON.parse(readFileSync(p1.packPath, 'utf8'))._digestKey,
    sessionId: 'sess-1', day: '2026-07-15', project: 'repo-alpha', branch: 'feat/PLAT-7', firstTs: T('09'),
    items: [{ claim: 'fixed cycle', outcome: 'Resolved terraform cycle in repo-alpha', evidence: { files: ['/repo/main.tf'] } }],
    loose_ends: [], findings: [],
  };
  writeFileSync(p1.digestPath, JSON.stringify(digest));
  const pm = run(['premerge', '2026-07-15'], env);
  assert.deepEqual(pm.invalidDigests, []);
  const ri = JSON.parse(readFileSync(pm.reduceInputPath, 'utf8'));
  assert.equal(ri.workstreams[0].workstream, 'PLAT-7');
  assert.equal(pm.inputHash.length, 16);
});

test('purge removes range artifacts', () => {
  const env = fixtureEnv();
  const m = run(['collect', '2026-07-15'], env);
  const out = run(['purge', '2026-07-15'], env);
  assert.ok(out.removed.length >= 1);
  assert.equal(existsSync(m.packs[0].packPath), false);
});
