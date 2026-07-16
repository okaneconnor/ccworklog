// tests/render.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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

function setup() {
  const dataDirPath = mkdtempSync(join(tmpdir(), 'ccwr-'));
  mkdirSync(join(dataDirPath, 'reports'), { recursive: true });
  const reportPath = join(dataDirPath, 'reports', '2026-07-15.report.json');
  writeFileSync(reportPath, JSON.stringify(REPORT));
  const stdout = execFileSync('node', ['skills/worklog/scripts/render.mjs', reportPath], { encoding: 'utf8' });
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

test('terminal recap has standup, threads, and report path; standup.md written; threads.json updated', () => {
  const { dataDirPath, stdout } = setup();
  assert.ok(stdout.includes('PLAT-42'));
  assert.ok(stdout.includes('Open threads: 1'));
  assert.ok(stdout.includes('2026-07-15.html'));
  const md = readFileSync(join(dataDirPath, 'reports', '2026-07-15.standup.md'), 'utf8');
  assert.ok(md.includes('Automated gluetun port sync'));
  const threads = JSON.parse(readFileSync(join(dataDirPath, 'threads.json'), 'utf8'));
  assert.equal(threads.open[0].id, 't-1');
});
