import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
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
  const packRaw = readFileSync(p1.packPath, 'utf8');
  assert.ok(JSON.parse(packRaw) && JSON.stringify(JSON.parse(packRaw)).length <= 100000);
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

test('collect writes <label>.git.json; premerge folds it into reduce-input.json', () => {
  const env = fixtureEnv();
  const m = run(['collect', '2026-07-15'], env);
  const gitJsonPath = join(env.CCWORKLOG_DATA_DIR, 'reports', '2026-07-15.git.json');
  assert.ok(existsSync(gitJsonPath));
  assert.deepEqual(JSON.parse(readFileSync(gitJsonPath, 'utf8')), m.git);

  const p1 = m.packs.find((p) => p.sessionId === 'sess-1');
  const digest = {
    _key: JSON.parse(readFileSync(p1.packPath, 'utf8'))._digestKey,
    sessionId: 'sess-1', day: '2026-07-15', project: 'repo-alpha', branch: 'feat/PLAT-7', firstTs: T('09'),
    items: [{ claim: 'fixed cycle', outcome: 'Resolved terraform cycle in repo-alpha', evidence: { files: ['/repo/main.tf'] } }],
    loose_ends: [], findings: [],
  };
  writeFileSync(p1.digestPath, JSON.stringify(digest));
  const pm = run(['premerge', '2026-07-15'], env);
  const ri = JSON.parse(readFileSync(pm.reduceInputPath, 'utf8'));
  assert.ok('git' in ri);
  assert.deepEqual(ri.git, m.git);
});

test('purge removes range artifacts', () => {
  const env = fixtureEnv();
  const m = run(['collect', '2026-07-15'], env);
  const out = run(['purge', '2026-07-15'], env);
  assert.ok(out.removed.length >= 1);
  assert.equal(existsSync(m.packs[0].packPath), false);
});

test('purge removes overlapping-range reports and spares unrelated days', () => {
  const env = fixtureEnv();
  run(['collect', '2026-07-15'], env);
  const repDir = join(env.CCWORKLOG_DATA_DIR, 'reports');
  mkdirSync(repDir, { recursive: true });
  writeFileSync(join(repDir, 'week-of-2026-07-13.reduce-input.json'),
    JSON.stringify({ days: ['2026-07-14', '2026-07-15', '2026-07-16'] }));
  writeFileSync(join(repDir, 'week-of-2026-07-13.html'), '<!doctype html>');
  writeFileSync(join(repDir, '2026-07-01.report.json'),
    JSON.stringify({ days: ['2026-07-01'] }));
  const out = run(['purge', '2026-07-15'], env);
  assert.equal(existsSync(join(repDir, 'week-of-2026-07-13.html')), false);
  assert.equal(existsSync(join(repDir, 'week-of-2026-07-13.reduce-input.json')), false);
  assert.equal(existsSync(join(repDir, '2026-07-01.report.json')), true);
  assert.ok(out.removed.some((p) => p.includes('week-of-2026-07-13')));
});

test('premerge reduce-input carries deterministic activity from evidence packs', () => {
  const env = fixtureEnv();
  run(['collect', '2026-07-15'], env);
  const pm = run(['premerge', '2026-07-15'], env);
  const ri = JSON.parse(readFileSync(pm.reduceInputPath, 'utf8'));
  assert.ok(Array.isArray(ri.activity.sessions));
  const s1 = ri.activity.sessions.find((s) => s.sessionId === 'sess-1');
  assert.equal(s1.title, 'Fix terraform cycle');
  assert.equal(s1.promptCount, 2);
  assert.ok(s1.files.includes('/repo/main.tf'));
});
