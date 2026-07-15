# ccworklog v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public Claude Code plugin providing `/worklog` — daily/weekly work-summary reports mined from local session transcripts + git activity, rendered as a terminal standup recap and a self-contained styled HTML report.

**Architecture:** Deterministic Node scripts do ALL transcript parsing (COLLECT → evidence packs → GIT evidence → premerge); the skill orchestrates model work only for MAP (digest subagents, ≤4 concurrent) and REDUCE (narrative synthesis into a validated `report.json`); a deterministic render script produces HTML/standup.md/terminal recap. Everything cacheable and resumable.

**Tech Stack:** Node ≥ 18 (zero runtime dependencies, `node:test` for tests), vanilla HTML/CSS/JS template, Claude Code plugin format (`.claude-plugin/`).

**Spec:** `docs/superpowers/specs/2026-07-15-ccworklog-design.md` — read it before starting.

## Global Constraints

- Node ≥ 18 only; zero npm dependencies anywhere (`package.json` has no `dependencies`/`devDependencies`).
- Zero network I/O in any script or template (no fetch/http/CDN; HTML fully inlined).
- Never write inside `~/.claude` — app data lives in `$CCWORKLOG_DATA_DIR || $XDG_DATA_HOME/ccworklog || ~/.local/share/ccworklog`.
- Transcript root is `$CLAUDE_CONFIG_DIR || ~/.claude`; scan `projects/*/*.jsonl` non-recursively.
- Exclude sidechains: skip files matching `agent-*.jsonl` or paths containing `/subagents/`; drop entries with `isSidechain: true`.
- All timestamps are UTC ISO; day bucketing uses the SYSTEM LOCAL timezone via `Date`/`toLocaleDateString('sv-SE')` — never hand-rolled offsets.
- Parsing is unknown-by-default: per-line and per-session try/catch; unknown entry types counted, never fatal.
- All written data files `chmod 600`.
- Digest subagent concurrency ≤ 4; digest JSON target ≤ 2000 chars, hard reject > 4096.
- Evidence packs ≤ 100,000 JSON chars, prioritized extraction (prompts → titles/PRs/files/commands → errors → assistant samples), never naive truncation.
- Redaction (typed markers) at evidence-pack build AND final render.
- Tests run with `TZ=Europe/London` (set in the npm test script) so local-vs-UTC assertions are meaningful.
- macOS/Linux/WSL only for v1.

---

### Task 1: Plugin scaffold

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `package.json`
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `README.md` (placeholder — full README is Task 12)
- Test: `tests/scaffold.test.mjs`

**Interfaces:**
- Produces: repo layout all later tasks assume; `npm test` runs `TZ=Europe/London node --test tests/`.

- [ ] **Step 1: Write the failing test**

```js
// tests/scaffold.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('plugin.json is valid and named ccworklog', () => {
  const p = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
  assert.equal(p.name, 'ccworklog');
  assert.match(p.version, /^\d+\.\d+\.\d+$/);
  assert.ok(p.description.length > 20);
});

test('marketplace.json points at this repo root', () => {
  const m = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'));
  assert.equal(m.name, 'ccworklog');
  assert.equal(m.plugins[0].name, 'ccworklog');
  assert.equal(m.plugins[0].source, './');
});

test('package.json declares zero dependencies', () => {
  const p = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(p.dependencies, undefined);
  assert.equal(p.devDependencies, undefined);
  assert.equal(p.type, 'module');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TZ=Europe/London node --test tests/`
Expected: FAIL — `ENOENT .claude-plugin/plugin.json`

- [ ] **Step 3: Create the files**

```json
// .claude-plugin/plugin.json
{
  "name": "ccworklog",
  "version": "0.1.0",
  "description": "Daily/weekly work-summary reports from your Claude Code sessions and git activity. 100% local, no API key, no network — Claude Code deletes your transcripts after 30 days; ccworklog remembers.",
  "author": { "name": "Connor O'Kane" }
}
```

```json
// .claude-plugin/marketplace.json
{
  "name": "ccworklog",
  "owner": { "name": "Connor O'Kane" },
  "plugins": [
    {
      "name": "ccworklog",
      "source": "./",
      "description": "/worklog — daily/weekly work-summary reports from your Claude Code sessions + git. 100% local."
    }
  ]
}
```

```json
// package.json
{
  "name": "ccworklog",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "TZ=Europe/London node --test tests/"
  }
}
```

```
# .gitignore
node_modules/
.DS_Store
```

`LICENSE`: standard MIT text, copyright `2026 Connor O'Kane`.

`README.md` placeholder:

```markdown
# ccworklog

Daily/weekly work-summary reports from your Claude Code sessions + git. 100% local.

> Under construction — v1 in progress. Full README lands with the first release.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: plugin scaffold (plugin.json, marketplace.json, test harness)"
```

---

### Task 2: Date/range engine — `skills/worklog/scripts/lib/dates.mjs`

**Files:**
- Create: `skills/worklog/scripts/lib/dates.mjs`
- Test: `tests/dates.test.mjs`

**Interfaces:**
- Produces:
  - `localDayOf(tsOrDate) → 'YYYY-MM-DD' | null` (system tz)
  - `localMidnight(day) → Date`
  - `addDays(day, n) → 'YYYY-MM-DD'`
  - `isoWithOffset(date) → '2026-07-15T00:00:00+01:00'`
  - `resolveRange(arg, now?) → { days: string[], label, sinceISO, untilISO, startMs, endMs }`

- [ ] **Step 1: Write the failing test**

```js
// tests/dates.test.mjs  (runs under TZ=Europe/London)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDayOf, resolveRange, isoWithOffset, localMidnight } from '../skills/worklog/scripts/lib/dates.mjs';

test('UTC evening maps to next local day in BST', () => {
  // 23:11 UTC on Jun 18 = 00:11 local Jun 19 (BST = UTC+1)
  assert.equal(localDayOf('2026-06-18T23:11:14.014Z'), '2026-06-19');
  assert.equal(localDayOf('2026-06-18T22:11:14.014Z'), '2026-06-18');
});

test('winter (GMT) day boundary is UTC midnight', () => {
  assert.equal(localDayOf('2026-01-10T23:30:00Z'), '2026-01-10');
});

test('invalid timestamp returns null', () => {
  assert.equal(localDayOf('garbage'), null);
});

test('resolveRange today/yesterday', () => {
  const now = new Date(2026, 6, 15, 14, 0); // local 2026-07-15 14:00
  assert.deepEqual(resolveRange('today', now).days, ['2026-07-15']);
  assert.deepEqual(resolveRange(undefined, now).days, ['2026-07-15']);
  assert.deepEqual(resolveRange('yesterday', now).days, ['2026-07-14']);
});

test('resolveRange week = ISO Monday through today; lastweek = full Mon–Sun', () => {
  const now = new Date(2026, 6, 15, 14, 0); // Wednesday
  assert.deepEqual(resolveRange('week', now).days, ['2026-07-13', '2026-07-14', '2026-07-15']);
  const lw = resolveRange('lastweek', now);
  assert.equal(lw.days[0], '2026-07-06');
  assert.equal(lw.days.at(-1), '2026-07-12');
  assert.equal(lw.days.length, 7);
});

test('explicit day and range', () => {
  assert.deepEqual(resolveRange('2026-07-10').days, ['2026-07-10']);
  assert.deepEqual(resolveRange('2026-07-01..2026-07-03').days,
    ['2026-07-01', '2026-07-02', '2026-07-03']);
  assert.throws(() => resolveRange('not-a-range'));
});

test('sinceISO/untilISO carry local offset and bound the range exclusively', () => {
  const r = resolveRange('2026-07-15');
  assert.match(r.sinceISO, /^2026-07-15T00:00:00\+01:00$/); // BST
  assert.match(r.untilISO, /^2026-07-16T00:00:00\+01:00$/);
  assert.equal(r.endMs - r.startMs, 24 * 3600 * 1000);
});

test('DST fall-back day is 25 hours long', () => {
  const r = resolveRange('2026-10-25'); // clocks back in Europe/London
  assert.equal(r.endMs - r.startMs, 25 * 3600 * 1000);
});

test('localMidnight constructs local 00:00', () => {
  const d = localMidnight('2026-07-15');
  assert.equal(d.getHours(), 0);
  assert.equal(d.getDate(), 15);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test` — Expected: FAIL, cannot find module `dates.mjs`.

