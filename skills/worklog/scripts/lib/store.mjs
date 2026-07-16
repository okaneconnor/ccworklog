import {
  mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const DIGEST_TARGET = 2000;
export const DIGEST_MAX = 4096;
const TICKET_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

export function dataDir(env = process.env) {
  const base = env.CCWORKLOG_DATA_DIR
    || join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'ccworklog');
  for (const sub of ['evidence', 'digests', 'reports']) mkdirSync(join(base, sub), { recursive: true });
  return base;
}

export function readConfig(base) {
  try { return JSON.parse(readFileSync(join(base, 'config.json'), 'utf8')); } catch { return {}; }
}

export function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 1), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* windows / exotic fs */ }
}

export function digestKey(stat) {
  return `${stat.size}:${Math.round(stat.mtimeMs)}:v${SCHEMA_VERSION}`;
}

export function isDigestValid(path, stat) {
  if (!existsSync(path)) return false;
  try { return JSON.parse(readFileSync(path, 'utf8'))._key === digestKey(stat); } catch { return false; }
}

// Validates digest shape, size, and anchors; mutates items in place to set low_confidence.
export function validateDigest(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, errors: ['digest is not an object'] };
  const errors = [];
  if (!Array.isArray(d.items)) errors.push('items[] missing');
  const raw = JSON.stringify(d);
  if (raw.length > DIGEST_MAX) errors.push(`digest too large (${raw.length} > ${DIGEST_MAX})`);
  for (const it of Array.isArray(d.items) ? d.items : []) {
    if (!it?.claim || !it?.outcome) { errors.push('item missing claim/outcome'); continue; }
    const ev = it.evidence ?? {};
    const anchors = (ev.files?.length ?? 0) + (ev.commands?.length ?? 0)
      + (ev.commit_shas?.length ?? 0) + (ev.pr_links?.length ?? 0) + (ev.error_excerpt ? 1 : 0);
    if (anchors === 0) it.low_confidence = true;
  }
  return { ok: errors.length === 0, errors };
}

export function premerge(base, days) {
  const dir = join(base, 'digests');
  const wanted = new Set(days);
  const digests = [];
  for (const f of existsSync(dir) ? readdirSync(dir).sort() : []) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (wanted.has(d.day)) digests.push(d);
    } catch { /* corrupt digest — skipped; re-digest will replace it */ }
  }
  const groups = new Map();
  for (const d of digests) {
    // Scan only branch for ticket IDs; prose in items is not a sanctioned source.
    const tickets = [...new Set([...(d.branch ?? '').matchAll(TICKET_RE)].map((m) => m[1]))]
      .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const key = tickets[0] || `${d.project ?? 'unknown'}@${d.branch ?? '-'}`;
    if (!groups.has(key)) {
      const projects = d.project ? [d.project] : [];
      groups.set(key, {
        workstream: key, project: d.project ?? null, projects, branch: d.branch ?? null, tickets, digests: [],
      });
    } else {
      // Union tickets and projects from digests with same key.
      const group = groups.get(key);
      const allTickets = [...new Set([...group.tickets, ...tickets])].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      group.tickets = allTickets;
      if (d.project && !group.projects.includes(d.project)) {
        group.projects.push(d.project);
        group.projects.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      }
    }
    groups.get(key).digests.push(d);
  }
  const workstreams = [...groups.values()].sort((a, b) => a.workstream < b.workstream ? -1 : a.workstream > b.workstream ? 1 : 0);
  for (const w of workstreams) {
    w.digests.sort((a, b) => {
      const aTs = String(a.firstTs ?? '');
      const bTs = String(b.firstTs ?? '');
      return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
    });
  }
  const inputHash = createHash('sha256').update(JSON.stringify(workstreams)).digest('hex').slice(0, 16);
  return { workstreams, inputHash };
}
