const PATTERNS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['aws-access-key', /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ['azure-sas', /\bsig=[A-Za-z0-9%+/=]{16,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}(?![A-Za-z0-9_-])/g],
  ['bearer', /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/g],
  ['connection-string', /\b(?:AccountKey|SharedAccessKey|sas_token)=[^;\s'"]{16,}/g],
  ['password-assign', /([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|credential|api[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*\s*[=:]\s*['"]?)([^\s'";,[\]]{6,})/gi],
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
    if (type === 'password-assign') {
      out = out.replace(re, (match, prefix, value) => {
        if (value.includes('/')) return match;          // path values are not secrets here
        hits.push(type);
        return `${prefix}[REDACTED:${type}]`;
      });
    } else {
      out = out.replace(re, () => { hits.push(type); return `[REDACTED:${type}]`; });
    }
  }
  out = out.replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, (m) => {
    if (m.includes('REDACTED')) return m;
    if (/^[a-z0-9/_.-]+$/.test(m)) return m;           // paths / plain lowercase identifiers
    if (/^(?:sha256|sha384|sha512)-/.test(m)) return m; // integrity strings (SRI)
    if (/^[0-9a-fA-F]+$/.test(m)) return m;             // pure hex (hashes, commit SHAs)
    if (shannon(m) <= 4.0) return m;
    hits.push('high-entropy');
    return '[REDACTED:high-entropy]';
  });
  return { text: out, hits };
}
