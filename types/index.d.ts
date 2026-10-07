declare module 'claude-code' {
  interface PluginState {
    ccworklog: {
      run: {
        phase: 'idle' | 'collecting' | 'confirm' | 'digesting' | 'merging' | 'reducing' | 'rendering' | 'done' | 'empty' | 'cancelled' | 'error'
        range: string
        label: string
        done: number
        total: number
        sessions: number
        commits: number
        isCached: boolean
        message: string
        missed: string[]
      }
      view: {
        label: string
        days: string[]
        htmlPath: string
        standupMd: string
        standup: { workstream: string; project?: string; outcomes: string[] }[]
        personal: {
          workstream: string
          narrative?: string
          commits?: string[]
          items: { claim: string; detail?: string; low_confidence?: boolean; evidence?: { files?: string[]; commands?: string[]; error_excerpt?: string } }[]
        }[]
        alsoShipped: { repo?: string; summary: string; commits?: string[] }[]
        threads: { open: { id: string; text: string; repo?: string; firstSeen?: string; lastState?: string }[]; resolved: string[] }
        timeline: { day: string; projects: string[]; empty: boolean }[]
        activity: { sessions: { sessionId: string; day: string; title: string | null; project?: string | null; firstTs: string | null; lastTs: string | null; promptCount: number }[] }
        footer: { parseHealth?: string; missedSessions?: string[] }
      } | null
      tab: 'standup' | 'log' | 'threads' | 'timeline'
      page: number
      frame: number
    }
  }
}
