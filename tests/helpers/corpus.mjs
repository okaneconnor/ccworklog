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
