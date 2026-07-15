// Path-shape guard (Defect 1, round 3): a value only counts as "path, not a
// secret" if it is shaped like one — all-lowercase path charset. Mixed-case
// or symbol-bearing values (e.g. base64 from `openssl rand`) still redact
// even when they happen to contain a `/`.
const PATH_SHAPE_RE = /^[a-z0-9._/-]+$/;

// Keyword must terminate the identifier (optional trailing `s`) for the
// `:`-form (YAML/prose) to even be considered — `password:`, `db_password:`,
// `AUTH_TOKEN:`, `credentials:` qualify; `tokenExpiry:` does not, because the
// keyword is not at the end.
const KEYWORD_SUFFIX_RE = /(?:password|passwd|pwd|secret|token|credential|api[_-]?key|access[_-]?key)s?$/i;

const PATTERNS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['aws-access-key', /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ['azure-sas', /\bsig=[A-Za-z0-9%+/=]{16,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}(?![A-Za-z0-9_-])/g],
  ['bearer', /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/g],
  ['connection-string', /\b(?:AccountKey|SharedAccessKey|sas_token)=[^;\s'"]{16,}/g],
  // Captures identifier / separator / whitespace / optional-quote / value separately so
  // the callback can treat `=` (env/config) and `:` (YAML/prose) differently.
  ['password-assign', /([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|credential|api[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)\s*([=:])(\s*)(['"]?)([^\s'";,[\]`]{6,})/gi],
];

function shannon(s) {
  const f = {};
  for (const c of s) f[c] = (f[c] ?? 0) + 1;
  let h = 0;
  for (const n of Object.values(f)) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

// "Secret-shaped" heuristic for the `:` form only. Spec: (digit AND a
// character outside [a-z-]) OR (a symbol other than -). A digit is itself
// outside [a-z-], so the first clause reduces to "has a digit"; the second
// clause catches symbol-bearing values (e.g. `P@ssword!`) even without one.
// Plain words like `regcred` / `rotated` / `db-credentials` have neither and
// are spared. Exempt version strings (v1.2.3) and ISO dates (2026-07-16T...).
function looksSecretShaped(value) {
  // Versions: v1.2.3, 1.2.3, etc.
  if (/^v?\d+(?:\.\d+)+$/.test(value)) return false;
  // ISO dates: 2026-07-16, 2026-07-16T10:00:00Z, etc.
  if (/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/.test(value)) return false;

  const hasDigit = /[0-9]/.test(value);
  const hasNonDashSymbol = /[^A-Za-z0-9-]/.test(value);
  return hasDigit || hasNonDashSymbol;
}

export function redact(text) {
  const hits = [];
  let out = String(text);
  for (const [type, re] of PATTERNS) {
    if (type === 'password-assign') {
      out = out.replace(re, (match, id, sep, ws, quote, value) => {
        if (value.includes('/') && PATH_SHAPE_RE.test(value)) return match; // path-shaped value, not a secret
        if (sep === ':') {
          // YAML/prose form: only redact when the keyword anchors the
          // identifier's end AND the value itself looks secret-shaped.
          if (!KEYWORD_SUFFIX_RE.test(id)) return match;
          if (!looksSecretShaped(value)) return match;
        }
        hits.push(type);
        return `${id}${sep}${ws}${quote}[REDACTED:${type}]`;
      });
    } else {
      out = out.replace(re, () => { hits.push(type); return `[REDACTED:${type}]`; });
    }
  }
  out = out.replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, (m) => {
    if (m.includes('REDACTED')) return m;
    if (/^[a-z0-9/_.-]+$/.test(m)) return m;           // paths / plain lowercase identifiers
    if (/^(?:sha256|sha384|sha512)-/.test(m)) return m; // integrity strings (SRI)
    // Pure hex is ambiguous with git SHAs / commit hashes, which are common
    // and not secrets in worklog prose; accepted trade-off is to let
    // standalone hex through here — hex secrets anchored to a keyword
    // (e.g. `token=<hex>`) are still caught by the password-assign pattern
    // above, before this generic entropy pass ever sees them.
    if (/^[0-9a-fA-F]+$/.test(m)) return m;             // pure hex (hashes, commit SHAs)
    if (shannon(m) <= 4.0) return m;
    hits.push('high-entropy');
    return '[REDACTED:high-entropy]';
  });
  return { text: out, hits };
}
