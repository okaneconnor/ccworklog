// The mod's model prompts. They mirror skills/worklog/SKILL.md (the fallback
// path where mods are off), changed only to reply with JSON instead of writing
// a file: the mod saves the reply through scripts/save.mjs.

export const DIGEST_MODEL = 'haiku'
export const REDUCE_MODEL = 'sonnet'

export const DIGEST_SYSTEM =
  'You turn one Claude Code session evidence pack into a compact JSON digest. Reply with the JSON object only: no prose, no code fence.'

export const digestPrompt = (pack: string): string => `SIZE IS A BINDING CONSTRAINT: total digest JSON under 3000 characters (hard reject over 6000). For busy sessions: up to 8 items, one-sentence details, at most 2 file paths per evidence block. Cut detail before cutting items.

Below is an evidence pack from one Claude Code session on one day (fields: prompts, files, commands, errors, assistant, title, cwd, gitBranch, prLinks, sessionId, day, firstTs, lastTs).

Digest schema:
{ "project" (last path segment of cwd), "branch" (gitBranch), "firstTs", "lastTs", "items": [ { "claim": <what was worked on>, "outcome": <ONE sentence, external standup framing — no internal noise, no credentials, config values, or hostnames>, "detail": <mechanism / root cause / how it was fixed>, "evidence": { "files": [paths], "commands": [key commands], "error_excerpt": VERBATIM error text from the pack, at most the first 300 characters — append ' …(truncated)' if cut. Verbatim means never paraphrase what you include; truncation is allowed, rewording is not., "commit_shas": [], "pr_links": [from prLinks] } } ], "loose_ends": [<unfinished work, with file paths>], "findings": [<reusable discoveries>] }

Rules: every fact must come from the pack — never invent. Quote file paths and error text verbatim. If the pack has an elision note, add "coverage": "partial". Up to 8 items for a busy session; 1 is fine for a small one.

<pack>
${pack}
</pack>`

export const REDUCE_SYSTEM =
  'You merge per-session digests into one work report as JSON. Reply with the JSON object only: no prose, no code fence.'

export const reducePrompt = (input: {
  reduceInput: string
  threads: string
  parseHealth: string
  missed: readonly string[]
}): string => `Write the report.json for the range in <reduce-input>, following these rules.

- One standup/personal entry per workstream in reduce-input (already grouped by ticket / repo+branch). MERGE multi-session work into ONE narrative arc ("started X, hit Y, resolved via Z") — never a flat per-session list.
- standup[].outcomes come ONLY from digest outcome fields. Copy evidence objects through UNTOUCHED into personal[].items.
- Fold git commits (reduce-input's git field) into their workstream (match repo/branch): set personal[].commits to the matched commits as "<short-sha> <subject>" strings (chronological, cap 30, then one "+N more" entry). Leftovers → alsoShipped, grouped by repo, commit subjects summarized together.
- Threads: carry forward every open thread from <threads>; mark one resolved ONLY when this range's digests or commits plausibly resolve it (say why in lastState); append new threads from digest loose_ends as { id: "t-<next>", firstSeen: <day> }.
- timeline: one row per day in the range (projects touched, empty flag).
- footer.parseHealth: ONE human-readable sentence from <parse-health> (not an object). footer.missedSessions: exactly the session ids in <missed>.
- Deterministic ordering: workstreams alphabetically, days ascending.

Schema:
{ "days": ["2026-07-15"], "standup": [{ "workstream": "PLAT-42", "project": "infra", "outcomes": ["…"] }], "personal": [{ "workstream": "PLAT-42", "narrative": "started X, hit Y, resolved via Z", "commits": ["ab12cd Subject line", "+3 more"], "items": [{ "claim": "…", "detail": "…", "evidence": { "files": [], "commands": [], "error_excerpt": "", "commit_shas": [], "pr_links": [] }, "low_confidence": false }] }], "alsoShipped": [{ "repo": "/path", "summary": "…", "commits": ["ab12cd Subject line"] }], "threads": { "open": [{ "id": "t-1", "text": "…", "repo": "", "firstSeen": "2026-07-14", "lastState": "…" }], "resolved": ["…"] }, "timeline": [{ "day": "2026-07-15", "projects": ["infra"], "empty": false }], "footer": { "parseHealth": "…", "missedSessions": [] } }

<reduce-input>
${input.reduceInput}
</reduce-input>

<threads>
${input.threads}
</threads>

<parse-health>
${input.parseHealth}
</parse-health>

<missed>
${JSON.stringify(input.missed)}
</missed>`
