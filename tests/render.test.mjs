// tests/render.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const REPORT = {
  label: '2026-07-15', days: ['2026-07-15'], inputHash: 'h', promptVersion: 'v1',
  standup: [{ workstream: 'PLAT-42', project: 'infra', outcomes: ['Automated gluetun port sync'] }],
  personal: [{
    workstream: 'PLAT-42', narrative: 'hit stale port, fixed via UP_COMMAND hook',
    items: [{ claim: 'port sync', detail: 'gluetun rotates port on restart', evidence: { files: ['/r/compose.yml'], commands: [], error_excerpt: 'Error: connection refused with token ghp_abcdefghijklmnopqrstuvwxyz012345', commit_shas: [], pr_links: [] } }],
  }],
  alsoShipped: [], timeline: [{ day: '2026-07-15', projects: ['infra'], empty: false }],
  threads: { open: [{ id: 't-1', text: 'add curated tracker list', repo: 'homelab', firstSeen: '2026-07-10', lastState: 'not started' }], resolved: [] },
  footer: { parseHealth: 'ok', missedSessions: [] },
};

function setup(extraArgs = []) {
  const dataDirPath = mkdtempSync(join(tmpdir(), 'ccwr-'));
  mkdirSync(join(dataDirPath, 'reports'), { recursive: true });
  const reportPath = join(dataDirPath, 'reports', '2026-07-15.report.json');
  writeFileSync(reportPath, JSON.stringify(REPORT));
  const stdout = execFileSync('node', ['skills/worklog/scripts/render.mjs', reportPath, ...extraArgs], { encoding: 'utf8' });
  return { dataDirPath, stdout };
}

