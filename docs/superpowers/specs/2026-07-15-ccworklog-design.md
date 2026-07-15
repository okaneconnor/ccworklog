# ccworklog — Design Spec

**Date:** 2026-07-15
**Status:** Approved
**Repo:** `okaneconnor/ccworklog` (public release planned)

## Problem

Heavy Claude Code users work across many repos, tickets, and troubleshooting threads per day. At end of day (or week) they cannot reliably recall what they did, what broke, what fixed it, and what's still open. Claude Code deletes session transcripts after 30 days (`cleanupPeriodDays`), so this history is also perishable.

Nothing built into Claude Code produces a cross-session daily/weekly work narrative (`/recap` is single-session and ephemeral; `/insights` is a workflow-friction audit; `/usage` is counts only). Popular community tools (ccusage ~13k★) are cost dashboards; the few work-narrative tools (vibe-log-cli 337★, engineering-notebook 229★) require separate API keys or capture hooks and have stalled.

## What we're building

A public Claude Code **plugin** providing a `/worklog` slash command that mines local session transcripts + git activity and produces a daily or weekly work-summary report. 100% local; no API key; no network I/O; uses the user's existing Claude Code plan as the summarization engine; works retroactively on existing history from first install.

### Command surface

```
/worklog                     # today (default)
/worklog yesterday           # previous local calendar day
/worklog week                # current ISO week, Monday → now
/worklog lastweek            # previous full Monday–Sunday
/worklog 2026-07-10          # specific day
/worklog 2026-07-01..2026-07-07   # inclusive range
/worklog ... --fresh         # bypass reduce cache, regenerate narrative
/worklog purge [range]       # delete stored evidence/digests/reports for range
```

All date semantics use **local calendar days** (local midnight boundaries). Transcript timestamps are UTC ISO and MUST be converted to the system timezone via the runtime's tz machinery (`Date`/`Intl`) — never hand-rolled offsets (DST). A session spanning local midnight belongs to **every** local day it touches, with its entries sliced per day.

### Outputs

1. **Terminal recap** (in-chat): paste-ready standup in plain markdown — outcomes grouped by workstream — plus open-threads count and the absolute path to the HTML report. Must stand alone as a complete deliverable (no-browser environments).
2. **HTML report** — fully self-contained (inline CSS/JS, no CDN/network), light/dark aware, saved to the reports dir:
   - **Standup section** (shareable): outcome lines per workstream, built ONLY from digest `outcome` fields — never raw evidence.
   - **Personal section** (memory aid): per-workstream narrative arcs with expandable evidence blocks — verbatim error excerpts, root causes, commands that fixed things, file paths, commit SHAs.
   - **Open threads** panel at top: carried-forward loose ends with last-known state and age.
   - Weekly mode: per-project timeline across days; empty days render as compact "no activity" rows.
   - Copy-standup-to-clipboard button.
   - Footer: parse health ("skipped N entries; unknown types: X"), sessions not digested (rate limits) with instruction to re-run.
3. **`standup.md`** written next to the HTML.

Auto-open of the HTML is config-controlled: `open: always | never | weekly-only`, default `always` for daily / platform-dispatched (`open` / `xdg-open` / WSL detection via `/proc/version` → `explorer.exe` with path translation). Open failure is non-fatal; the path is always printed last.

## Architecture: COLLECT → GIT → MAP → REDUCE → RENDER

Implemented as a plugin **skill** (`skills/worklog/SKILL.md`, `disable-model-invocation: true` — user-invoked only). The skill orchestrates; a bundled deterministic script does all parsing.

### 1. COLLECT — `scripts/collect.mjs` (deterministic, zero deps)

**Runtime:** Node ≥ 18 only. Probe `node --version` (verify it executes); if absent, print one actionable install instruction and stop. No python fallback (single parser = single set of bugs; ccusage proves the Node requirement is acceptable to this audience). The model must NEVER fall back to improvising raw JSONL scans.

**Discovery:**
- Transcript root: `$CLAUDE_CONFIG_DIR || ~/.claude`, scan `projects/*/*.jsonl` (non-recursive within each project dir).
- **Exclude explicitly:** any file whose basename matches `agent-*.jsonl` or whose path contains `/subagents/`; additionally drop any entry with `isSidechain: true` regardless of file. (Observed: 17MB of a 58MB corpus is subagent sidechains — including them double-counts work.)
- **mtime prefilter:** skip files with mtime older than range-start without opening them.
- Never derive filesystem paths from the mangled project dir name (lossy encoding); always use entries' `cwd` field.
- Group entries strictly by top-level `sessionId`. Follow `parentUuid` continuation links where present to associate resumed/forked session files into one logical session.

