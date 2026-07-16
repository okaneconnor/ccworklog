import { redact } from './redact.mjs';
import { localDayOf } from './dates.mjs';

const DEFAULT_BUDGET = 100_000;
const MAX_ERRORS = 50;
const ASSISTANT_SAMPLE = 6; // first N + last N assistant texts
const ELIDE_NOTE = 'CONTENT ELIDED: evidence exceeded budget; middle/bulk content dropped';
const ELIDE_MARKER = ' …[elided]';

const clean = (s) => redact(String(s)).text;
// Metadata fields may legitimately be null/undefined (parser defaults) — don't
// let clean() coerce them into the literal string "null".
const cleanNullable = (s) => (s == null ? s : clean(s));

// Sets elided + note together, atomically. This matters for the budget
// ceiling: `note` itself costs bytes, so every size() check performed after
// the first shed/truncate must already see it — otherwise appending the note
// as an afterthought (once, at the very end) can push a pack that measured
// exactly at budget back over it.
function markElided(pack) {
  pack.elided = true;
  pack.note = ELIDE_NOTE;
}

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

// Redact the string fields of each PR link (url, repo) without disturbing
// non-string fields like `number`.
function cleanPrLinks(prLinks) {
  if (!Array.isArray(prLinks)) return prLinks;
  return prLinks.map((pr) => {
    if (!pr || typeof pr !== 'object') return pr;
    return { ...pr, url: cleanNullable(pr.url), repo: cleanNullable(pr.repo) };
  });
}

// firstTs/lastTs are the min/max ts among the day's entries — never assume
// array order. Entries reaching here should already have a ts (upstream
// filtering drops ts-less entries), but guard nulls defensively anyway.
function tsRange(entries) {
  let firstTs = null, lastTs = null;
  for (const e of entries) {
    if (!e.ts) continue;
    if (firstTs === null || e.ts < firstTs) firstTs = e.ts;
    if (lastTs === null || e.ts > lastTs) lastTs = e.ts;
  }
  return { firstTs, lastTs };
}

// Shrinks the longest string in `arr` in place, appending ELIDE_MARKER.
// Returns false if no further progress is possible (arr empty, or its
// longest entry is already at/below the marker's own length).
function shrinkLongest(arr, overshoot) {
  let idx = -1, maxLen = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].length > maxLen) { maxLen = arr[i].length; idx = i; }
  }
  if (idx === -1) return false;
  const cur = arr[idx];
  const removeChars = Math.max(overshoot + ELIDE_MARKER.length, 1);
  const kept = cur.length > removeChars ? cur.slice(0, cur.length - removeChars) : '';
  const next = kept ? kept + ELIDE_MARKER : ELIDE_MARKER.trim();
  if (next.length >= cur.length) return false; // already minimal, no progress
  arr[idx] = next;
  return true;
}

// Sheds content under budget pressure in REVERSE priority order (least
// precious first): assistant → errors → commands/files → prompts (down to a
// floor of 2, middle-out). Anything shed sets pack.elided. As a final, hard
// guarantee, if list-shedding alone isn't enough, truncate the longest
// remaining prompt strings in place until the pack fits.
function shedForBudget(pack, budget, size) {
  while (size() > budget && pack.assistant.length) {
    pack.assistant.pop();
    markElided(pack);
  }
  while (size() > budget && pack.errors.length) {
    pack.errors.pop();
    markElided(pack);
  }
  while (size() > budget && (pack.commands.length || pack.files.length)) {
    if (pack.commands.length) pack.commands.pop();
    else pack.files.pop();
    markElided(pack);
  }
  while (size() > budget && pack.prompts.length > 2) {
    pack.prompts.splice(Math.floor(pack.prompts.length / 2), 1);
    markElided(pack);
  }
  // Final guarantee: truncate the longest remaining prompt strings in place.
  while (size() > budget) {
    if (!shrinkLongest(pack.prompts, size() - budget)) break;
    markElided(pack);
  }
  // (c) Assertion-style final check: it must be impossible to return a pack
  // over budget. This should be unreachable given the truncation above, but
  // flag it explicitly rather than silently letting an over-budget pack out.
  if (size() > budget) markElided(pack);
}

function buildPack(meta, day, entries, budget) {
  const { firstTs, lastTs } = tsRange(entries);
  const pack = {
    sessionId: meta.sessionId, day,
    title: cleanNullable(meta.title), cwd: cleanNullable(meta.cwd), gitBranch: cleanNullable(meta.gitBranch),
    prLinks: cleanPrLinks(meta.prLinks),
    firstTs, lastTs,
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
    if (e.file) files.add(clean(e.file));
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
  if (texts.length > ASSISTANT_SAMPLE * 2) pack.elided = true;
  for (const t of sampled) {
    if (size() + t.length > budget) { pack.elided = true; break; }
    pack.assistant.push(t);
  }
  // `note` costs bytes too — bake it into the pack as soon as we know we're
  // elided, so every size() check from here on (including inside
  // shedForBudget) already accounts for it. Without this, adding the note
  // as a pure afterthought can push a pack that measured exactly at budget
  // back over it.
  if (pack.elided) pack.note = ELIDE_NOTE;

  // still over budget → shed lower-priority content first, middle-out, then
  // guarantee the ceiling by truncating prompt strings in place.
  shedForBudget(pack, budget, size);

  return pack;
}
