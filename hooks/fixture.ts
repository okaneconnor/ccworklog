// A finished report as view.json holds it, shared by the view and pane tests.
import type { View } from './view'

// Local-time timestamps, so slot maths holds in any timezone the test runs in.
const at = (day: string, h: number, m = 0) => {
  const [y, mo, d] = day.split('-').map(Number)
  return new Date(y as number, (mo as number) - 1, d as number, h, m).toISOString()
}

export const VIEW: View = {
  label: '2026-10-07',
  days: ['2026-10-07'],
  htmlPath: '/d/reports/2026-10-07.html',
  standupMd: '## Standup — 2026-10-07\n\n- **homelab**: Synced the qBittorrent port\n',
  standup: [{ workstream: 'homelab', outcomes: ['Synced the qBittorrent port'] }],
  personal: [{
    workstream: 'homelab@main',
    narrative: 'started with stalled torrents, found the stale port, fixed via UP_COMMAND',
    commits: ['ab12cd Sync port', '+2 more'],
    items: [{ claim: 'Port sync', detail: 'gluetun rotates the port', evidence: { files: ['/r/compose.yml'], error_excerpt: 'connection refused' } }],
  }],
  alsoShipped: [{ repo: '/r/blog', summary: 'Published a post', commits: ['cd34ef Post'] }],
  threads: {
    open: [{ id: 't-1', text: 'Add tracker list', repo: 'homelab', firstSeen: '2026-10-04', lastState: 'not started' }],
    resolved: ['Fix TempPath — resolved by commit ab12cd'],
  },
  timeline: [{ day: '2026-10-07', projects: ['homelab'], empty: false }],
  activity: {
    sessions: [
      { sessionId: 's1', day: '2026-10-07', title: 'a', project: 'homelab', firstTs: at('2026-10-07', 9), lastTs: at('2026-10-07', 11), promptCount: 4 },
      { sessionId: 's2', day: '2026-10-07', title: 'b', project: 'blog', firstTs: at('2026-10-07', 10), lastTs: at('2026-10-07', 10, 30), promptCount: 2 },
    ],
  },
  footer: { parseHealth: 'ok', missedSessions: [] },
}
