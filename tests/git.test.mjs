import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { collectGitEvidence } from '../skills/worklog/scripts/lib/git.mjs';

function repo(email) {
  const dir = mkdtempSync(join(tmpdir(), 'ccwgit-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', email);
  g('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'f.txt'), '1');
  g('add', '.');
  g('commit', '-q', '-m', 'PLAT-42 add feature');
  return { dir, g };
}

const WIDE = { sinceISO: '2000-01-01T00:00:00+00:00', untilISO: '2099-12-31T23:59:59+00:00' };

test('collects own commits, dedupes monorepo subdirs, skips dead paths', () => {
  const { dir } = repo('me@example.com');
  mkdirSync(join(dir, 'sub/deep'), { recursive: true });
  const out = collectGitEvidence([dir, join(dir, 'sub/deep'), '/no/such/path', tmpdir()], WIDE);
  assert.equal(out.length, 1);
  assert.equal(out[0].repo, execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim());
  assert.equal(out[0].author, 'me@example.com');
  assert.equal(out[0].commits.length, 1);
  assert.match(out[0].commits[0].subject, /PLAT-42/);
});

test('commits on switched-away branches are still found (--all)', () => {
  const { dir, g } = repo('me@example.com');
  g('checkout', '-q', '-b', 'feat/x');
  writeFileSync(join(dir, 'g.txt'), '2');
  g('add', '.');
  g('commit', '-q', '-m', 'work on feature branch');
  g('checkout', '-q', 'main');
  const out = collectGitEvidence([dir], WIDE);
  assert.ok(out[0].commits.some((c) => c.subject === 'work on feature branch'));
});

test('other authors are filtered out', () => {
  const { dir, g } = repo('me@example.com');
  g('config', 'user.email', 'coworker@example.com');
  writeFileSync(join(dir, 'h.txt'), '3');
  g('add', '.');
  g('commit', '-q', '-m', 'coworker commit');
  // author filter comes from *current* repo config → coworker@example.com
  const out = collectGitEvidence([dir], WIDE);
  assert.deepEqual(out[0].commits.map((c) => c.subject), ['coworker commit']);
});

test('early-morning commits inside the window are included; outside excluded', () => {
  const { dir, g } = repo('me@example.com');
  const commitAt = (iso, file) => {
    writeFileSync(join(dir, file), file);
    g('add', '.');
    execFileSync('git', ['commit', '-q', '-m', `commit ${file}`], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
    });
  };
  commitAt('2026-07-15T00:30:00+01:00', 'early.txt');   // 00:30 local, in window
  commitAt('2026-07-14T23:30:00+01:00', 'before.txt');  // previous local day
  const out = collectGitEvidence([dir], {
    sinceISO: '2026-07-15T00:00:00+01:00',
    untilISO: '2026-07-16T00:00:00+01:00',
  });
  const subjects = out[0].commits.map((c) => c.subject);
  assert.ok(subjects.includes('commit early.txt'));
  assert.ok(!subjects.includes('commit before.txt'));
});

test('--author escapes regex metacharacters and anchors the email', () => {
  const { dir, g } = repo('connor.okane@example.com');
  writeFileSync(join(dir, 'dot.txt'), 'dot');
  g('add', '.');
  g('commit', '-q', '-m', 'commit by dotted email');
  g('config', 'user.email', 'connorXokane@example.com');
  writeFileSync(join(dir, 'x.txt'), 'x');
  g('add', '.');
  g('commit', '-q', '-m', 'commit by X email');
  g('config', 'user.email', 'connor.okane@example.com');
  const out = collectGitEvidence([dir], WIDE);
  const subjects = out[0].commits.map((c) => c.subject);
  assert.ok(subjects.includes('commit by dotted email'));
  assert.ok(!subjects.includes('commit by X email'));
});