test('renders self-contained HTML with no external references', () => {
  const { dataDirPath } = setup();
  const html = readFileSync(join(dataDirPath, 'reports', '2026-07-15.html'), 'utf8');
  assert.ok(html.includes('Automated gluetun port sync'));
  assert.ok(html.includes('prefers-color-scheme'));
  assert.doesNotMatch(html, /https?:\/\/(?!github\.com)/); // no CDN/external loads (PR links ok)
  assert.doesNotMatch(html, /<script src|<link rel="stylesheet" href="http/);
});

test('render-boundary redaction catches secrets that reached report.json', () => {
  const { dataDirPath } = setup();
  const html = readFileSync(join(dataDirPath, 'reports', '2026-07-15.html'), 'utf8');
  assert.ok(!html.includes('ghp_abcdefghijklmnopqrstuvwxyz012345'));
  assert.ok(html.includes('[REDACTED:github-token]'));
});

test('terminal recap has standup, threads, and report path; standup.md written; threads.json updated when --update-threads passed', () => {
  const { dataDirPath, stdout } = setup(['--update-threads']);
  assert.ok(stdout.includes('PLAT-42'));
  assert.ok(stdout.includes('Open threads: 1'));
  assert.ok(stdout.includes('2026-07-15.html'));
  const md = readFileSync(join(dataDirPath, 'reports', '2026-07-15.standup.md'), 'utf8');
  assert.ok(md.includes('Automated gluetun port sync'));
  const threads = JSON.parse(readFileSync(join(dataDirPath, 'threads.json'), 'utf8'));
  assert.equal(threads.open[0].id, 't-1');
});

test('render WITHOUT --update-threads leaves a pre-existing threads.json untouched', () => {
  const dataDirPath = mkdtempSync(join(tmpdir(), 'ccwr-'));
  mkdirSync(join(dataDirPath, 'reports'), { recursive: true });
  const reportPath = join(dataDirPath, 'reports', '2026-07-15.report.json');
  writeFileSync(reportPath, JSON.stringify(REPORT));
  const preexisting = { open: [{ id: 't-old', text: 'stale historical snapshot' }], updated: 'stale-label' };
  writeFileSync(join(dataDirPath, 'threads.json'), JSON.stringify(preexisting));
  execFileSync('node', ['skills/worklog/scripts/render.mjs', reportPath], { encoding: 'utf8' });
  const threads = JSON.parse(readFileSync(join(dataDirPath, 'threads.json'), 'utf8'));
  assert.deepEqual(threads, preexisting);
});

test('render WITH --update-threads rewrites threads.json from the report', () => {
  const dataDirPath = mkdtempSync(join(tmpdir(), 'ccwr-'));
  mkdirSync(join(dataDirPath, 'reports'), { recursive: true });
  const reportPath = join(dataDirPath, 'reports', '2026-07-15.report.json');
  writeFileSync(reportPath, JSON.stringify(REPORT));
  writeFileSync(join(dataDirPath, 'threads.json'), JSON.stringify({ open: [{ id: 't-old' }], updated: 'stale-label' }));
  execFileSync('node', ['skills/worklog/scripts/render.mjs', reportPath, '--update-threads'], { encoding: 'utf8' });
  const threads = JSON.parse(readFileSync(join(dataDirPath, 'threads.json'), 'utf8'));
  assert.equal(threads.open[0].id, 't-1');
  assert.equal(threads.updated, '2026-07-15');
});

test('schema deviations are normalized — missing days and repo-less alsoShipped still render', () => {
  const dataDirPath = mkdtempSync(join(tmpdir(), 'ccwr-'));
  mkdirSync(join(dataDirPath, 'reports'), { recursive: true });
  const reportPath = join(dataDirPath, 'reports', '2026-07-15.report.json');
  const deviant = { ...REPORT, alsoShipped: [{ summary: 'shipped something', commits: [] }] };
  delete deviant.days;
  writeFileSync(reportPath, JSON.stringify(deviant));
  const stdout = execFileSync('node', ['skills/worklog/scripts/render.mjs', reportPath], { encoding: 'utf8' });
  const htmlPath = join(dataDirPath, 'reports', '2026-07-15.html');
  assert.ok(existsSync(htmlPath));
  assert.ok(readFileSync(htmlPath, 'utf8').includes('shipped something'));
  assert.ok(stdout.includes('shipped something'));
});

test('report without a label fails with one clean line, exit 1', () => {
  const dataDirPath = mkdtempSync(join(tmpdir(), 'ccwr-'));
  mkdirSync(join(dataDirPath, 'reports'), { recursive: true });
  const reportPath = join(dataDirPath, 'reports', '2026-07-15.report.json');
  const unlabeled = { ...REPORT };
  delete unlabeled.label;
  writeFileSync(reportPath, JSON.stringify(unlabeled));
  try {
    execFileSync('node', ['skills/worklog/scripts/render.mjs', reportPath], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('should have exited non-zero');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(e.stderr, /ccworklog render: invalid report: missing label/);
    assert.ok(!e.stderr.includes('at '));  // no stack frames
  }
});

test('label cannot traverse outside the reports dir', () => {
  const dataDirPath = mkdtempSync(join(tmpdir(), 'ccwr-'));
  mkdirSync(join(dataDirPath, 'reports'), { recursive: true });
  const reportPath = join(dataDirPath, 'reports', '2026-07-15.report.json');
  writeFileSync(reportPath, JSON.stringify({ ...REPORT, label: '../../evil' }));
  execFileSync('node', ['skills/worklog/scripts/render.mjs', reportPath], { encoding: 'utf8' });
  assert.ok(existsSync(join(dataDirPath, 'reports', '2026-07-15.html')));
  assert.ok(!existsSync(join(dirname(dataDirPath), 'evil.html')));
});

test('missing report fails with one clean line, no stack', () => {
  let out;
  try {
    execFileSync('node', ['skills/worklog/scripts/render.mjs', '/no/such/report.json'], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('should have exited non-zero');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(e.stderr, /ccworklog render: cannot read report/);
    assert.ok(!e.stderr.includes('at '));  // no stack frames
  }
});

test('html and standup.md are chmod 600', () => {
  const { dataDirPath } = setup();
  assert.equal(statSync(join(dataDirPath, 'reports', '2026-07-15.html')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dataDirPath, 'reports', '2026-07-15.standup.md')).mode & 0o777, 0o600);
});
