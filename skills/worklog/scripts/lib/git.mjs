import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// git --author matches an unanchored regex against "Name <email>", so raw
// metacharacters (e.g. the dots in an email) can over-match unrelated
// authors. Escape them, and for an email anchor the match to the angle
// brackets it's wrapped in so only that exact address can match.
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function collectGitEvidence(cwds, { sinceISO, untilISO }) {
  const repos = new Set();
  for (const cwd of cwds) {
    if (!cwd || !existsSync(cwd)) continue;
    try { repos.add(git(['rev-parse', '--show-toplevel'], cwd)); } catch { /* not a repo */ }
  }
  const out = [];
  for (const repo of [...repos].sort()) {
    let author = '';
    let authorPattern = '';
    try {
      author = git(['config', 'user.email'], repo);
      if (author) authorPattern = `<${escapeRegex(author)}>`;
    } catch { /* unset */ }
    if (!author) {
      try {
        author = git(['config', 'user.name'], repo);
        if (author) authorPattern = escapeRegex(author);
      } catch { /* unset */ }
    }
    if (!author) continue;
    let log = '';
    try {
      log = git([
        // --since-as-filter (not --since): --since stops walking history as
        // soon as it hits a commit older than the cutoff, which silently
        // drops matching commits when history isn't in strict chronological
        // order (rebases, amends, backdated commits). --since-as-filter
        // visits every commit and filters instead. No --until-as-filter
        // exists in git, so --until keeps its normal (walk-stopping)
        // semantics; that's fine since we only ever supply an upper bound
        // to filter recent history, not to search back through it.
        'log', '--all', '--no-merges', `--author=${authorPattern}`,
        `--since-as-filter=${sinceISO}`, `--until=${untilISO}`,
        '--date=iso-strict', '--pretty=%h%x09%ad%x09%s',
      ], repo);
    } catch { continue; }
    if (!log) continue;
    const commits = log.split('\n').map((l) => {
      const [sha, date, ...s] = l.split('\t');
      return { sha, date, subject: s.join('\t') };
    });
    out.push({ repo, author, commits });
  }
  return out;
}
