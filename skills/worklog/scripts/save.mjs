// skills/worklog/scripts/save.mjs
// Persists a model reply (read from stdin) as a digest or a report.json, with
// the fields the pipeline relies on stamped from trusted inputs, never the model.
//   node save.mjs digest <packPath> <digestPath>
//   node save.mjs report <reportPath> <inputHash>
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { extractJson } from './lib/reply.mjs';
import { validateDigest, writeJson } from './lib/store.mjs';

const [cmd, a, b] = process.argv.slice(2);
const reply = readFileSync(0, 'utf8');

const out =
  cmd === 'digest' ? saveDigest(a, b) :
  cmd === 'report' ? saveReport(a, b) :
  { ok: false, errors: [`Unknown command: ${cmd}. Use digest|report`] };

process.stdout.write(JSON.stringify(out) + '\n');
process.exit(out.ok ? 0 : 1);

function saveDigest(packPath, digestPath) {
  const pack = JSON.parse(readFileSync(packPath, 'utf8'));
  const d = extractJson(reply);
  if (!d) return { ok: false, errors: ['reply held no JSON object'] };
  d._key = pack._digestKey;
  d.sessionId = pack.sessionId;
  d.day = pack.day;
  d.firstTs ??= pack.firstTs ?? null;
  d.lastTs ??= pack.lastTs ?? null;
  d.project ??= pack.cwd ? basename(pack.cwd) : null;
  d.branch ??= pack.gitBranch ?? null;
  const v = validateDigest(d);
  if (!v.ok) return { ok: false, errors: v.errors };
  writeJson(digestPath, d);
  return { ok: true };
}

function saveReport(reportPath, inputHash) {
  const r = extractJson(reply);
  if (!r) return { ok: false, errors: ['reply held no JSON object'] };
  if (!Array.isArray(r.days) || r.days.length === 0) return { ok: false, errors: ['days[] missing'] };
  r.label = basename(reportPath).replace(/\.report\.json$/, '');
  r.inputHash = inputHash;
  r.promptVersion = 'v1';
  writeJson(reportPath, r);
  return { ok: true };
}
