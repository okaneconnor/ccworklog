// skills/worklog/scripts/render.mjs
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { redact } from './lib/redact.mjs';
import { writeJson } from './lib/store.mjs';

const argv = process.argv.slice(2);
const updateThreads = argv.includes('--update-threads');
const reportPathArg = argv.find((a) => !a.startsWith('--'));
const reportPath = resolve(reportPathArg ?? '');
let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (err) {
  process.stderr.write(`ccworklog render: cannot read report: ${reportPath}: ${err.message}\n`);
  process.exit(1);
}
if (!report || typeof report !== 'object' || !report.label) {
  process.stderr.write(`ccworklog render: invalid report: missing label: ${reportPath}\n`);
  process.exit(1);
}
try {
  chmodSync(reportPath, 0o600);
} catch (err) {
  // ignore chmod failures
}
const reportsDir = dirname(reportPath);
const base = dirname(reportsDir);
const stem = basename(reportPath).replace(/\.report\.json$/, '');

// A model-written report.json can deviate from schema (missing arrays, nulls,
// etc). Normalize shapes before redaction so neither the redactor nor the
// template ever has to guess at a missing field's type.
report.days = Array.isArray(report.days) ? report.days : [];
report.standup = Array.isArray(report.standup) ? report.standup : [];
report.personal = Array.isArray(report.personal) ? report.personal : [];
report.alsoShipped = Array.isArray(report.alsoShipped) ? report.alsoShipped : [];
report.timeline = Array.isArray(report.timeline) ? report.timeline : [];
const threadsIn = (report.threads && typeof report.threads === 'object') ? report.threads : {};
report.threads = {
  open: Array.isArray(threadsIn.open) ? threadsIn.open : [],
  resolved: Array.isArray(threadsIn.resolved) ? threadsIn.resolved : [],
};
report.footer = (report.footer && typeof report.footer === 'object' && !Array.isArray(report.footer))
  ? report.footer : {};

// Final-render redaction boundary: applied to the entire serialized report.
const safe = JSON.parse(redact(JSON.stringify(report)).text);

const template = readFileSync(new URL('../templates/report.html', import.meta.url), 'utf8');
const html = template.replace('__CCWORKLOG_DATA__',
  () => JSON.stringify(safe).replace(/</g, '\\u003c'));
const htmlPath = join(reportsDir, `${stem}.html`);
writeFileSync(htmlPath, html);
try {
  chmodSync(htmlPath, 0o600);
} catch (err) {
  // ignore chmod failures
}

const standupMd = buildStandupMd(safe);
const standupPath = join(reportsDir, `${stem}.standup.md`);
writeFileSync(standupPath, standupMd);
try {
  chmodSync(standupPath, 0o600);
} catch (err) {
  // ignore chmod failures
}

// threads.json is the live ledger of open threads. Only overwrite it when this
// invocation actually ran REDUCE (cache miss or --fresh); re-rendering a cached
// historical report must never clobber the live ledger with a stale snapshot.
if (updateThreads) {
  writeJson(join(base, 'threads.json'), { open: safe.threads?.open ?? [], updated: safe.label });
}

process.stdout.write(buildRecap(safe, htmlPath));

function buildStandupMd(r) {
  const lines = [`## Standup — ${r.label}`, ''];
  for (const s of r.standup ?? []) {
    for (const o of s.outcomes ?? []) lines.push(`- **${s.workstream}**: ${o}`);
  }
  for (const a of r.alsoShipped ?? []) lines.push(`- **${String(a.repo ?? '').split('/').pop()}**: ${a.summary}`);
  const open = r.threads?.open ?? [];
  if (open.length) {
    lines.push('', '**Next:**');
    for (const t of open.slice(0, 5)) lines.push(`- ${t.text}`);
  }
  return lines.join('\n') + '\n';
}

function buildRecap(r, path) {
  const lines = [`# Worklog — ${r.label}`, '', buildStandupMd(r).trim(), ''];
  const open = r.threads?.open ?? [];
  if (open.length) {
    const oldest = open.map((t) => t.firstSeen).sort()[0];
    lines.push(`Open threads: ${open.length} (oldest since ${oldest})`);
  }
  const missed = r.footer?.missedSessions ?? [];
  if (missed.length) lines.push(`⚠ ${missed.length} session(s) not digested — re-run /worklog to fill gaps`);
  lines.push('', `Report: ${path}`);
  return lines.join('\n') + '\n';
}