- [ ] **Step 3: Implement**

```js
// skills/worklog/scripts/lib/dates.mjs
export function localDayOf(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d)) return null;
  return d.toLocaleDateString('sv-SE'); // YYYY-MM-DD in the system timezone
}

export function localMidnight(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d); // local-time constructor handles DST correctly
}

export function addDays(day, n) {
  const d = localMidnight(day);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv-SE');
}

export function isoWithOffset(d) {
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_RE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

export function resolveRange(arg, now = new Date()) {
  const today = now.toLocaleDateString('sv-SE');
  let start, end, label;
  if (!arg || arg === 'today') { start = end = label = today; }
  else if (arg === 'yesterday') { start = end = label = addDays(today, -1); }
  else if (arg === 'week' || arg === 'lastweek') {
    const dow = (localMidnight(today).getDay() + 6) % 7; // 0 = Monday
    let monday = addDays(today, -dow);
    if (arg === 'lastweek') monday = addDays(monday, -7);
    start = monday;
    end = arg === 'week' ? today : addDays(monday, 6);
    label = `week-of-${monday}`;
  } else if (DAY_RE.test(arg)) { start = end = label = arg; }
  else if (RANGE_RE.test(arg)) { [, start, end] = arg.match(RANGE_RE); label = `${start}..${end}`; }
  else throw new Error(`Unrecognized range: ${arg}. Use today|yesterday|week|lastweek|YYYY-MM-DD|A..B`);
  if (start > end) throw new Error(`Range start ${start} is after end ${end}`);
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  const startDate = localMidnight(start);
  const endDate = localMidnight(addDays(end, 1)); // exclusive upper bound
  return {
    days, label,
    sinceISO: isoWithOffset(startDate), untilISO: isoWithOffset(endDate),
    startMs: startDate.getTime(), endMs: endDate.getTime(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass** — `npm test`, all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: date range engine with local-day bucketing and DST-safe boundaries"
```

---

### Task 3: Transcript discovery — `skills/worklog/scripts/lib/discover.mjs`

**Files:**
- Create: `skills/worklog/scripts/lib/discover.mjs`
- Create: `tests/helpers/corpus.mjs` (fixture-corpus builder used by this and later tasks)
- Test: `tests/discover.test.mjs`

**Interfaces:**
- Produces:
  - `resolveClaudeRoot(env?) → path` (`$CLAUDE_CONFIG_DIR || ~/.claude`)
  - `discoverTranscripts(root, startMs) → [{ path, mtimeMs, size }]`
  - helper: `makeCorpus(tmpdir, sessions) → root` writes `projects/<proj>/<id>.jsonl` files (and optional `subagents/agent-*.jsonl`) with controllable mtimes.

- [ ] **Step 1: Write the fixture helper** (no test yet — it's test infrastructure)

```js
// tests/helpers/corpus.mjs
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

/** sessions: [{ project, id, lines: object[], mtime?: Date, sidechainFiles?: number }] */
export function makeCorpus(root, sessions) {
  for (const s of sessions) {
    const dir = join(root, 'projects', s.project);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${s.id}.jsonl`);
    writeFileSync(file, s.lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
    if (s.mtime) utimesSync(file, s.mtime, s.mtime);
    for (let i = 0; i < (s.sidechainFiles ?? 0); i++) {
      const sub = join(dir, s.id, 'subagents');
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, `agent-${i}.jsonl`), JSON.stringify({ type: 'user', isSidechain: true }) + '\n');
    }
  }
  return root;
}
```

- [ ] **Step 2: Write the failing test**

```js
// tests/discover.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveClaudeRoot, discoverTranscripts } from '../skills/worklog/scripts/lib/discover.mjs';
import { makeCorpus } from './helpers/corpus.mjs';

test('resolveClaudeRoot honors CLAUDE_CONFIG_DIR', () => {
  assert.equal(resolveClaudeRoot({ CLAUDE_CONFIG_DIR: '/x/claude' }), '/x/claude');
  assert.ok(resolveClaudeRoot({}).endsWith('/.claude'));
});

test('discovery excludes sidechain files, non-jsonl, agent-*, and stale mtimes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccw-'));
  makeCorpus(root, [
    { project: '-p-alpha', id: 'aaa', lines: [{ type: 'user' }], sidechainFiles: 2 },
    { project: '-p-alpha', id: 'old', lines: [{ type: 'user' }], mtime: new Date('2020-01-01') },
    { project: '-p-beta', id: 'bbb', lines: [{ type: 'user' }] },
  ]);
  // decoys
  writeFileSync(join(root, 'projects', '-p-alpha', 'agent-zzz.jsonl'), '{}\n');
  writeFileSync(join(root, 'projects', '-p-alpha', 'notes.txt'), 'hi\n');
  mkdirSync(join(root, 'projects', '-p-alpha', 'memory'), { recursive: true });

  const found = discoverTranscripts(root, new Date('2025-01-01').getTime());
  const names = found.map((f) => f.path.split('/').pop()).sort();
  assert.deepEqual(names, ['aaa.jsonl', 'bbb.jsonl']);
  assert.ok(found.every((f) => f.size > 0 && f.mtimeMs > 0));
});

