import { mkdirSync, existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { resolveRange } from './lib/dates.mjs';
import { resolveClaudeRoot, discoverTranscripts } from './lib/discover.mjs';
import { parseSession } from './lib/parse.mjs';
import { buildEvidencePacks } from './lib/evidence.mjs';
import { collectGitEvidence } from './lib/git.mjs';
import {
  dataDir, readConfig, writeJson, digestKey, isDigestValid, validateDigest, premerge,
} from './lib/store.mjs';

const PACK_BUDGET = 100_000;
const STAMP_RESERVE = 200; // reserve for post-build _digestKey stamping

const [cmd, rangeArg] = process.argv.slice(2);
const range = resolveRange(rangeArg);
const base = dataDir();
const config = readConfig(base);

const out =
  cmd === 'collect' ? collect() :
  cmd === 'premerge' ? doPremerge() :
  cmd === 'purge' ? purge() :
  (() => { throw new Error(`Unknown command: ${cmd}. Use collect|premerge|purge`); })();

process.stdout.write(JSON.stringify(out, null, 1) + '\n');

function excluded(cwd) {
  return (config.exclude_repos ?? []).some((p) => cwd && (p === cwd || cwd.startsWith(p + '/')));
}

function collect() {
  const root = resolveClaudeRoot();
  const transcripts = discoverTranscripts(root, range.startMs);
  const packs = [];
  const health = { skippedLines: 0, unknownTypes: {} };
  const cwds = new Set(config.extra_repo_roots ?? []);

  for (const t of transcripts) {
    const session = parseSession(t.path);
    if (!session || !session.meta.sessionId) continue;
    if (excluded(session.meta.cwd)) continue;
    if (session.meta.cwd) cwds.add(session.meta.cwd);
    health.skippedLines += session.meta.skippedLines;
    for (const [k, v] of Object.entries(session.meta.unknownTypes)) {
      health.unknownTypes[k] = (health.unknownTypes[k] ?? 0) + v;
    }
    for (const pack of buildEvidencePacks(session, range.days, PACK_BUDGET - STAMP_RESERVE)) {
      const dayDir = join(base, 'evidence', pack.day);
      mkdirSync(dayDir, { recursive: true });
      const packPath = join(dayDir, `${pack.sessionId}.json`);
      const digestPath = join(base, 'digests', `${pack.sessionId}-${pack.day}.json`);
      pack._digestKey = digestKey(t);
      // Defensive check: flag if stamping caused pack to exceed budget
      if (JSON.stringify(pack).length > PACK_BUDGET) {
        pack.note = (pack.note || '') + ' [over-budget after stamping]';
      }
      writeJson(packPath, pack);
      packs.push({
        sessionId: pack.sessionId, day: pack.day, title: pack.title,
        packPath, digestPath,
        digestValid: isDigestValid(digestPath, t),
        trivial: pack.prompts.length < 2,
      });
    }
  }
  const git = collectGitEvidence([...cwds], range).filter((g) => !excluded(g.repo));
  writeJson(join(base, 'reports', `${range.label}.git.json`), git);
  packs.sort((a, b) => b.day.localeCompare(a.day)); // newest first for backfill UX
  return {
    label: range.label, days: range.days, sinceISO: range.sinceISO, untilISO: range.untilISO,
    empty: packs.length === 0 && git.length === 0,
    packs,
    packsToDigest: packs.filter((p) => !p.digestValid && !p.trivial).length,
    git, parseHealth: health, dataDir: base,
  };
}

function doPremerge() {
  const invalidDigests = [];
  const dir = join(base, 'digests');
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    if (!f.endsWith('.json')) continue;
    const p = join(dir, f);
    let d;
    try { d = JSON.parse(readFileSync(p, 'utf8')); } catch { invalidDigests.push({ digestPath: p, errors: ['unparseable'] }); continue; }
    if (!range.days.includes(d.day)) continue;
    const v = validateDigest(d);
    if (!v.ok) invalidDigests.push({ digestPath: p, errors: v.errors });
    else writeJson(p, d); // persist low_confidence flags added by validation
  }
  let git = null;
  try { git = JSON.parse(readFileSync(join(base, 'reports', `${range.label}.git.json`), 'utf8')); } catch { git = null; }
  const { workstreams, inputHash } = premerge(base, range.days, git);
  const reduceInputPath = join(base, 'reports', `${range.label}.reduce-input.json`);
  writeJson(reduceInputPath, {
    label: range.label, days: range.days, inputHash, workstreams, git,
    activity: buildActivity(),
  });
  return { reduceInputPath, inputHash, invalidDigests };
}

// Deterministic per-session activity for the report's appendix and day-rail,
// read straight from the (already-redacted) evidence packs — the model never
// touches this data: render.mjs pulls it from the reduce-input file directly.
function buildActivity() {
  const sessions = [];
  for (const day of range.days) {
    const dayDir = join(base, 'evidence', day);
    for (const f of existsSync(dayDir) ? readdirSync(dayDir).sort() : []) {
      if (!f.endsWith('.json')) continue;
      try {
        const pack = JSON.parse(readFileSync(join(dayDir, f), 'utf8'));
        sessions.push({
          sessionId: pack.sessionId, day, title: pack.title ?? null,
          project: pack.cwd ? basename(pack.cwd) : null,
          firstTs: pack.firstTs ?? null, lastTs: pack.lastTs ?? null,
          files: (pack.files ?? []).slice(0, 40),
          commands: (pack.commands ?? []).slice(0, 40),
          promptCount: (pack.prompts ?? []).length,
          elided: pack.elided === true,
        });
      } catch { /* unreadable pack — skip from appendix */ }
    }
  }
  return { sessions };
}

function purge() {
  const removed = [];
  for (const day of range.days) {
    const evDir = join(base, 'evidence', day);
    if (existsSync(evDir)) { rmSync(evDir, { recursive: true }); removed.push(evDir); }
    const digDir = join(base, 'digests');
    for (const f of existsSync(digDir) ? readdirSync(digDir) : []) {
      if (f.endsWith(`-${day}.json`)) { rmSync(join(digDir, f)); removed.push(join(digDir, f)); }
    }
  }
  const repDir = join(base, 'reports');
  const wanted = new Set(range.days);
  const stems = new Set(
    (existsSync(repDir) ? readdirSync(repDir) : [])
      .map((f) => f.replace(/\.(html|standup\.md|report\.json|reduce-input\.json|git\.json|view\.json)$/, ''))
  );
  for (const stem of stems) {
    if (stemDays(repDir, stem).some((d) => wanted.has(d))) {
      for (const ext of ['html', 'standup.md', 'report.json', 'reduce-input.json', 'git.json', 'view.json']) {
        const p = join(repDir, `${stem}.${ext}`);
        if (existsSync(p)) { rmSync(p); removed.push(p); }
      }
    }
  }
  return { removed };
}

// A report stem's day coverage: read it from the report/reduce-input JSON so
// overlapping ranges (e.g. purging one day inside a week report) are caught;
// fall back to treating the stem itself as the label when neither exists.
function stemDays(repDir, stem) {
  for (const src of [`${stem}.report.json`, `${stem}.reduce-input.json`]) {
    try {
      const d = JSON.parse(readFileSync(join(repDir, src), 'utf8'));
      if (Array.isArray(d.days) && d.days.length) return d.days;
    } catch { /* try next source */ }
  }
  try { return resolveRange(stem).days; } catch { return stem.startsWith(range.label) ? [...range.days] : []; }
}
