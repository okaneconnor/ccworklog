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