test('missing projects dir returns empty, never throws', () => {
  assert.deepEqual(discoverTranscripts('/nonexistent-root-xyz', 0), []);
});
```

- [ ] **Step 3: Run test to verify it fails** — `npm test`, FAIL: module not found.

- [ ] **Step 4: Implement**

```js
// skills/worklog/scripts/lib/discover.mjs
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function resolveClaudeRoot(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function discoverTranscripts(root, startMs) {
  const out = [];
  let projects = [];
  try { projects = readdirSync(join(root, 'projects'), { withFileTypes: true }); } catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = join(root, 'projects', p.name);
    let files = [];
    try { files = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      if (f.name.startsWith('agent-')) continue;           // sidechain transcripts
      const path = join(dir, f.name);
      if (path.includes(`${'/'}subagents${'/'}`)) continue; // defense in depth
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.mtimeMs < startMs) continue;                   // cannot contain in-range entries
      out.push({ path, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
}
```

- [ ] **Step 5: Run tests, verify pass, commit**

```bash
npm test && git add -A && git commit -m "feat: transcript discovery with sidechain exclusion and mtime prefilter"
```

---

### Task 4: Defensive transcript parsing — `skills/worklog/scripts/lib/parse.mjs`

**Files:**
- Create: `skills/worklog/scripts/lib/parse.mjs`
- Test: `tests/parse.test.mjs`

**Interfaces:**
- Produces: `parseSession(path) → { meta, entries } | null` where
  - `meta = { sessionId, title, prLinks: [{url,number,repo}], version, cwd, gitBranch, unknownTypes: {type:count}, skippedLines }`
  - `entries = [{ kind: 'prompt'|'assistant_text'|'tool_use'|'tool_error', ts, ... }]` — `prompt` has `text`; `tool_use` has `tool`, `command?`, `file?`; `tool_error` has `exitCode`, `line`.
- Consumes: nothing (pure; file path in).

- [ ] **Step 1: Write the failing test**

```js
// tests/parse.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSession } from '../skills/worklog/scripts/lib/parse.mjs';

function session(lines) {
  const f = join(mkdtempSync(join(tmpdir(), 'ccw-')), 's.jsonl');
  writeFileSync(f, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return parseSession(f);
}

const T = '2026-07-15T10:00:00.000Z';

test('real prompts kept; tool_result carriers, isMeta and sidechains dropped', () => {
  const { entries } = session([
    { type: 'user', sessionId: 's1', timestamp: T, cwd: '/r', message: { content: 'fix the DNS sinkhole' } },
    { type: 'user', timestamp: T, message: { content: [{ type: 'tool_result', content: 'huge stdout' }] } },
    { type: 'user', timestamp: T, isMeta: true, message: { content: 'meta noise' } },
    { type: 'user', timestamp: T, isSidechain: true, message: { content: 'sidechain prompt' } },
    { type: 'user', timestamp: T, message: { content: [{ type: 'text', text: 'second real prompt' }] } },
  ]);
  const prompts = entries.filter((e) => e.kind === 'prompt').map((e) => e.text);
  assert.deepEqual(prompts, ['fix the DNS sinkhole', 'second real prompt']);
});

test('command wrappers and system reminders are stripped', () => {
  const { entries } = session([
    { type: 'user', timestamp: T, message: { content:
      '<command-name>/model</command-name><local-command-stdout>Set model</local-command-stdout>real question<system-reminder>ignore me</system-reminder>' } },
  ]);
  assert.deepEqual(entries.filter((e) => e.kind === 'prompt').map((e) => e.text), ['real question']);
});

test('assistant text and tool_use inputs extracted; tool errors from toolUseResult', () => {
  const { entries } = session([
    { type: 'assistant', timestamp: T, message: { content: [
      { type: 'text', text: 'I will edit the config' },
      { type: 'tool_use', name: 'Bash', input: { command: 'terraform plan' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/main.tf' } },
    ] } },
    { type: 'user', timestamp: T, message: { content: [{ type: 'tool_result', content: 'x' }] },
      toolUseResult: { stdout: '', stderr: 'Error: cycle detected\nmore lines', exitCode: 1 } },
  ]);
  assert.equal(entries.find((e) => e.kind === 'assistant_text').text, 'I will edit the config');
  assert.equal(entries.find((e) => e.command).command, 'terraform plan');
  assert.equal(entries.find((e) => e.file).file, '/repo/main.tf');
  const err = entries.find((e) => e.kind === 'tool_error');
  assert.equal(err.exitCode, 1);
  assert.equal(err.line, 'Error: cycle detected');
});

test('ai-title and pr-link harvested to meta; unknown types counted not fatal; bad lines skipped', () => {
  const { meta } = session([
    { type: 'ai-title', sessionId: 's1', aiTitle: 'Fix gluetun port sync' },
    { type: 'pr-link', prUrl: 'https://github.com/o/r/pull/7', prNumber: 7, prRepository: 'o/r' },
    { type: 'brand-new-type-2027', payload: 1 },
    '{ not json at all',
    { type: 'user', sessionId: 's1', timestamp: T, cwd: '/repo/sub', gitBranch: 'feat/PLAT-42', message: { content: 'hi' } },
  ]);
  assert.equal(meta.title, 'Fix gluetun port sync');
  assert.deepEqual(meta.prLinks, [{ url: 'https://github.com/o/r/pull/7', number: 7, repo: 'o/r' }]);
  assert.equal(meta.unknownTypes['brand-new-type-2027'], 1);
  assert.equal(meta.skippedLines, 1);
  assert.equal(meta.sessionId, 's1');
  assert.equal(meta.cwd, '/repo/sub');
  assert.equal(meta.gitBranch, 'feat/PLAT-42');
});

test('unreadable file returns null', () => {
  assert.equal(parseSession('/no/such/file.jsonl'), null);
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test`, FAIL: module not found.

- [ ] **Step 3: Implement**

```js
// skills/worklog/scripts/lib/parse.mjs
import { readFileSync } from 'node:fs';

const KNOWN_IGNORED = new Set([
  'system', 'attachment', 'mode', 'file-history-snapshot', 'last-prompt',
  'permission-mode', 'agent-name', 'queue-operation',
]);
const WRAPPER_RE =
  /<(command-name|command-message|command-args|command-contents|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder)>[\s\S]*?<\/\1>/g;

function promptText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    if (content.some((b) => b && b.type === 'tool_result')) return null;
    return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text).join('\n');
  }
  return null;
}

export function parseSession(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  const meta = {
    sessionId: null, title: null, prLinks: [], version: null,
    cwd: null, gitBranch: null, unknownTypes: {}, skippedLines: 0,
  };
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { meta.skippedLines++; continue; }
    try { ingest(e, meta, entries); } catch { meta.skippedLines++; }
  }
  return { meta, entries };
}

function ingest(e, meta, entries) {
  const t = e.type;
  if (e.sessionId && !meta.sessionId) meta.sessionId = e.sessionId;
  if (e.version && !meta.version) meta.version = e.version;
  if (e.isSidechain === true) return;

  if (t === 'ai-title') { if (typeof e.aiTitle === 'string') meta.title = e.aiTitle; return; }
  if (t === 'pr-link') {
    meta.prLinks.push({ url: e.prUrl ?? null, number: e.prNumber ?? null, repo: e.prRepository ?? null });
    return;
  }
  if (t === 'user') {
    if (e.cwd && !meta.cwd) meta.cwd = e.cwd;
    if (e.gitBranch) meta.gitBranch = e.gitBranch;
    const r = e.toolUseResult;
    if (r && typeof r === 'object' &&
        (r.stderr || r.interrupted || (r.exitCode !== undefined && r.exitCode !== 0))) {
      const first = String(r.stderr || r.stdout || '').split('\n').find((l) => l.trim()) ?? '';
      entries.push({ kind: 'tool_error', ts: e.timestamp ?? null, exitCode: r.exitCode ?? null, line: first.slice(0, 400) });
    }
    if (e.isMeta === true) return;
    let text = promptText(e.message?.content);
    if (text == null) return;
    text = text.replace(WRAPPER_RE, '').trim();
    if (text) entries.push({ kind: 'prompt', ts: e.timestamp ?? null, text });
    return;
  }
  if (t === 'assistant') {
    const content = e.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        entries.push({ kind: 'assistant_text', ts: e.timestamp ?? null, text: b.text });
      } else if (b?.type === 'tool_use') {
        const input = b.input ?? {};
        entries.push({
          kind: 'tool_use', ts: e.timestamp ?? null, tool: b.name ?? '?',
          command: typeof input.command === 'string' ? input.command.slice(0, 300) : undefined,
          file: typeof input.file_path === 'string' ? input.file_path : undefined,
        });
      }
    }
    return;
  }
  if (!KNOWN_IGNORED.has(t)) meta.unknownTypes[t] = (meta.unknownTypes[t] ?? 0) + 1;
}
```

- [ ] **Step 4: Run tests, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: defensive transcript parser with entry classification"
```

---

### Task 5: Secret redaction — `skills/worklog/scripts/lib/redact.mjs`

**Files:**
- Create: `skills/worklog/scripts/lib/redact.mjs`
- Test: `tests/redact.test.mjs`

**Interfaces:**
- Produces: `redact(text) → { text, hits: string[] }` — typed visible markers `[REDACTED:<type>]`.

- [ ] **Step 1: Write the failing test**

```js
// tests/redact.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../skills/worklog/scripts/lib/redact.mjs';

test('known secret shapes get typed markers', () => {
  const cases = [
    ['AKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
    ['ghp_abcdefghijklmnopqrstuvwxyz012345', 'github-token'],
    ['?sv=2024&sig=abc123XYZ%2Fdef456ghi789jkl012', 'azure-sas'],
    ['Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'jwt'],
    ['password=Sup3rS3cretV4lue!', 'password-assign'],
    ['AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCD', 'connection-string'],
  ];
  for (const [input, type] of cases) {
    const { text, hits } = redact(`before ${input} after`);
    assert.ok(text.includes(`[REDACTED:${type}]`), `${type} in: ${text}`);
    assert.ok(hits.includes(type));
    assert.ok(!text.includes(input.slice(-12)), `${type} value leaked`);
  }
});

test('private key blocks redacted whole', () => {
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nqqq\n-----END RSA PRIVATE KEY-----';
  assert.ok(redact(key).text.includes('[REDACTED:private-key]'));
});

test('high-entropy long tokens redacted; prose and paths untouched', () => {
  const tok = 'x9KpQ2mVr8Tz4Wc7Yb1Nd6Fh3Jl5Sg0AeUiOpAsDfGhJk';
  assert.ok(redact(tok).text.includes('[REDACTED:high-entropy]'));
  const clean = 'Fixed the gluetun port sync in /repo/roles/media/tasks/main.yml using ansible-playbook site.yml';
  assert.equal(redact(clean).text, clean);
  assert.deepEqual(redact(clean).hits, []);
});
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**

```js
// skills/worklog/scripts/lib/redact.mjs
const PATTERNS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ['azure-sas', /\bsig=[A-Za-z0-9%+/=]{16,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/g],
  ['bearer', /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/g],
  ['connection-string', /\b(?:AccountKey|SharedAccessKey|sas_token)=[^;\s'"]{16,}/g],
  ['password-assign', /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*['"]?[^\s'"]{8,}/gi],
];

function shannon(s) {
  const f = {};
  for (const c of s) f[c] = (f[c] ?? 0) + 1;
  let h = 0;
  for (const n of Object.values(f)) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

export function redact(text) {
  const hits = [];
  let out = String(text);
  for (const [type, re] of PATTERNS) {
    out = out.replace(re, () => { hits.push(type); return `[REDACTED:${type}]`; });
  }
  out = out.replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, (m) => {
    if (m.includes('REDACTED')) return m;
    if (/^[a-z0-9/_.-]+$/.test(m)) return m;           // paths / plain lowercase identifiers
    if (shannon(m) <= 4.0) return m;
    hits.push('high-entropy');
    return '[REDACTED:high-entropy]';
  });
  return { text: out, hits };
}
```

- [ ] **Step 4: Run tests, verify pass.** Tune the JWT/entropy fixtures if a threshold misses — the test strings above are chosen to clear `shannon > 4.0`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: typed-marker secret redaction (patterns + entropy)"`

---

### Task 6: Evidence packs — `skills/worklog/scripts/lib/evidence.mjs`

**Files:**
- Create: `skills/worklog/scripts/lib/evidence.mjs`
- Test: `tests/evidence.test.mjs`

**Interfaces:**
- Consumes: `parseSession` output, `localDayOf` from dates, `redact`.
- Produces: `buildEvidencePacks(session, wantedDays, budget=100000) → pack[]`, one per `(sessionId, localDay)`:
  `{ sessionId, day, title, cwd, gitBranch, prLinks, firstTs, lastTs, prompts[], files[], commands[], errors[{exitCode,line}], assistant[], elided, note?, parseHealth }`

- [ ] **Step 1: Write the failing test**

```js
// tests/evidence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidencePacks } from '../skills/worklog/scripts/lib/evidence.mjs';

const meta = { sessionId: 's1', title: 'T', cwd: '/r', gitBranch: 'main', prLinks: [], unknownTypes: {}, skippedLines: 0 };

test('midnight-spanning session splits into one pack per local day', () => {
  const entries = [
    { kind: 'prompt', ts: '2026-06-18T22:30:00Z', text: 'before midnight (23:30 local)' },
    { kind: 'prompt', ts: '2026-06-18T23:30:00Z', text: 'after midnight (00:30 local next day)' },
  ];
  const packs = buildEvidencePacks({ meta, entries }, ['2026-06-18', '2026-06-19']);
  assert.deepEqual(packs.map((p) => p.day).sort(), ['2026-06-18', '2026-06-19']);
  assert.equal(packs.find((p) => p.day === '2026-06-19').prompts[0], 'after midnight (00:30 local next day)');
});

test('days outside wanted range are dropped; entries without ts are dropped', () => {
  const entries = [
    { kind: 'prompt', ts: '2026-07-10T10:00:00Z', text: 'in range' },
    { kind: 'prompt', ts: '2026-07-11T10:00:00Z', text: 'out of range' },
    { kind: 'prompt', ts: null, text: 'no timestamp' },
  ];
  const packs = buildEvidencePacks({ meta, entries }, ['2026-07-10']);
  assert.equal(packs.length, 1);
  assert.deepEqual(packs[0].prompts, ['in range']);
});

test('budget pressure drops assistant bulk first, keeps prompts and errors, sets elision marker', () => {
  const entries = [
    { kind: 'prompt', ts: '2026-07-10T10:00:00Z', text: 'the intent' },
    { kind: 'tool_error', ts: '2026-07-10T10:01:00Z', exitCode: 1, line: 'Error: the root cause' },
    ...Array.from({ length: 50 }, (_, i) => ({
      kind: 'assistant_text', ts: '2026-07-10T10:02:00Z', text: `bulk assistant text ${i} `.repeat(50),
    })),
  ];
  const packs = buildEvidencePacks({ meta, entries }, ['2026-07-10'], 5000);
  const p = packs[0];
  assert.ok(JSON.stringify(p).length <= 5000);
  assert.deepEqual(p.prompts, ['the intent']);
  assert.equal(p.errors[0].line, 'Error: the root cause');
  assert.equal(p.elided, true);
  assert.ok(p.note.includes('ELIDED'));
});

test('packs are redacted at build time', () => {
  const entries = [{ kind: 'prompt', ts: '2026-07-10T10:00:00Z', text: 'use key AKIAIOSFODNN7EXAMPLE now' }];
  const packs = buildEvidencePacks({ meta, entries }, ['2026-07-10']);
  assert.ok(packs[0].prompts[0].includes('[REDACTED:aws-access-key]'));
});

test('files and commands deduped from tool_use', () => {
  const entries = [
    { kind: 'tool_use', ts: '2026-07-10T10:00:00Z', tool: 'Edit', file: '/r/a.tf' },
    { kind: 'tool_use', ts: '2026-07-10T10:01:00Z', tool: 'Edit', file: '/r/a.tf' },
    { kind: 'tool_use', ts: '2026-07-10T10:02:00Z', tool: 'Bash', command: 'terraform apply' },
  ];
  const p = buildEvidencePacks({ meta, entries }, ['2026-07-10'])[0];
  assert.deepEqual(p.files, ['/r/a.tf']);
  assert.deepEqual(p.commands, ['terraform apply']);
});
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**

```js
// skills/worklog/scripts/lib/evidence.mjs
import { redact } from './redact.mjs';
import { localDayOf } from './dates.mjs';

const DEFAULT_BUDGET = 100_000;
const MAX_ERRORS = 50;
const ASSISTANT_SAMPLE = 6; // first N + last N assistant texts

const clean = (s) => redact(String(s)).text;

export function buildEvidencePacks(session, wantedDays, budget = DEFAULT_BUDGET) {
  const { meta, entries } = session;
  const wanted = new Set(wantedDays);
  const byDay = new Map();
  for (const e of entries) {
    const day = e.ts ? localDayOf(e.ts) : null;
    if (!day || !wanted.has(day)) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, dayEntries]) => buildPack(meta, day, dayEntries, budget));
}

function buildPack(meta, day, entries, budget) {
  const pack = {
    sessionId: meta.sessionId, day,
    title: meta.title, cwd: meta.cwd, gitBranch: meta.gitBranch, prLinks: meta.prLinks,
    firstTs: entries[0]?.ts ?? null, lastTs: entries.at(-1)?.ts ?? null,
    prompts: [], files: [], commands: [], errors: [], assistant: [],
    elided: false,
    parseHealth: { skippedLines: meta.skippedLines, unknownTypes: meta.unknownTypes },
  };
  const size = () => JSON.stringify(pack).length;

  // P1: all real prompts (ground truth of intent)
  for (const e of entries) if (e.kind === 'prompt') pack.prompts.push(clean(e.text));
  // P2: deduped files + commands from tool_use
  const files = new Set(), commands = new Set();
  for (const e of entries) {
    if (e.kind !== 'tool_use') continue;
    if (e.file) files.add(e.file);
    if (e.command) commands.add(clean(e.command));
  }
  pack.files = [...files];
  pack.commands = [...commands];
  // P3: error evidence
  for (const e of entries) {
    if (e.kind !== 'tool_error' || pack.errors.length >= MAX_ERRORS) continue;
    pack.errors.push({ exitCode: e.exitCode, line: clean(e.line) });
  }
  // P4: assistant text, first/last sampled, budget-gated
  const texts = entries.filter((e) => e.kind === 'assistant_text').map((e) => clean(e.text));
  const sampled = texts.length > ASSISTANT_SAMPLE * 2
    ? [...texts.slice(0, ASSISTANT_SAMPLE), '[…middle elided…]', ...texts.slice(-ASSISTANT_SAMPLE)]
    : texts;
  if (sampled.length < texts.length + (texts.length > ASSISTANT_SAMPLE * 2 ? 1 : 0)) pack.elided = true;
  for (const t of sampled) {
    if (size() + t.length > budget) { pack.elided = true; break; }
    pack.assistant.push(t);
  }
  // still over budget → shed lower-priority content, middle-out
  while (size() > budget && pack.assistant.length) { pack.assistant.pop(); pack.elided = true; }
  while (size() > budget && pack.commands.length) { pack.commands.pop(); pack.elided = true; }
  while (size() > budget && pack.prompts.length > 2) {
    pack.prompts.splice(Math.floor(pack.prompts.length / 2), 1);
    pack.elided = true;
  }
  if (pack.elided) pack.note = 'CONTENT ELIDED: evidence exceeded budget; middle/bulk content dropped';
  return pack;
}
```

- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: prioritized evidence-pack builder with per-day slicing and build-time redaction"`

---

### Task 7: Git evidence — `skills/worklog/scripts/lib/git.mjs`

**Files:**
- Create: `skills/worklog/scripts/lib/git.mjs`
- Test: `tests/git.test.mjs`

**Interfaces:**
- Produces: `collectGitEvidence(cwds: string[], { sinceISO, untilISO }) → [{ repo, author, commits: [{ sha, date, subject }] }]`
  - normalizes each cwd via `rev-parse --show-toplevel`, dedupes, skips dead/non-repo paths, per-repo `--author` from local git config, `--all --no-merges`.

- [ ] **Step 1: Write the failing test** (creates real temp git repos)

```js
// tests/git.test.mjs
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

const WIDE = { sinceISO: '2000-01-01T00:00:00+00:00', untilISO: '2100-01-01T00:00:00+00:00' };

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
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**

```js
// skills/worklog/scripts/lib/git.mjs
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function collectGitEvidence(cwds, { sinceISO, untilISO }) {
  const repos = new Set();
  for (const cwd of cwds) {
    if (!cwd || !existsSync(cwd)) continue;
    try { repos.add(git(['rev-parse', '--show-toplevel'], cwd)); } catch { /* not a repo */ }
  }
  const out = [];
  for (const repo of [...repos].sort()) {
    let author = '';
    try { author = git(['config', 'user.email'], repo); } catch { /* unset */ }
    if (!author) { try { author = git(['config', 'user.name'], repo); } catch { /* unset */ } }
    if (!author) continue;
    let log = '';
    try {
      log = git([
        'log', '--all', '--no-merges', `--author=${author}`,
        `--since=${sinceISO}`, `--until=${untilISO}`,
        '--date=iso-strict', '--pretty=%h%x09%ad%x09%s',
      ], repo);
    } catch { continue; }
    if (!log) continue;
    const commits = log.split('\n').map((l) => {
      const [sha, date, ...s] = l.split('\t');
      return { sha, date, subject: s.join('\t') };
    });
    out.push({ repo, author, commits });
  }
  return out;
}
```

- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: per-repo git evidence with author filter and --all branch coverage"`

---

### Task 8: Storage, digest cache & premerge — `skills/worklog/scripts/lib/store.mjs`

**Files:**
- Create: `skills/worklog/scripts/lib/store.mjs`
- Test: `tests/store.test.mjs`

**Interfaces:**
- Produces:
  - `SCHEMA_VERSION = 1`
  - `dataDir(env?) → path` — `$CCWORKLOG_DATA_DIR || $XDG_DATA_HOME/ccworklog || ~/.local/share/ccworklog`; creates `evidence/ digests/ reports/`.
  - `readConfig(base) → { open?, exclude_repos?, extra_repo_roots? }` (missing file → `{}`)
  - `writeJson(path, obj)` — pretty JSON + chmod 600
  - `digestKey({size, mtimeMs}) → 'size:mtime:v1'`; `isDigestValid(digestPath, transcriptStat) → bool` (checks stored `_key`)
  - `validateDigest(obj) → { ok, errors }` — items need claim+outcome; zero-anchor items get `low_confidence: true`; hard reject > 4096 chars (target ≤ 2000)
  - `premerge(base, days) → { workstreams, inputHash }` — groups digests by ticket-ID (regex `\b[A-Z][A-Z0-9]{1,9}-\d+\b` over branch + items) falling back to `project@branch`; deterministic ordering; sha256-based `inputHash`.

- [ ] **Step 1: Write the failing test**

```js
// tests/store.test.mjs
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

test('readConfig returns {} when missing, parses when present', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ccwd-'));
  const base = dataDir({ CCWORKLOG_DATA_DIR: join(tmp, 'ccw') });
  assert.deepEqual(readConfig(base), {});
  writeFileSync(join(base, 'config.json'), '{"open":"never"}');
  assert.equal(readConfig(base).open, 'never');
});
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**

```js
// skills/worklog/scripts/lib/store.mjs
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
  writeFileSync(path, JSON.stringify(obj, null, 1));
  try { chmodSync(path, 0o600); } catch { /* windows / exotic fs */ }
}

export function digestKey(stat) {
  return `${stat.size}:${Math.round(stat.mtimeMs)}:v${SCHEMA_VERSION}`;
}

export function isDigestValid(path, stat) {
  if (!existsSync(path)) return false;
  try { return JSON.parse(readFileSync(path, 'utf8'))._key === digestKey(stat); } catch { return false; }
}

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
    const hay = `${d.branch ?? ''} ${JSON.stringify(d.items ?? [])}`;
    const tickets = [...new Set([...hay.matchAll(TICKET_RE)].map((m) => m[1]))].sort();
    const key = tickets[0] || `${d.project ?? 'unknown'}@${d.branch ?? '-'}`;
    if (!groups.has(key)) {
      groups.set(key, { workstream: key, project: d.project ?? null, branch: d.branch ?? null, tickets, digests: [] });
    }
    groups.get(key).digests.push(d);
  }
  const workstreams = [...groups.values()].sort((a, b) => a.workstream.localeCompare(b.workstream));
  for (const w of workstreams) {
    w.digests.sort((a, b) => String(a.firstTs ?? '').localeCompare(String(b.firstTs ?? '')));
  }
  const inputHash = createHash('sha256').update(JSON.stringify(workstreams)).digest('hex').slice(0, 16);
  return { workstreams, inputHash };
}
```

- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: data store, digest cache keyed on transcript stat, workstream premerge"`

---

### Task 9: CLI entry — `skills/worklog/scripts/collect.mjs`

**Files:**
- Create: `skills/worklog/scripts/collect.mjs`
- Test: `tests/collect.test.mjs` (integration over a fixture corpus)

**Interfaces:**
- Consumes: every lib module.
- Produces (each prints one JSON object to stdout):
  - `node collect.mjs collect <range>` → manifest `{ label, days, sinceISO, untilISO, empty, packs: [{ sessionId, day, packPath, digestPath, digestValid, trivial, title }], packsToDigest, git: [...], parseHealth: { skippedLines, unknownTypes }, dataDir }`
    - writes evidence packs to `<dataDir>/evidence/<day>/<sessionId>.json`
    - `trivial` = fewer than 2 prompts; `digestPath` = `<dataDir>/digests/<sessionId>-<day>.json`; `digestValid` from transcript stat
    - each pack JSON gains `_digestKey` (the expected cache key) so subagents can stamp it into their digest
    - config `exclude_repos[]` filters sessions whose `cwd` starts with an excluded path; `extra_repo_roots[]` join git collection
  - `node collect.mjs premerge <range>` → `{ reduceInputPath, inputHash, invalidDigests: [{ digestPath, errors }] }` — writes `<dataDir>/reports/<label>.reduce-input.json`
  - `node collect.mjs purge <range>` → `{ removed: [paths] }`

- [ ] **Step 1: Write the failing integration test**

```js
// tests/collect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { makeCorpus } from './helpers/corpus.mjs';

const SCRIPT = 'skills/worklog/scripts/collect.mjs';
const T = (h) => `2026-07-15T${h}:00:00.000Z`;

function run(args, env) {
  return JSON.parse(execFileSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }));
}

function fixtureEnv() {
  const tmp = mkdtempSync(join(tmpdir(), 'ccwit-'));
  const claudeRoot = join(tmp, 'claude');
  makeCorpus(claudeRoot, [
    {
      project: '-repo-alpha', id: 'sess-1', sidechainFiles: 1,
      lines: [
        { type: 'ai-title', sessionId: 'sess-1', aiTitle: 'Fix terraform cycle' },
        { type: 'user', sessionId: 'sess-1', timestamp: T('09'), cwd: '/tmp', gitBranch: 'feat/PLAT-7',
          message: { content: 'fix the terraform cycle error' } },
        { type: 'user', sessionId: 'sess-1', timestamp: T('10'),
          message: { content: 'now add the outputs' } },
        { type: 'assistant', sessionId: 'sess-1', timestamp: T('10'),
          message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/main.tf' } }] } },
        { type: 'weird-future-type' },
      ],
    },
    { // trivial session: one prompt only
      project: '-repo-beta', id: 'sess-2',
      lines: [{ type: 'user', sessionId: 'sess-2', timestamp: T('11'), message: { content: 'quick question' } }],
    },
  ]);
  return {
    CLAUDE_CONFIG_DIR: claudeRoot,
    CCWORKLOG_DATA_DIR: join(tmp, 'data'),
  };
}

test('collect writes packs, flags trivial, reports parse health', () => {
  const env = fixtureEnv();
  const m = run(['collect', '2026-07-15'], env);
  assert.equal(m.empty, false);
  assert.equal(m.packs.length, 2);
  const p1 = m.packs.find((p) => p.sessionId === 'sess-1');
  assert.equal(p1.trivial, false);
  assert.equal(p1.digestValid, false);
  assert.equal(m.packs.find((p) => p.sessionId === 'sess-2').trivial, true);
  assert.equal(m.packsToDigest, 1);
  const pack = JSON.parse(readFileSync(p1.packPath, 'utf8'));
  assert.deepEqual(pack.prompts, ['fix the terraform cycle error', 'now add the outputs']);
  assert.equal(pack.title, 'Fix terraform cycle');
  assert.ok(pack._digestKey.includes(':v1'));
  assert.equal(m.parseHealth.unknownTypes['weird-future-type'], 1);
});

test('collect on an empty day short-circuits', () => {
  const env = fixtureEnv();
  const m = run(['collect', '2026-01-01'], env);
  assert.equal(m.empty, true);
  assert.deepEqual(m.packs, []);
});

test('premerge validates digests and writes reduce-input', () => {
  const env = fixtureEnv();
  const m = run(['collect', '2026-07-15'], env);
  const p1 = m.packs.find((p) => p.sessionId === 'sess-1');
  // simulate a digest subagent writing a valid digest
  const digest = {
    _key: JSON.parse(readFileSync(p1.packPath, 'utf8'))._digestKey,
    sessionId: 'sess-1', day: '2026-07-15', project: 'repo-alpha', branch: 'feat/PLAT-7', firstTs: T('09'),
    items: [{ claim: 'fixed cycle', outcome: 'Resolved terraform cycle in repo-alpha', evidence: { files: ['/repo/main.tf'] } }],
    loose_ends: [], findings: [],
  };
  const { writeFileSync } = await import('node:fs');
  writeFileSync(p1.digestPath, JSON.stringify(digest));
  const pm = run(['premerge', '2026-07-15'], env);
  assert.deepEqual(pm.invalidDigests, []);
  const ri = JSON.parse(readFileSync(pm.reduceInputPath, 'utf8'));
  assert.equal(ri.workstreams[0].workstream, 'PLAT-7');
  assert.equal(pm.inputHash.length, 16);
});

test('purge removes range artifacts', () => {
  const env = fixtureEnv();
  const m = run(['collect', '2026-07-15'], env);
  const out = run(['purge', '2026-07-15'], env);
  assert.ok(out.removed.length >= 1);
  assert.equal(existsSync(m.packs[0].packPath), false);
});
```

Note: `await import` inside a sync test — make the enclosing test callback `async`. Write it as `test('premerge…', async () => { … })` and use a top-level `import { writeFileSync } from 'node:fs'` instead; the plan shows the intent, the implementer uses the static import.

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**

```js
// skills/worklog/scripts/collect.mjs
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
```

- [ ] **Step 4: Run tests, verify pass** (fix the `await import` note from Step 1 — use static import).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: collect/premerge/purge CLI wiring the full deterministic pipeline"`

---

### Task 10: Render — `skills/worklog/scripts/render.mjs` + `skills/worklog/templates/report.html`

**Files:**
- Create: `skills/worklog/scripts/render.mjs`
- Create: `skills/worklog/templates/report.html`
- Test: `tests/render.test.mjs`

**Interfaces:**
- Consumes: a `report.json` (schema below) written by the REDUCE step at `<dataDir>/reports/<label>.report.json`.
- Produces: `node render.mjs <reportPath>` writes `<label>.html` + `<label>.standup.md` in the same directory, rewrites `<dataDir>/threads.json` from `report.threads.open`, prints the terminal recap (markdown) to stdout.

**`report.json` schema (REDUCE writes this; render + SKILL.md both depend on it):**

```json
{
  "label": "2026-07-15",
  "days": ["2026-07-15"],
  "inputHash": "abc123def4567890",
  "promptVersion": "v1",
  "standup": [{ "workstream": "PLAT-42", "project": "infra", "outcomes": ["…"] }],
  "personal": [{
    "workstream": "PLAT-42", "narrative": "started X, hit Y, resolved via Z",
    "items": [{ "claim": "…", "detail": "…", "evidence": { "files": [], "commands": [], "error_excerpt": "", "commit_shas": [], "pr_links": [] }, "low_confidence": false }]
  }],
  "alsoShipped": [{ "repo": "/path", "summary": "…", "commits": ["ab12cd Subject line"] }],
  "threads": { "open": [{ "id": "t-1", "text": "…", "repo": "", "firstSeen": "2026-07-14", "lastState": "…" }], "resolved": ["…"] },
  "timeline": [{ "day": "2026-07-15", "projects": ["infra"], "empty": false }],
  "footer": { "parseHealth": "skipped 3 lines; unknown types: none", "missedSessions": [] }
}
```

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement render.mjs**

```js
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
```

**Then the template** — one self-contained file, data injected as JSON, DOM built client-side. Complete file:

```html
<!-- skills/worklog/templates/report.html -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccworklog report</title>
<style>
  :root {
    --bg: #f7f7f5; --card: #ffffff; --ink: #1a1a18; --muted: #6b6b66;
    --accent: #b05730; --line: #e4e2dd; --ok: #3a7a4e; --warn: #a05a00;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #191917; --card: #22221f; --ink: #e8e6e1; --muted: #8f8d86;
            --accent: #d97b4f; --line: #33332e; --ok: #6fae83; --warn: #d19a4a; }
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--ink);
         font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
         max-width: 860px; margin: 0 auto; padding: 2.5rem 1.25rem 5rem; }
  h1 { font-size: 1.6rem; letter-spacing: -0.02em; }
  h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.1em;
       color: var(--muted); margin: 2.2rem 0 0.8rem; }
  .card { background: var(--card); border: 1px solid var(--line);
          border-radius: 10px; padding: 1.1rem 1.25rem; margin-bottom: 0.8rem; }
  .ws { font-weight: 650; color: var(--accent); }
  ul { padding-left: 1.2rem; } li { margin: 0.25rem 0; }
  details { margin-top: 0.5rem; border-top: 1px dashed var(--line); padding-top: 0.5rem; }
  summary { cursor: pointer; color: var(--muted); font-size: 0.85rem; }
  code, pre { font: 12.5px/1.5 ui-monospace, "SF Mono", Menlo, monospace;
              background: var(--bg); border-radius: 6px; }
  pre { padding: 0.6rem 0.8rem; overflow-x: auto; border: 1px solid var(--line); }
  .threads { border-left: 3px solid var(--warn); }
  .muted { color: var(--muted); font-size: 0.85rem; }
  .timeline td { padding: 0.3rem 0.9rem 0.3rem 0; vertical-align: top; }
  button.copy { float: right; background: var(--accent); color: #fff; border: 0;
                border-radius: 6px; padding: 0.35rem 0.8rem; cursor: pointer; font-size: 0.8rem; }
  footer { margin-top: 3rem; color: var(--muted); font-size: 0.8rem;
           border-top: 1px solid var(--line); padding-top: 0.8rem; }
</style>
</head>
<body>
<div id="app"></div>
<script id="data" type="application/json">__CCWORKLOG_DATA__</script>
<script>
const R = JSON.parse(document.getElementById('data').textContent);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const el = [];

el.push(`<h1>Worklog — ${esc(R.label)}</h1>`);
el.push(`<div class="muted">${R.days.length} day${R.days.length > 1 ? 's' : ''} · generated by ccworklog · 100% local</div>`);

const open = (R.threads && R.threads.open) || [];
if (open.length) {
  el.push('<h2>Open threads</h2><div class="card threads"><ul>');
  for (const t of open) el.push(`<li>${esc(t.text)} <span class="muted">(${esc(t.repo)}, since ${esc(t.firstSeen)} — ${esc(t.lastState)})</span></li>`);
  el.push('</ul></div>');
}

el.push('<h2>Standup — shareable</h2><div class="card">');
el.push('<button class="copy" onclick="copyStandup(this)">Copy as markdown</button><ul>');
for (const s of R.standup || []) for (const o of s.outcomes || [])
  el.push(`<li><span class="ws">${esc(s.workstream)}</span> — ${esc(o)}</li>`);
for (const a of R.alsoShipped || [])
  el.push(`<li><span class="ws">${esc(a.repo.split('/').pop())}</span> — ${esc(a.summary)} <span class="muted">(outside Claude Code)</span></li>`);
el.push('</ul></div>');

el.push('<h2>Detail — personal</h2>');
for (const p of R.personal || []) {
  el.push(`<div class="card"><div class="ws">${esc(p.workstream)}</div><p>${esc(p.narrative)}</p>`);
  for (const it of p.items || []) {
    const ev = it.evidence || {};
    el.push(`<details><summary>${esc(it.claim)}${it.low_confidence ? ' <em>(low confidence)</em>' : ''}</summary>`);
    if (it.detail) el.push(`<p>${esc(it.detail)}</p>`);
    if (ev.error_excerpt) el.push(`<pre>${esc(ev.error_excerpt)}</pre>`);
    if ((ev.files || []).length) el.push(`<p class="muted">files: ${ev.files.map(esc).join(' · ')}</p>`);
    if ((ev.commands || []).length) el.push(`<pre>${ev.commands.map(esc).join('\n')}</pre>`);
    if ((ev.commit_shas || []).length) el.push(`<p class="muted">commits: ${ev.commit_shas.map(esc).join(', ')}</p>`);
    if ((ev.pr_links || []).length) el.push(`<p class="muted">PRs: ${ev.pr_links.map(esc).join(' · ')}</p>`);
    el.push('</details>');
  }
  el.push('</div>');
}

if ((R.timeline || []).length > 1) {
  el.push('<h2>Timeline</h2><div class="card"><table class="timeline">');
  for (const d of R.timeline)
    el.push(`<tr><td class="muted">${esc(d.day)}</td><td>${d.empty ? '<span class="muted">no activity</span>' : esc((d.projects || []).join(', '))}</td></tr>`);
  el.push('</table></div>');
}

const missed = (R.footer && R.footer.missedSessions) || [];
el.push(`<footer>${esc((R.footer && R.footer.parseHealth) || '')}${missed.length ? ` · ⚠ ${missed.length} session(s) not digested — re-run /worklog` : ''}</footer>`);
document.getElementById('app').innerHTML = el.join('');

function copyStandup(btn) {
  const lines = [];
  for (const s of R.standup || []) for (const o of s.outcomes || []) lines.push(`- ${s.workstream}: ${o}`);
  for (const t of open.slice(0, 5)) lines.push(`- next: ${t.text}`);
  navigator.clipboard.writeText(lines.join('\n')).then(() => { btn.textContent = 'Copied ✓'; });
}
</script>
</body>
</html>
```

- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: deterministic renderer — HTML report, standup.md, terminal recap, threads persistence"`

---

### Task 11: The skill — `skills/worklog/SKILL.md`

**Files:**
- Create: `skills/worklog/SKILL.md`
- Test: `tests/skill.test.mjs` (structure checks; behavior is validated in Task 12 on real data)

**Interfaces:**
- Consumes: `collect.mjs` manifest/premerge JSON, `render.mjs`, `report.json` schema from Task 10.

- [ ] **Step 1: Write the failing test**

```js
// tests/skill.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('SKILL.md has required frontmatter and orchestration guardrails', () => {
  const s = readFileSync('skills/worklog/SKILL.md', 'utf8');
  assert.match(s, /^---\nname: worklog\n/);
  assert.match(s, /disable-model-invocation:\s*true/);
  assert.ok(s.includes('collect.mjs'));
  assert.ok(s.includes('render.mjs'));
  assert.ok(s.includes('AT MOST 4'));                 // concurrency cap
  assert.ok(s.includes('NEVER parse'));               // no model-improvised JSONL parsing
  assert.ok(s.includes('packsToDigest > 15'));        // cold-run confirmation
  assert.ok(s.includes('promptVersion'));             // reduce cache key
  assert.ok(s.toLowerCase().includes('verbatim'));    // anti-slop rule
});
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Write SKILL.md** (complete content):

````markdown
---
name: worklog
description: "Generate a daily or weekly work-summary report from your Claude Code sessions and git activity. Usage: /worklog [today|yesterday|week|lastweek|YYYY-MM-DD|YYYY-MM-DD..YYYY-MM-DD] [--fresh] — or /worklog purge <range>."
disable-model-invocation: true
---

# /worklog — daily/weekly work summary

You orchestrate a deterministic pipeline. NEVER parse `~/.claude` JSONL files yourself — all
transcript parsing is done by the bundled scripts. `SKILL_DIR` below means the directory
containing this file.

**Runtime check:** run `node --version`. If it fails or is < 18, tell the user
"ccworklog requires Node 18+ — https://nodejs.org" and STOP. Do not improvise a fallback.

## Pipeline

1. **Args.** Range = first non-flag argument, default `today`. Flag: `--fresh`.
   Subcommand `purge <range>`: run `node $SKILL_DIR/scripts/collect.mjs purge <range>`,
   report what was removed, STOP.

2. **Collect.** Run `node $SKILL_DIR/scripts/collect.mjs collect <range>`.
   Parse the JSON manifest from stdout.
   - If `manifest.empty` is true: print `No Claude Code activity or commits for <label>.`
     If `<dataDir>/threads.json` has open threads, append one line:
     `Open threads: N (oldest since <day>) — run /worklog <recent range> for details.` STOP.

3. **Cold-run gate.** If `manifest.packsToDigest > 15`: tell the user how many sessions
   need digesting and roughly how long it will take (~15–20s per batch of 4), note that
   digests are cached so an interrupted run loses nothing, and confirm with AskUserQuestion
   before proceeding.

4. **MAP.** For every pack with `digestValid: false` and `trivial: false` (manifest order
   is newest-first — keep it), spawn digest subagents with the Task tool in batches of
   AT MOST 4 concurrent, `subagent_type: general-purpose`, `model: haiku`. Use the Digest
   Prompt below. If a Task call fails, retry it ONCE; if it fails again, add the sessionId
   to a `missedSessions` list — never silently omit it.

5. **Premerge.** Run `node $SKILL_DIR/scripts/collect.mjs premerge <range>`.
   If `invalidDigests` is non-empty, re-digest those (once, batch ≤ 4), then re-run premerge.

6. **REDUCE.** Let `reportPath = <manifest.dataDir>/reports/<label>.report.json`.
   If `reportPath` exists AND its `inputHash` equals premerge's `inputHash` AND its
   `promptVersion` is `"v1"` AND `--fresh` was not passed → skip to step 7 (cached).
   Otherwise: read the reduce-input file, `<dataDir>/threads.json`, and `manifest.git`,
   then write `reportPath` following the Reduce Rules below.

7. **RENDER.** Run `node $SKILL_DIR/scripts/render.mjs <reportPath>`.
   Print its stdout (the terminal recap) to the user VERBATIM.

8. **Open.** Read `open` from `<dataDir>/config.json` (`always` | `never` | `weekly-only`;
   default `always`). If opening: macOS → `open <html>`; Linux → `xdg-open <html>`;
   WSL (`grep -qi microsoft /proc/version`) → `explorer.exe "$(wslpath -w <html>)"`.
   Failure is non-fatal — the path is already in the recap.

## Digest Prompt (per pack — substitute {PACK_PATH}, {DIGEST_PATH})

> Read the JSON file {PACK_PATH} — an evidence pack from one Claude Code session on one day
> (fields: prompts, files, commands, errors, assistant, title, gitBranch, prLinks, _digestKey).
> Write a digest JSON to {DIGEST_PATH} using the Write tool, then reply with exactly one line:
> `ok {DIGEST_PATH}`.
>
> Digest schema:
> `{ "_key": <copy _digestKey from the pack>, "sessionId", "day", "project" (last path segment
> of cwd), "branch" (gitBranch), "firstTs", "lastTs", "items": [ { "claim": <what was worked on>,
> "outcome": <ONE sentence, external standup framing — no internal noise, no credentials,
> config values, or hostnames>, "detail": <mechanism / root cause / how it was fixed>,
> "evidence": { "files": [paths], "commands": [key commands], "error_excerpt": <VERBATIM error
> text from the pack — never paraphrase>, "commit_shas": [], "pr_links": [from prLinks] } } ],
> "loose_ends": [<unfinished work, with file paths>], "findings": [<reusable discoveries>] }`
>
> Rules: every fact must come from the pack — never invent. Quote file paths and error text
> verbatim. If the pack has an elision note, add `"coverage": "partial"`. Keep the JSON under
> 2000 characters (hard limit 4096). 3–6 items for a busy session; 1 is fine for a small one.

## Reduce Rules

- One `standup`/`personal` entry per workstream in reduce-input (already grouped by
  ticket / repo+branch). MERGE multi-session work into ONE narrative arc
  ("started X, hit Y, resolved via Z") — never a flat per-session list.
- `standup[].outcomes` come ONLY from digest `outcome` fields. Copy `evidence` objects
  through UNTOUCHED into `personal[].items`.
- Fold git commits into their workstream (match repo/branch); leftovers → `alsoShipped`,
  grouped by repo, commit subjects summarized together.
- Threads: carry forward every open thread from `threads.json`; mark one resolved ONLY when
  this range's digests or commits plausibly resolve it (say why in `lastState`); append new
  threads from digest `loose_ends` as `{ id: "t-<next>", firstSeen: <day> }`.
- `timeline`: one row per day in the range (projects touched, `empty` flag).
- `footer.parseHealth` from manifest parse health; `footer.missedSessions` from step 4/5
  failures, with the sessions NAMED.
- Deterministic ordering: workstreams alphabetically, days ascending.
- Write the file with premerge's `inputHash` and `"promptVersion": "v1"`, matching the
  report.json schema in `docs/superpowers/plans/2026-07-15-ccworklog-v1.md` Task 10.
````

- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: /worklog skill orchestration (MAP/REDUCE rules, caching, rate-limit discipline)"`

---

### Task 12: README + real-session acceptance validation

**Files:**
- Modify: `README.md` (replace placeholder)
- No new tests — this task's "test" is the acceptance run on real data.

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: Write the full README**

```markdown
# ccworklog

**Daily/weekly work-summary reports from your Claude Code sessions and git activity.**

Claude Code deletes your transcripts after 30 days — ccworklog remembers.

<!-- screenshot: terminal recap + HTML report side by side (added post-acceptance-run) -->

## Install

```
/plugin marketplace add okaneconnor/ccworklog
/plugin install ccworklog
```

Then: `/worklog today` — it works retroactively on the session history already on your machine.

## What you get

- `/worklog [today|yesterday|week|lastweek|YYYY-MM-DD|A..B]`
- A paste-ready standup in your terminal, grouped by workstream (ticket / repo+branch)
- A styled, self-contained HTML report: shareable outcomes up top; your personal engineering
  log below — verbatim errors, root causes, the commands that fixed things, loose ends
- An open-threads ledger that carries unfinished work forward day to day
- Git commits folded in — including work done outside Claude Code sessions

## Privacy & cost

- **100% local. No API key. Zero network I/O** — verify: the scripts contain no fetch/http.
- Summarization runs on your existing Claude Code plan (a day is typically a handful of
  short subagent calls; big first-time backfills ask before running and are resumable).
- Reports can still contain sensitive content from your own sessions — review before sharing.
  Secret-shaped strings are redacted with typed markers at two boundaries. Repos can be
  excluded entirely via `exclude_repos` in config.

## Config (optional) — `~/.local/share/ccworklog/config.json`

```json
{
  "open": "always | never | weekly-only",
  "exclude_repos": ["/path/to/client-repo"],
  "extra_repo_roots": ["/path/to/repo-you-commit-to-outside-claude"]
}
```

`/worklog purge <range>` deletes stored evidence/digests/reports for a range.

## Requirements

- Claude Code (recent), Node ≥ 18, macOS / Linux / WSL

## License

MIT
```

- [ ] **Step 2: Full test suite green** — `npm test`, all tasks' tests pass.

- [ ] **Step 3: Acceptance run on real data (this machine).** Install the plugin locally (`/plugin marketplace add /Users/connorokane/Documents/repos/personal/ccworklog` or via dev symlink), then run `/worklog today` and `/worklog week` for the week of 2026-07-13 and verify each item:
  - Evening sessions land on the correct LOCAL day (UK timezone)
  - No subagent/sidechain sessions appear as separate work
  - Narrative is driven by prompts and errors, not tool stdout
  - Multi-session work on one ticket appears as ONE workstream arc
  - Git commits attributed correctly per repo identity
  - Second run of the same range is instant (reduce cache hit)
  - HTML renders correctly in light + dark, copy-standup works, no network requests
    (check browser devtools network tab)
  - The report is *genuinely useful* — Connor reads it and it matches his memory of the day
- [ ] **Step 4: Fix what the acceptance run surfaces** (expect transcript-format surprises; add regression fixtures for each fix).
- [ ] **Step 5: Screenshot for README, commit**

```bash
git add -A && git commit -m "docs: full README; v1 acceptance-validated on real sessions"
```

---

## Post-plan (not in v1 scope)

Marketplace submission, thread checkoff UI, `retention_days`, `report_dir` + `timezone` config overrides, Windows-native, scheduled runs — tracked in the spec's "out of scope" section.
