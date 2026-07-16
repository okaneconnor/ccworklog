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
