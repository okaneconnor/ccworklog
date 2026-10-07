// What each part of the pane draws. Every function takes the surface's
// elements (`Kit`) and plain data, so register.tsx stays the wiring alone.
import type { BoxProps, ButtonProps, ElementConstructor, RasterProps, RenderChildren, TextProps } from 'claude-code'

import {
  age, colorOf, dayLabel, daySummary, isRedacted, projectColors, ruler, slotProjects, statTiles, stripCells, wsName,
} from './view'
import type { View } from './view'

export type Kit = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  /** The terminal alone draws a Raster; elsewhere strips are drawn as text. */
  Raster: ElementConstructor<RasterProps> | null
}

export const Banner = ({ Box, Text }: Kit, title: string) => (
  <Box borderStyle="round" borderColor="claude" paddingX={1} justifyContent="space-between">
    <Text bold color="claude">◆ WORKLOG</Text>
    <Text bold>{title}</Text>
  </Box>
)

export const Tiles = ({ Box, Text }: Kit, v: View) => (
  <Box flexWrap="wrap" columnGap={1}>
    {statTiles(v).map(t => (
      <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column" minWidth={12}>
        <Text bold color="claude">{t.value}</Text>
        <Text dimColor>{t.label}</Text>
      </Box>
    ))}
  </Box>
)

/** A card with a colored rounded border and a "● name" title. */
const Card = ({ Box, Text }: Kit, color: string, title: string, children: RenderChildren[]) => (
  <Box borderStyle="round" borderColor={color} paddingX={1} flexDirection="column" marginBottom={1}>
    <Text bold color={color}>{'● ' + title}</Text>
    {children}
  </Box>
)

export const StandupTab = (kit: Kit, v: View) => {
  const { Box, Text } = kit
  return (
    <Box flexDirection="column">
      {v.standup.length === 0 && <Text dimColor>Nothing to report for this range.</Text>}
      {v.standup.map(s =>
        Card(kit, colorOf(v, s.workstream), wsName(s.workstream), s.outcomes.map(o => (
          <Text>
            <Text color="success">{'✓ '}</Text>
            {o}
          </Text>
        ))),
      )}
      {v.alsoShipped.length > 0 &&
        Card(kit, '#7A8599', 'Also shipped', v.alsoShipped.map(a => (
          <Text>
            <Text bold>{(a.repo ?? '').split('/').pop() || 'other'}</Text>
            {'  ' + a.summary}
          </Text>
        )))}
      {v.threads.open.length > 0 && (
        <Box flexDirection="column">
          <Text bold color="warning">Next up</Text>
          {v.threads.open.slice(0, 5).map(t => (
            <Text>
              <Text color="warning">{'→ '}</Text>
              {t.text}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

export const LogTab = (kit: Kit, v: View, at: number) => {
  const { Box, Text } = kit
  const ws = v.personal[at]
  if (!ws) return <Text dimColor>Nothing logged for this range.</Text>
  const color = colorOf(v, ws.workstream)
  return (
    <Box flexDirection="column">
      <Text bold color={color}>{'● ' + wsName(ws.workstream)}</Text>
      {ws.narrative && (
        <Box marginY={1} paddingLeft={2}>
          <Text italic dimColor>{ws.narrative}</Text>
        </Box>
      )}
      {ws.items.map((item, i) => (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text bold color={color}>{String(i + 1).padStart(2, '0') + '  '}</Text>
            <Text bold>{item.claim}</Text>
            {item.low_confidence ? <Text color="warning" dimColor>{'  unanchored'}</Text> : ''}
          </Text>
          <Box flexDirection="column" paddingLeft={4}>
            {item.detail && <Text>{item.detail}</Text>}
            {(item.evidence?.files ?? []).slice(0, 3).map(f => (
              <Text color={isRedacted(f) ? undefined : 'suggestion'} dimColor={isRedacted(f)}>{'↳ ' + f}</Text>
            ))}
            {item.evidence?.error_excerpt && (
              <Box borderStyle="round" borderColor="error" paddingX={1}>
                <Text color="error">{item.evidence.error_excerpt}</Text>
              </Box>
            )}
          </Box>
        </Box>
      ))}
      {(ws.commits?.length ?? 0) > 0 && (
        <Box flexDirection="column">
          <Text bold>Commits</Text>
          {(ws.commits ?? []).map(c => {
            const [sha, ...subject] = c.split(' ')
            return (
              <Text>
                <Text color="suggestion">{(sha ?? '') + ' '}</Text>
                {subject.join(' ')}
              </Text>
            )
          })}
        </Box>
      )}
    </Box>
  )
}

export const ThreadsTab = ({ Box, Text }: Kit, v: View, today: string) => (
  <Box flexDirection="column">
    {v.threads.open.length === 0 && <Text color="success">No open threads. Clean slate.</Text>}
    {v.threads.open.map(t => {
      const badge = age(t, today)
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text bold inverse color={badge.color}>{` ${badge.text} `}</Text>
            <Text bold>{'  ' + t.text}</Text>
          </Text>
          {(t.repo || t.lastState) && (
            <Box paddingLeft={6}>
              <Text dimColor>{[t.repo, t.lastState].filter(Boolean).join(' — ')}</Text>
            </Box>
          )}
        </Box>
      )
    })}
    {v.threads.resolved.length > 0 && (
      <Box flexDirection="column">
        <Text bold color="success">Resolved</Text>
        {v.threads.resolved.map(r => (
          <Text>
            <Text color="success">{'✓ '}</Text>
            <Text dimColor strikethrough>{r.split(' — ')[0]}</Text>
          </Text>
        ))}
      </Box>
    )}
  </Box>
)

export const TimelineTab = ({ Box, Text, Raster }: Kit, v: View, slots: number) => {
  const colors = projectColors(v)
  return (
    <Box flexDirection="column">
      {v.days.map(day => {
        const cells = slotProjects(v.activity.sessions, day, slots)
        return (
          <Box gap={1}>
            <Text bold>{dayLabel(day)}</Text>
            {Raster === null ? (
              <Text>
                {cells.map(p => (p === null ? <Text dimColor>·</Text> : <Text color={colors.get(p) ?? '#7A8599'}>█</Text>))}
              </Text>
            ) : (
              <Raster key={`day-${day}`} columns={slots} rows={1} cells={stripCells(cells, colors)} />
            )}
            <Text dimColor>{daySummary(v, day)}</Text>
          </Box>
        )
      })}
      <Text dimColor>{'       ' + ruler(slots)}</Text>
      <Box marginTop={1} columnGap={2} flexWrap="wrap">
        {[...colors].map(([project, color]) => (
          <Text>
            <Text color={color}>■ </Text>
            {project}
          </Text>
        ))}
      </Box>
    </Box>
  )
}
