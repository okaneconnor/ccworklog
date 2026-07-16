// skills/worklog/scripts/render.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { redact } from './lib/redact.mjs';
import { writeJson } from './lib/store.mjs';

const reportPath = resolve(process.argv[2]);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const reportsDir = dirname(reportPath);
const base = dirname(reportsDir);

// Final-render redaction boundary: applied to the entire serialized report.
const safe = JSON.parse(redact(JSON.stringify(report)).text);

const template = readFileSync(new URL('../templates/report.html', import.meta.url), 'utf8');
const html = template.replace('__CCWORKLOG_DATA__',
  () => JSON.stringify(safe).replace(/</g, '\\u003c'));
const htmlPath = join(reportsDir, `${safe.label}.html`);
writeFileSync(htmlPath, html);

const standupMd = buildStandupMd(safe);
writeFileSync(join(reportsDir, `${safe.label}.standup.md`), standupMd);

writeJson(join(base, 'threads.json'), { open: safe.threads?.open ?? [], updated: safe.label });

process.stdout.write(buildRecap(safe, htmlPath));

function buildStandupMd(r) {
  const lines = [`## Standup — ${r.label}`, ''];
  for (const s of r.standup ?? []) {
    for (const o of s.outcomes ?? []) lines.push(`- **${s.workstream}**: ${o}`);
  }
  for (const a of r.alsoShipped ?? []) lines.push(`- **${a.repo.split('/').pop()}**: ${a.summary}`);
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
