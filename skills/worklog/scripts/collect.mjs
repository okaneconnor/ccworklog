import { statSync, mkdirSync, existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { resolveRange } from './lib/dates.mjs';
import { resolveClaudeRoot, discoverTranscripts } from './lib/discover.mjs';
import { parseSession } from './lib/parse.mjs';
import { buildEvidencePacks } from './lib/evidence.mjs';
import { collectGitEvidence } from './lib/git.mjs';
import {
  dataDir, readConfig, writeJson, digestKey, isDigestValid, validateDigest, premerge,
} from './lib/store.mjs';

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
  return (config.exclude_repos ?? []).some((p) => cwd && cwd.startsWith(p));
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
    for (const pack of buildEvidencePacks(session, range.days)) {
      const dayDir = join(base, 'evidence', pack.day);
      mkdirSync(dayDir, { recursive: true });
      const packPath = join(dayDir, `${pack.sessionId}.json`);
      const digestPath = join(base, 'digests', `${pack.sessionId}-${pack.day}.json`);
      pack._digestKey = digestKey(t);
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
  const { workstreams, inputHash } = premerge(base, range.days);
  const reduceInputPath = join(base, 'reports', `${range.label}.reduce-input.json`);
  writeJson(reduceInputPath, { label: range.label, days: range.days, inputHash, workstreams });
  return { reduceInputPath, inputHash, invalidDigests };
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
  for (const f of existsSync(repDir) ? readdirSync(repDir) : []) {
    if (f.startsWith(range.label)) { rmSync(join(repDir, f)); removed.push(join(repDir, f)); }
  }
  return { removed };
}
