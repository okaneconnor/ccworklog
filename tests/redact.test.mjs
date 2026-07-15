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

test('SNAKE_CASE env assignments redact value, keep identifier', () => {
  const r = redact('export DB_PASSWORD=hunter2Secret! && AUTH_TOKEN=zQ8mPle2vRk9TdWc7Yb1Nf go');
  assert.ok(!r.text.includes('hunter2Secret!'));
  assert.ok(!r.text.includes('zQ8mPle2vRk9TdWc7Yb1Nf'));
  assert.ok(r.text.includes('DB_PASSWORD='));
  assert.ok(r.text.includes('[REDACTED:password-assign]'));
});

test('semicolon-delimited connection strings keep trailing fields', () => {
  const r = redact('Server=tcp:x.db.windows.net;User ID=admin;Password=P@ssw0rd123;Encrypt=true;');
  assert.ok(!r.text.includes('P@ssw0rd123'));
  assert.ok(r.text.includes('Encrypt=true'));
});

test('path values after secret-ish words are untouched', () => {
  const s = 'Updated k8s secret: infra/manifests/db-secret.yaml to rotate credentials';
  assert.equal(redact(s).text, s);
});

test('hashes and integrity strings are not entropy-redacted', () => {
  const sha = 'sha512-AbC123dEf456GhI789jKl012MnO345pQr678StU901vWx234yZa567';
  const hex = '0123456789ABCDEFabcdef0123456789ABCDEFabcdef';
  const r = redact(`integrity ${sha} and commit ${hex}`);
  assert.ok(r.text.includes(sha));
  assert.ok(r.text.includes(hex));
});

test('JWT with trailing dashes leaks no signature bytes', () => {
  const r = redact('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123xyz789QRS456tuv---');
  assert.ok(!r.text.includes('tuv---'));
});

test('typed markers are not relabeled by the generic pass', () => {
  const r = redact('Set token=ghp_abcdefghijklmnopqrstuvwxyz012345 in CI');
  assert.ok(r.text.includes('[REDACTED:github-token]'));
  assert.deepEqual(r.hits, ['github-token']);
});

test('ASIA STS keys are redacted', () => {
  assert.ok(redact('ASIAIOSFODNN7EXAMPLE').text.includes('[REDACTED:aws-access-key]'));
});
