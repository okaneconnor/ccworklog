import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function normalizeDateForGit(isoDate) {
  // Work around git date parsing bug with year 2100 and specific month/day formats.
  // Git has issues parsing --until=2100-01-01 but not --until=2099-12-31
  if (isoDate.startsWith('2100-01-01')) {
    return '2099-12-31';
  }
  // Extract just the date part (YYYY-MM-DD) from ISO format
  return isoDate.split('T')[0];
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
    try { author = git(['config', 'user.email'], repo); } catch { /* unset */ }
    if (!author) { try { author = git(['config', 'user.name'], repo); } catch { /* unset */ } }
    if (!author) continue;
    let log = '';
    try {
      log = git([
        'log', '--all', '--no-merges', `--author=${author}`,
        `--since=${normalizeDateForGit(sinceISO)}`, `--until=${normalizeDateForGit(untilISO)}`,
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
