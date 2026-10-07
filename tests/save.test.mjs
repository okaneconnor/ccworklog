// tests/save.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { extractJson } from '../skills/worklog/scripts/lib/reply.mjs';

const PACK = {
  sessionId: 's-1', day: '2026-07-15', cwd: '/r/homelab', gitBranch: 'main',
  firstTs: '2026-07-15T08:00:00Z', lastTs: '2026-07-15T09:00:00Z', _digestKey: '10:20:v1',
  prompts: ['a', 'b'],
};
const ITEM = { claim: 'port sync', outcome: 'Automated port sync', detail: 'd', evidence: { files: ['/r/x'] } };

function save(args, stdin) {
  const r = spawnSync('node', ['skills/worklog/scripts/save.mjs', ...args], { input: stdin, encoding: 'utf8' });
  return { code: r.status, out: JSON.parse(r.stdout) };
}

function packFile() {
  const dir = mkdtempSync(join(tmpdir(), 'ccws-'));
  const packPath = join(dir, 'pack.json');
  writeFileSync(packPath, JSON.stringify(PACK));
  return { dir, packPath, digestPath: join(dir, 'digest.json') };
}

test('extractJson reads a bare object, a fenced one, and one wrapped in prose', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here it is: {"a":{"b":2}} done.'), { a: { b: 2 } });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson('[1,2]'), null);
  assert.equal(extractJson('{broken'), null);
});

test('save digest stamps key, session and day from the pack, not the reply', () => {
  const { packPath, digestPath } = packFile();
  const reply = JSON.stringify({ _key: 'forged', sessionId: 'other', day: '1999-01-01', items: [ITEM] });
  const { code, out } = save(['digest', packPath, digestPath], reply);
  assert.equal(code, 0);
  assert.deepEqual(out, { ok: true });
  const d = JSON.parse(readFileSync(digestPath, 'utf8'));
  assert.equal(d._key, '10:20:v1');
  assert.equal(d.sessionId, 's-1');
  assert.equal(d.day, '2026-07-15');
  assert.equal(d.project, 'homelab');
  assert.equal(statSync(digestPath).mode & 0o777, 0o600);
});

test('save digest refuses an invalid digest and writes nothing', () => {
  const { packPath, digestPath } = packFile();
  const { code, out } = save(['digest', packPath, digestPath], '{"items":[{"claim":"x"}]}');
  assert.equal(code, 1);
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.includes('claim/outcome')));
  assert.equal(existsSync(digestPath), false);
});

test('save report stamps label, inputHash and promptVersion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccws-'));
  const reportPath = join(dir, '2026-07-15.report.json');
  const reply = '```json\n' + JSON.stringify({ label: 'wrong', days: ['2026-07-15'], standup: [] }) + '\n```';
  const { code } = save(['report', reportPath, 'abc123'], reply);
  assert.equal(code, 0);
  const r = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(r.label, '2026-07-15');
  assert.equal(r.inputHash, 'abc123');
  assert.equal(r.promptVersion, 'v1');
  assert.equal(statSync(reportPath).mode & 0o777, 0o600);
});

test('save report refuses a reply with no days', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccws-'));
  const { code, out } = save(['report', join(dir, 'x.report.json'), 'h'], '{"standup":[]}');
  assert.equal(code, 1);
  assert.deepEqual(out.errors, ['days[] missing']);
});
