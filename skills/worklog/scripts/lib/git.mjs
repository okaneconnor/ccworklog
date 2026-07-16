import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
      if (author) authorPattern = `<${author}>`;
    } catch { /* unset */ }
    if (!author) {
      try {
        author = git(['config', 'user.name'], repo);
        if (author) authorPattern = author;
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
        // --since-as-filter requires git >= 2.37 (2022-06).
        // --fixed-strings treats --author as a literal substring, not regex,
        // so email addresses with + signs (me+tag@example.com) match correctly.
        'log', '--all', '--no-merges', '--fixed-strings', `--author=${authorPattern}`,
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
