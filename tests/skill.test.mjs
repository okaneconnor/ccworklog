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
  assert.ok(s.includes('STILL invalid after that one retry'));
  assert.ok(s.includes('first 300 characters'));
  assert.ok(s.includes('If the user declines, STOP'));
  assert.ok(s.includes('SIZE IS A BINDING CONSTRAINT'));
});

test('SKILL.md carries the final-review wave guardrails', () => {
  const s = readFileSync('skills/worklog/SKILL.md', 'utf8');
  assert.ok(s.includes('--update-threads'));                     // threads ledger guard
  assert.ok(s.includes('ONLY when step 6 actually ran REDUCE')); // flag only on cache miss / --fresh
  assert.ok(s.includes('NOT use `manifest.git`'));               // git comes from reduce-input
  assert.ok(s.includes('"promptVersion": "v1"'));                // schema inlined…
  assert.ok(s.includes('"alsoShipped"'));
  assert.ok(s.includes('"missedSessions"'));
  assert.ok(!s.includes('docs/superpowers/plans'));              // …not referenced externally
  assert.ok(s.includes('ONE human-readable sentence'));          // parseHealth shape rule
});
