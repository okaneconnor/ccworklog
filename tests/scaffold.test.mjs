import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('plugin.json is valid and named ccworklog', () => {
  const p = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
  assert.equal(p.name, 'ccworklog');
  assert.match(p.version, /^\d+\.\d+\.\d+$/);
  assert.ok(p.description.length > 20);
});

test('marketplace.json points at this repo root', () => {
  const m = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'));
  assert.equal(m.name, 'ccworklog');
  assert.equal(m.plugins[0].name, 'ccworklog');
  assert.equal(m.plugins[0].source, './');
});

test('package.json declares zero dependencies', () => {
  const p = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(p.dependencies, undefined);
  assert.equal(p.devDependencies, undefined);
  assert.equal(p.type, 'module');
});