**Parsing (defensive, unknown-by-default):**
- Per-line try/catch; per-session try/catch (one corrupt file must not kill the run). Every field access optional.
- Allowlist-extract only needed types: `user`, `assistant`, `system`, `ai-title`, `pr-link`. Count and skip unknown types; report counts in footer. (Observed corpus spans 17 Claude Code versions with types beyond the documented set: `permission-mode`, `pr-link`, `agent-name`, `queue-operation`.)
- Untimestamped session-scoped entries (`ai-title`, `last-prompt`) associate by `sessionId`, not time.
- **User-entry classification** (critical — 82% of `user`-type entries are tool_result carriers, not prompts):
  - Keep as prompt: content is a plain string, or text blocks containing no `tool_result` block.
  - Drop: `isMeta: true`; strip `<command-*>` / `<local-command-*>` / `<system-reminder>` wrappers.
  - NEVER take tool output from user message content. Errors come from the structured top-level `toolUseResult` (exit status + first error line only).
- Commands and file paths come from assistant `tool_use` blocks (`input.command`, `input.file_path`) — small and structured.
- Harvest `pr-link` entries (`prUrl`, `prNumber`, `prRepository`) as structured "delivered" signals.

**Evidence packs** — one per `(sessionId, localDay)`, target ≤ 100KB, built by **prioritized extraction** (never naive truncation), fill order:
1. All real user prompts (ground truth of intent; cheap — 498 across a 58MB corpus).
2. `ai-title`, PR links, git-relevant tool_use inputs (file paths, commands).
3. Error evidence: `toolUseResult` first error lines / stderr signatures / non-zero exits.
4. Assistant text sampled first-and-last per turn; if over budget keep first and final thirds with explicit elision markers so the digest agent knows content was cut.

Bulky successful tool output (file reads, passing test logs) is dropped first and never included beyond first-error-line — this exclusion is **structural**, not regex.

**Redaction at pack build time** (before persistence, before any model sees it): known-prefix secret patterns + entropy heuristic on long tokens → typed visible markers (`[REDACTED:azure-sas]`). Redaction also re-applied at final render over all output surfaces including git-sourced text.

Evidence packs are **persisted permanently** in the data dir — they are the archive that outlives Claude Code's 30-day transcript deletion. Digests are a cache over them.

### 2. GIT collection (inside collect.mjs)

- For each unique session `cwd` in range: `git -C <cwd> rev-parse --show-toplevel`; dedupe repos on toplevel (fixes monorepo subdir multiplication); skip non-existent paths and non-repos silently.
- Per repo: author filter from `git -C <root> config user.email` (fallback `user.name`) — identities differ per repo.
- `git log --all --no-merges --author=<email> --since/--until` with local-midnight ISO instants **with offset** so git and transcript filtering agree exactly.
- Config may add extra repo roots (work done outside Claude Code sessions).

### 3. MAP — parallel digest subagents

- One subagent per evidence pack, cheap/fast model, **concurrency ≤ 4** (subscription rate-limit protection).
- Skip trivial packs (< 2 real user prompts) without spawning.
- Digest = structured JSON, hard ~2KB cap, schema-validated by the collector:
  ```json
  {
    "project": "...", "branch": "...", "day": "2026-07-15",
    "items": [{
      "claim": "...",
      "outcome": "one line, external framing, shareable",
      "detail": "mechanism/root cause, internal",
      "evidence": {
        "files": [], "commands": [],
        "error_excerpt": "verbatim, redacted",
        "commit_shas": [], "pr_links": []
      }
    }],
    "loose_ends": [], "findings": []
  }
  ```
  Subagents quote errors/paths verbatim (never paraphrase); items with zero evidence anchors get flagged low-confidence. Subagents write digests to disk and return only a path + status ack (context discipline).
- **Cache key:** transcript file `(size, mtime)` + `schema_version` + `prompt_hash`. Session grew → re-digest. Digests are per `(sessionId, localDay)` so resumed-across-days sessions can't leak work into the wrong day.
- **Cold-run UX:** before a large backfill, print the plan ("62 sessions to digest, ~4 min, uses your Claude Code plan") and stream progress. Interrupted runs lose nothing (per-session cache). Digest newest-first so partial runs cover the most relevant days. Rate-limited sessions are named in the report footer — never silently omitted.

### 4. REDUCE — main-agent synthesis

- Collector pre-merges digests into one bounded reduce-input file grouped by workstream: key = `(repo, branch)` + ticket IDs extracted from branch names / commit messages.
- The narrative merges cross-session work into one thread with a progression arc ("started X, hit Y, resolved via Z") — never a flat list of session summaries. Weekly = rollup by project with per-day timeline.
- Git-only commits fold into the matching project narrative as supporting evidence; truly orphaned commits get one compact "Also shipped (outside Claude Code)" list.
- `outcome` fields → standup section; `detail`/`evidence` → personal section. REDUCE may rewrite narrative prose but passes evidence fields through untouched.
- **Determinism:** reduce output cached by `(range, sorted digest hashes, git commit set, prompt_version)`. Same inputs → identical report byte-for-byte (9am standup re-run is instant and free). `--fresh` forces regeneration. Deterministic ordering everywhere (sessions by start time, projects alphabetically).
- **Empty range short-circuit:** zero sessions AND zero commits → one terminal line + open-threads reminder; no subagents, no HTML, no browser.

