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

- Claude Code (recent), Node ≥ 18, git ≥ 2.37, macOS / Linux / WSL

## License

MIT
