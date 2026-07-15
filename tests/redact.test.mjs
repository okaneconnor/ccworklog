import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../skills/worklog/scripts/lib/redact.mjs';

test('known secret shapes get typed markers', () => {
  const cases = [
    ['AKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
    ['ghp_abcdefghijklmnopqrstuvwxyz012345', 'github-token'],
    ['?sv=2024&sig=abc123XYZ%2Fdef456ghi789jkl012', 'azure-sas'],
    ['Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'jwt'],
    ['password=Sup3rS3cretV4lue!', 'password-assign'],
    ['AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCD', 'connection-string'],
  ];
  for (const [input, type] of cases) {
    const { text, hits } = redact(`before ${input} after`);
    assert.ok(text.includes(`[REDACTED:${type}]`), `${type} in: ${text}`);
    assert.ok(hits.includes(type));
    assert.ok(!text.includes(input.slice(-12)), `${type} value leaked`);
  }
});

test('private key blocks redacted whole', () => {
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nqqq\n-----END RSA PRIVATE KEY-----';
  assert.ok(redact(key).text.includes('[REDACTED:private-key]'));
});

test('high-entropy long tokens redacted; prose and paths untouched', () => {
  const tok = 'x9KpQ2mVr8Tz4Wc7Yb1Nd6Fh3Jl5Sg0AeUiOpAsDfGhJk';
  assert.ok(redact(tok).text.includes('[REDACTED:high-entropy]'));
  const clean = 'Fixed the gluetun port sync in /repo/roles/media/tasks/main.yml using ansible-playbook site.yml';
  assert.equal(redact(clean).text, clean);
  assert.deepEqual(redact(clean).hits, []);
});
