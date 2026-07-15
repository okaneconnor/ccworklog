const PATTERNS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ['azure-sas', /\bsig=[A-Za-z0-9%+/=]{16,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/g],
  ['bearer', /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/g],
  ['connection-string', /\b(?:AccountKey|SharedAccessKey|sas_token)=[^;\s'"]{16,}/g],
  ['password-assign', /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*['"]?[^\s'"]{8,}/gi],
];

function shannon(s) {
  const f = {};
  for (const c of s) f[c] = (f[c] ?? 0) + 1;
  let h = 0;
  for (const n of Object.values(f)) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

export function redact(text) {
  const hits = [];
  let out = String(text);
  for (const [type, re] of PATTERNS) {
    out = out.replace(re, () => { hits.push(type); return `[REDACTED:${type}]`; });
  }
  out = out.replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, (m) => {
    if (m.includes('REDACTED')) return m;
    if (/^[a-z0-9/_.-]+$/.test(m)) return m;           // paths / plain lowercase identifiers
    if (shannon(m) <= 4.0) return m;
    hits.push('high-entropy');
    return '[REDACTED:high-entropy]';
  });
  return { text: out, hits };
}
