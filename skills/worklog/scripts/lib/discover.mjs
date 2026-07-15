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