### 5. Open-threads ledger — `threads.json`

- Loose ends persist across reports until a later session/commit in the same repo plausibly resolves them (resolution judged during REDUCE with the new day's digests in context).
- Every report opens with "Open threads (N, oldest Xd)" + last-known state + file paths.
- v1: read-only in HTML (checkoff UI deferred).

## Data locations

App-owned data dir — **never** write inside `~/.claude` (Anthropic's namespace):

- macOS/Linux: `~/.local/share/ccworklog/` (respect `$XDG_DATA_HOME`)
- Layout: `evidence/`, `digests/`, `reports/`, `threads.json`, `config.json`
- All files `chmod 600`.

`config.json` (all optional): `extra_repo_roots[]`, `exclude_repos[]` (deny-list — client-confidential repos never enter reports), `open` mode, `report_dir` override, `retention_days` (default: keep forever, documented prominently), `timezone` override.

## Privacy & safety model

1. **Structural exclusion first:** raw tool stdout, file-read results, and grep results never enter evidence packs beyond first error lines. The shareable standup is built only from `outcome` fields.
2. **Redaction second:** typed-marker redactor at pack build AND final render.
3. **User control:** per-repo deny-list; `purge` subcommand; everything local; zero network I/O in all scripts (verifiable — no fetch/http in source); HTML fully inlined.
4. README states plainly: reports may still contain sensitive content — review before sharing.

## Packaging & repo layout

```
ccworklog/
├── .claude-plugin/
│   ├── plugin.json              # name, version, description (privacy posture stated)
│   └── marketplace.json         # instant install: /plugin marketplace add okaneconnor/ccworklog
├── skills/worklog/
│   ├── SKILL.md                 # /worklog command; disable-model-invocation: true
│   ├── scripts/collect.mjs      # zero-dep Node ≥ 18
│   └── templates/report.html
├── tests/
│   ├── fixtures/                # golden transcripts across CC versions; includes subagents/ dir,
│   │                            # midnight-spanning session, tool_result-heavy session, unknown types
│   └── collect.test.mjs         # node:test, runs against fixtures
├── docs/superpowers/specs/
├── README.md
└── LICENSE                      # MIT
```

**README first screen (in order):** screenshot/GIF (terminal recap + HTML report) → install (2 lines: `/plugin marketplace add okaneconnor/ccworklog`, `/worklog today` — works on history you already have) → privacy/cost line ("100% local, no API key, no network; uses your existing Claude Code plan") → requirements (Claude Code ≥ min version, Node ≥ 18) → tagline hook: *"Claude Code deletes your transcripts after 30 days — ccworklog remembers."*

Post-v1: submit to Anthropic community marketplace (platform.claude.com/plugins/submit).

## Testing & validation

1. **Fixture tests** (`node --test`): entry classification (prompt vs tool_result carrier), sidechain exclusion, timezone bucketing incl. midnight-spanning + DST fixtures, evidence-pack prioritization under budget pressure, digest schema validation, cache invalidation on (size, mtime) change, redaction patterns, unknown-type tolerance.
2. **Real-data validation on this machine (acceptance gate):** run `/worklog` against Connor's own sessions — today's sessions and the rest of this week — and verify: work attribution is correct per day, no subagent double-counting, prompts (not stdout) drive the narrative, evening sessions land on the right local day, git commits attributed correctly per repo identity, report renders and reads as genuinely useful. This validation on real sessions is part of v1 acceptance, not an afterthought.
3. Schema-drift posture: parse-health footer + golden fixtures; a CI job generating fresh transcripts via headless `claude -p` is deferred post-v1.

## Explicitly out of scope for v1

- Thread checkoff UI in the HTML (ledger is read-only v1)
- Native Windows (macOS/Linux/WSL first; Windows paths handled where cheap)
- Scheduled/automatic runs; SessionEnd hooks
- Posting to Slack/Teams/Confluence
- sessions-index.json optimization (mtime prefilter suffices)

## Key risks & mitigations

| Risk | Mitigation |
|---|---|
| Transcript schema drift breaks parsing | Unknown-by-default parser, per-line/per-session isolation, parse-health footer, golden fixtures |
| Anthropic ships a native equivalent | Cheap build; personal value stands; evidence archive + threads ledger differentiate |
| Reports leak secrets | Structural exclusion + typed redaction at two boundaries + deny-list + local-only |
| Rate-limit exhaustion on big backfills | Estimate + confirm, concurrency ≤ 4, cheap model, resumable cache, named gaps in footer |
| Generic AI-slop output | Evidence-anchored digest schema, verbatim quoting, workstream clustering, low-confidence flagging |
