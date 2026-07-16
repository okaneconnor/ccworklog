import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  dataDir, writeJson, digestKey, isDigestValid, validateDigest, premerge, readConfig,
} from '../skills/worklog/scripts/lib/store.mjs';

test('dataDir honors overrides and creates subdirs with 600 files', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ccwd-'));
  const base = dataDir({ CCWORKLOG_DATA_DIR: join(tmp, 'ccw') });
  for (const sub of ['evidence', 'digests', 'reports']) statSync(join(base, sub));
  const f = join(base, 'x.json');
  writeJson(f, { a: 1 });
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const xdg = dataDir({ XDG_DATA_HOME: join(tmp, 'xdg') });
  assert.equal(xdg, join(tmp, 'xdg', 'ccworklog'));
});

test('digest cache invalidates when transcript grows', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ccwd-'));
  const d = join(tmp, 'dig.json');
  const stat = { size: 100, mtimeMs: 1111 };
  writeJson(d, { _key: digestKey(stat), items: [] });
  assert.equal(isDigestValid(d, stat), true);
  assert.equal(isDigestValid(d, { size: 200, mtimeMs: 2222 }), false);
  assert.equal(isDigestValid(join(tmp, 'missing.json'), stat), false);
});

test('validateDigest enforces shape, size, and anchors', () => {
  assert.equal(validateDigest(null).ok, false);
  assert.equal(validateDigest({ items: 'nope' }).ok, false);
  const big = { items: [{ claim: 'c', outcome: 'o', evidence: { files: ['x'.repeat(5000)] } }] };
  assert.equal(validateDigest(big).ok, false);
  const good = {
    items: [
      { claim: 'fixed port sync', outcome: 'Gluetun port sync automated', evidence: { files: ['/r/a.yml'] } },
      { claim: 'vague thing', outcome: 'did stuff', evidence: {} },
    ],
  };
  const v = validateDigest(good);
  assert.equal(v.ok, true);
  assert.equal(good.items[0].low_confidence, undefined);
  assert.equal(good.items[1].low_confidence, true);
});

test('premerge groups by ticket id then project@branch, deterministic hash', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ccwd-'));
  const base = dataDir({ CCWORKLOG_DATA_DIR: join(tmp, 'ccw') });
  writeJson(join(base, 'digests', 's1-2026-07-15.json'),
    { day: '2026-07-15', project: 'infra', branch: 'feat/PLAT-42-x', firstTs: '1', items: [{ claim: 'a', outcome: 'a', evidence: { files: ['f'] } }] });
  writeJson(join(base, 'digests', 's2-2026-07-15.json'),
    { day: '2026-07-15', project: 'infra', branch: 'PLAT-42-followup', firstTs: '2', items: [{ claim: 'b', outcome: 'b', evidence: { files: ['g'] } }] });
  writeJson(join(base, 'digests', 's3-2026-07-15.json'),
    { day: '2026-07-15', project: 'homelab', branch: 'main', firstTs: '3', items: [{ claim: 'c', outcome: 'c', evidence: { files: ['h'] } }] });
  writeJson(join(base, 'digests', 's4-2026-07-14.json'),
    { day: '2026-07-14', project: 'outofrange', branch: 'main', items: [] });

  const a = premerge(base, ['2026-07-15']);
  assert.equal(a.workstreams.length, 2);
  const plat = a.workstreams.find((w) => w.workstream === 'PLAT-42');
  assert.equal(plat.digests.length, 2);
  assert.deepEqual(plat.digests.map((d) => d.firstTs), ['1', '2']); // sorted by time
  const b = premerge(base, ['2026-07-15']);
  assert.equal(a.inputHash, b.inputHash); // deterministic
});

test('ticket ids come only from branch — prose identifiers do not create workstreams', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ccwd-'));
  const base = dataDir({ CCWORKLOG_DATA_DIR: join(tmp, 'ccw') });
  writeJson(join(base, 'digests', 'p1-2026-07-15.json'),
    { day: '2026-07-15', project: 'infra', branch: 'main',
      items: [{ claim: 'Patched CVE-2024-3094 per RFC-7231', outcome: 'patched', evidence: { files: ['f'] } }] });
  const r = premerge(base, ['2026-07-15']);
  assert.equal(r.workstreams.length, 1);
  assert.equal(r.workstreams[0].workstream, 'infra@main');
});

test('cross-project same-ticket digests merge with projects/tickets unioned', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ccwd-'));
  const base = dataDir({ CCWORKLOG_DATA_DIR: join(tmp, 'ccw') });
  writeJson(join(base, 'digests', 'a-2026-07-15.json'),
    { day: '2026-07-15', project: 'api', branch: 'feat/PLAT-9-server', firstTs: '1', items: [{ claim: 'a', outcome: 'a', evidence: { files: ['f'] } }] });
  writeJson(join(base, 'digests', 'b-2026-07-15.json'),
    { day: '2026-07-15', project: 'web', branch: 'PLAT-9-client', firstTs: '2', items: [{ claim: 'b', outcome: 'b', evidence: { files: ['g'] } }] });
  const r = premerge(base, ['2026-07-15']);
  assert.equal(r.workstreams.length, 1);
  const w = r.workstreams[0];
  assert.equal(w.workstream, 'PLAT-9');
  assert.deepEqual(w.projects, ['api', 'web']);
  assert.deepEqual(w.tickets, ['PLAT-9']);
});

test('readConfig returns {} when missing, parses when present', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ccwd-'));
  const base = dataDir({ CCWORKLOG_DATA_DIR: join(tmp, 'ccw') });
  assert.deepEqual(readConfig(base), {});
  writeFileSync(join(base, 'config.json'), '{"open":"never"}');
  assert.equal(readConfig(base).open, 'never');
});
