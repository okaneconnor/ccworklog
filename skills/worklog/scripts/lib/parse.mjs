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
    if (e.isMeta === true) return;
    if (e.cwd && !meta.cwd) meta.cwd = e.cwd;
    if (e.gitBranch) meta.gitBranch = e.gitBranch;
    const r = e.toolUseResult;
    if (r && typeof r === 'object') {
      const failed = r.interrupted === true
        || (r.exitCode !== undefined && r.exitCode !== null && r.exitCode !== 0)
        || (r.exitCode === undefined && typeof r.stderr === 'string'
            && /\b(error|fatal|exception|traceback|denied|refused)\b/i.test(r.stderr));
      if (failed) {
        const first = String(r.stderr || r.stdout || '').split('\n').find((l) => l.trim()) ?? '';
        entries.push({ kind: 'tool_error', ts: e.timestamp ?? null, exitCode: r.exitCode ?? null, line: first.slice(0, 400) });
      }
    }
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
