import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheFacts, Ending, Fold, Progress, Turn, Window, Worker } from '../types'
import { LIST_TOOLS, REPORT_TOOL, afterListCall, afterReport, barText, labelOf, pulseText, ratioOf } from './progress'
import { BAR_H, crewSvg, paceSvg, walkSvg } from './progress-art'
import {
  EMPTY, HUE, INK, MUTED, ORANGE, ROBO_SIZE, TEXT, TTL_MIN, TTL_MS, WORD, YELLOW,
  bandPx, cardSvg, chipSvg, costOf, familyOf, fmtIdle, kindOf, mineModel, roboSvg, usd,
} from './cache-art'
import type { CacheView } from './cache-art'

// A band above the prompt in a warm dark look: card surface, cream text,
// dot-matrix bars. Shows how much of each usage window is LEFT, 7-day first, then
// 5-hour; 7D is orange, 5H is yellow; a window under 15% adds a bold LOW.
//
// After the first reply it also shows the prompt cache: WARM (red, Robo bobbing)
// for an hour after the last request, then COLD (blue, Robo frozen) with what the
// next message costs to re-cache. The arrow button folds the card; warm starts folded,
// cold starts open, and a choice holds until the cache flips. Zero token cost:
// it reads the engine's own figures and draws.
//
// With cache-tax installed it also carries that mod's keep-warm switch: one button,
// on or off for every session, on by default. A keep-warm ping that really read the
// cache starts the hour again here too, so the band and cache-tax agree.

const CELLS = 10
const LOW_AT = 15
const TIGHT_CELLS = 6
/** How often the band redraws, so the countdown and the warm-to-cold flip stay current. */
const TICK_MS = 30_000
/** cache-tax's command, and the key this band remembers the switch under, for every session. */
const KEEPWARM = 'keepwarm'
const KEEP_KEY = 'keep'
/** cache-tax registers its command in its own session.start, which may run after this one. */
const FIRST_RUN_DELAY_MS = 3000

const windows = atom({ plugin: 'ribbon', key: 'windows' } as const, [] as Window[])
const cache = atom({ plugin: 'ribbon', key: 'cache' } as const, null as CacheFacts | null)
const fold = atom({ plugin: 'ribbon', key: 'fold' } as const, null as Fold | null)
const progress = atom({ plugin: 'ribbon', key: 'progress' } as const, null as Progress | null)
const turn = atom({ plugin: 'ribbon', key: 'turn' } as const, null as Turn | null)
const crew = atom({ plugin: 'ribbon', key: 'crew' } as const, [] as Worker[])
const ending = atom({ plugin: 'ribbon', key: 'ending' } as const, null as Ending)

/** The skill a wrap-up runs, and the window it leaves keep-warm: too short for a ping, so this conversation stops being held. */
const DEBRIEF = 'debrief'
const WRAP_WINDOW = '1m'
/** cache-tax re-arms its window when a turn completes; the wrap-up's short one goes in after that. */
const WRAP_DELAY_MS = 2000
const CREW_MAX = 40
const CREW_SHOWN = 5

/** The step's name beside the bar is cut to this, so the bar keeps its room. */
const NOTE_MAX = 32
/** The bar sits in the row's spare room when at least this many columns are free; otherwise it takes a row of its own. */
const INLINE_MIN_COLS = 18
const BAR_MIN_PX = 140
const BAR_MAX_PX = 380
/** A cautious width for one column of spare room, so the bar never pushes the buttons off the row. */
const COL_PX = 8

const NAMES: Record<string, string> = { seven_day: '7D', five_hour: '5H', spend_limit: 'SPEND' }
const ORDER: Record<string, number> = { seven_day: 0, five_hour: 1 }
const COLORS: Record<string, string> = { seven_day: ORANGE, five_hour: YELLOW }

const clean = (list: readonly Window[]): Window[] =>
  list
    .map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
    .sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9))

const dots = (left: number, cells: number): { on: string; off: string } => {
  const n = Math.max(0, Math.min(cells, Math.round((left / 100) * cells)))
  return { on: '●'.repeat(n), off: '·'.repeat(cells - n) }
}

const fmtReset = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'resetting'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** The cache figures of one keep-warm ping, as the model reports them. */
export type PingUsage = { cache_read_input_tokens: number; cache_creation_input_tokens: number }

/**
 * Whether a ping's usage shows the prompt cache was still alive: it read the
 * prefix from the cache and wrote next to nothing. Only then does the band start
 * its hour again; a ping that paid to write the prefix found the cache gone.
 */
export const pingKeptCacheWarm = (usage: PingUsage | null | undefined): boolean => {
  if (!usage) return false
  // The same rule cache-tax scores its own pings by: a write of a tenth of the read or more means the prefix broke.
  return usage.cache_read_input_tokens > 0 && usage.cache_creation_input_tokens < 0.1 * usage.cache_read_input_tokens
}

/** What the cache drawings read, or null until a request and its context size are known. */
export const viewOf = (c: CacheFacts | null, now: number): CacheView | null => {
  if (!c || c.lastAt <= 0 || c.tokens <= 0) return null
  const idleMs = Math.max(0, now - c.lastAt)
  return {
    mode: idleMs >= TTL_MS ? 'cold' : 'warm',
    idle: fmtIdle(idleMs),
    idleMin: Math.floor(idleMs / 60000),
    tokens: c.tokens,
    window: c.window,
    mine: familyOf(c.model),
  }
}

const pull = async ($: EngineInterface): Promise<void> => {
  const u = await $.session.usage()
  await update($, windows, () => clean(u.rateLimits))
}

/** Fresh context figures from the engine onto the cache facts, when it has them. */
const measure = async ($: EngineInterface, lastAt: number | null, model: string | null): Promise<void> => {
  const u = await $.session.usage()
  const m = model ?? (await $.session.model())
  await update($, cache, c => ({
    lastAt: lastAt ?? c?.lastAt ?? 0,
    tokens: u.context.tokens && u.context.tokens > 0 ? u.context.tokens : (c?.tokens ?? 0),
    window: u.context.window || c?.window || 0,
    model: m || c?.model || null,
  }))
}

/** Whether a slash command of that name is there to run. */
const hasCommand = async ($: EngineInterface, name: string): Promise<boolean> => {
  try {
    return (await $.command.list()).some(c => c.name === name)
  } catch {
    return false
  }
}

/** The switch as saved: on, off, or null when cache-tax is not there to switch. */
const keepState = async ($: EngineInterface): Promise<boolean | null> => {
  try {
    if (!(await hasCommand($, KEEPWARM))) return null
    return (await $.store.get(KEEP_KEY)) === true
  } catch {
    return null
  }
}

/** A slash command, fired and not awaited: one run from inside a hook the turn waits on can hang. */
const fire = ($: EngineInterface, command: string, args: string): void => {
  void Promise.resolve($.command.run({ command, args })).catch(() => {})
}

/** The running subagents as the band names them: "Explore 4, sonnet-coder 12", kind and requests made. */
export const crewText = (running: Worker[]): string => {
  const s = running.map(w => `${w.type} ${w.steps}`).join(', ')
  return s.length > CREW_MAX ? s.slice(0, CREW_MAX - 1) + '…' : s
}

/** Saves the switch and tells cache-tax: always keeps every session warm, off stops it for good. */
const setKeep = async ($: EngineInterface, isOn: boolean): Promise<void> => {
  await $.store.set(KEEP_KEY, isOn)
  $.ui.invalidate('ui.render')
  fire($, KEEPWARM, isOn ? 'always' : 'off')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await pull($)
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    // The first session ever: keep-warm starts on. After that the saved choice stands.
    $.clock.after(FIRST_RUN_DELAY_MS, async () => {
      try {
        if (typeof (await $.store.get(KEEP_KEY)) === 'boolean') return
        if ((await keepState($)) !== null) await setKeep($, true)
      } catch { /* a band that cannot read its switch still draws */ }
    })
    // For a request the model keeps no task list for. Listed up front: nobody goes looking for a progress tool.
    try {
      await $.tool.register({
        name: 'progress',
        description:
          'Report where you are in a multi-step request to the progress bar above the prompt. ' +
          'Call it once at the start with `total` (your plan in 3-8 steps), `done: 0` and a `note` naming the step in hand; ' +
          'again as each step finishes; and with `finished: true` at the end. Fields left out keep their value. ' +
          'Skip it whenever you keep a task list: the bar reads that by itself. Cheap and silent: it only draws a bar.',
        inputSchema: {
          type: 'object',
          properties: {
            total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
            done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
            note: { type: 'string', description: 'The step in hand, a few words.' },
            finished: { type: 'boolean', description: 'True once the request is done.' },
          },
        },
        isDeferred: false,
      })
    } catch { /* without the tool the bar still follows the task list */ }
    return next(e)
  })

  // The task list the main session keeps is its own account of where it is. The call goes on untouched.
  for (const tool of LIST_TOOLS) {
    on('tool.call', { tool }, async ($, e, next) => {
      if (!e.agentId) await update($, progress, p => afterListCall(p, tool, e as unknown as Record<string, unknown>))
      return next(e)
    }).catch(($, e, next) => next(e)) // a bar that fails to read a list never holds up the tool
  }

  on('tool.call', { tool: REPORT_TOOL }, async ($, e) => {
    // A subagent's steps are not the request's: only the main session moves the bar.
    if (e.agentId) return { result: 'ignored: only the main session reports progress' }
    const p = await update($, progress, prev => afterReport(prev, e as unknown as Record<string, unknown>))
    return { result: p ? `ok: ${labelOf(p).count}` : 'ok' }
  })

  // A typed /keepwarm always or off moves the switch too. cache-tax answers the command beneath.
  on('command.run', { command: KEEPWARM }, async ($, e, next) => {
    const word = String(e.args ?? '').trim().split(/\s+/)[0]
    if (word === 'always' || word === 'off') {
      await $.store.set(KEEP_KEY, word === 'always')
      $.ui.invalidate('ui.render')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A keep-warm ping is a fork of the main thread's last request. One that read the cache
  // kept it alive, so the hour starts again from when it was sent.
  on('model.fork', async ($, e, next) => {
    const sentAt = await $.clock.now()
    const r = await next(e)
    const reply = r && typeof r === 'object' && 'value' in r ? r.value : r
    if (reply && reply.isAnswered !== false && pingKeptCacheWarm(reply.usage)) {
      await update($, cache, c => (c ? { ...c, lastAt: sentAt } : c))
    }
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, windows, () => clean(e.rateLimits))
    }
    if (e.changed.includes('context') && e.context.tokens && e.context.tokens > 0) {
      const tokens = e.context.tokens
      await update($, cache, c => (c ? { ...c, tokens, window: e.context.window || c.window } : c))
    }
    return next(e)
  })

  // A resumed or forked session knows how long it was away and how big it is.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear' || e.source === 'compact') {
      await update($, cache, () => null)
      await update($, fold, () => null)
    } else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const now = await $.clock.now()
      const lastAt = now - e.seconds_since_last_response * 1000
      const window = (await $.session.usage()).context.window
      const model = typeof e.model === 'string' ? e.model : await $.session.model()
      const tokens = typeof e.context_tokens === 'number' ? e.context_tokens : 0
      await update($, cache, () => ({ lastAt, tokens, window, model }))
    }
    return r
  }).catch(($, e, next) => next(e)) // a band that fails to seed never holds up the session

  // Each main-thread request reads or writes the cache, so its start resets the hour.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, cache, c => ({ lastAt: now, tokens: c?.tokens ?? 0, window: c?.window ?? 0, model: c?.model ?? null }))
      // A turn's first request starts its clock, and a list finished last turn has had its moment.
      if (e.index === 0) {
        await update($, turn, () => ({ startedAt: now, steps: 1 }))
        await update($, progress, p => (p && p.isFinished ? null : p))
        await update($, crew, list => list.filter(w => !w.isDone))
        // The turn the wrap-up asked for has begun: its end is the conversation's.
        await update($, ending, s => (s === 'asked' ? 'running' : s))
      } else {
        await update($, turn, t => (t ? { ...t, steps: t.steps + 1 } : { startedAt: now, steps: 1 }))
      }
    } else {
      // A subagent's request. One the band never saw start still gets a place.
      const id = e.agentId
      await update($, crew, list =>
        list.some(w => w.id === id)
          ? list.map(w => (w.id === id ? { ...w, steps: w.steps + 1, isDone: false } : w))
          : [...list, { id, type: 'agent', steps: 1, isDone: false }].slice(-50),
      )
    }
    yield* next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started
    const id = started.agentId ?? e.tool_use_id
    const type = String(e.subagentType || 'agent')
    await update($, crew, list => [...list.filter(w => w.id !== id), { id, type, steps: 0, isDone: false }].slice(-50))
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) {
      const id = e.agentId
      await update($, crew, list => list.map(w => (w.id === id ? { ...w, isDone: true } : w)))
      return r
    }
    if ((await read($, ending)) === 'running') {
      await update($, ending, () => null)
      // The debrief is in: stop holding this conversation's cache. The switch stays on for the next one.
      if ((await keepState($)) === true) $.clock.after(WRAP_DELAY_MS, () => fire($, KEEPWARM, WRAP_WINDOW))
    }
    const now = await $.clock.now()
    const c = await read($, cache)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    const lastAt = !c || now - c.lastAt > e.durationMs ? now : c.lastAt
    await measure($, lastAt, e.usage?.model ?? null)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // Svg draws on desktop, mobile and VS Code; the terminal gets the text form.
    // Ask the surface, not the table: the terminal's table still lists Svg.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const list = await read($, windows)
    const now = await $.clock.now()
    const view = viewOf(await read($, cache), now)

    const keep = await keepState($)
    const keepButton = keep === null ? null : (
      <Box key="keep" flexShrink={0} alignItems="flex-start" marginLeft={1}>
        <Button key="keep-warm" label={keep ? 'Keep warm: on' : 'Keep warm: off'} onPress={() => setKeep($, !keep)} />
      </Box>
    )
    // Ends the conversation: runs the debrief, then lets go of this conversation's cache.
    const wrapping = await read($, ending)
    const wrapButton = (await hasCommand($, DEBRIEF)) ? (
      <Box key="wrap" flexShrink={0} alignItems="flex-start" marginLeft={1}>
        <Button
          key="wrap-up"
          label={wrapping ? 'Wrapping up…' : 'Wrap up'}
          onPress={async () => {
            if ((await read($, ending)) !== null) return
            await update($, ending, () => 'asked' as const)
            fire($, DEBRIEF, '')
          }}
        />
      </Box>
    ) : null
    const buttons = [keepButton, wrapButton]
    const grow = <Box key="grow" flexGrow={1} />

    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    const kind = kindOf(columns)
    const running = (await read($, crew)).filter(w => !w.isDone)
    const crewWords = running.length ? ` ×${running.length} ${crewText(running)}` : ''

    // Where the request is: Robo on the bar when there is a list or a report to measure
    // against, Robo pacing while a turn works with neither, nothing when idle.
    const prog = await read($, progress)
    const walking = prog && prog.total > 0 ? prog : null
    const pacing = !walking && e.props.isWorking ? await read($, turn) : null
    const said = walking ? labelOf(walking) : null
    const note = said && said.note.length > NOTE_MAX ? said.note.slice(0, NOTE_MAX - 1) + '…' : (said?.note ?? '')
    const said2 = walking ? ` ${said!.count}${note ? ` · ${note}` : ''}` : pacing ? ` ${pulseText(pacing, now)}` : ''
    // The crew's drawing is about two columns a head; its words follow.
    const words = said2 + (running.length ? ' '.repeat(Math.min(CREW_SHOWN, running.length) * 2 + 2) + crewWords : '')
    const crewBits = !running.length
      ? []
      : [
          Svg ? (
            <Svg
              key="crew"
              source={crewSvg(Math.min(CREW_SHOWN, running.length)).source}
              alt={`${running.length} ${running.length === 1 ? 'subagent' : 'subagents'} working`}
              width={crewSvg(Math.min(CREW_SHOWN, running.length)).w}
              height={BAR_H}
              isInteractive
            />
          ) : null,
          <Text key="crew-count" color={TEXT} bold>{` ×${running.length}`}</Text>,
          <Text key="crew-names" color={MUTED}>{` ${crewText(running)}`}</Text>,
        ]
    /** The bar, its words and the crew, the bar's drawing at most `max` wide; null when there is nothing to show. */
    const progressOf = (key: string, px: number, max: number) => {
      if (!walking && !pacing && !running.length) return null
      const w = Math.round(Math.max(BAR_MIN_PX, Math.min(max, px)))
      const drawing = !walking && !pacing ? null : !Svg ? (
        walking ? <Text key="bar" color={ORANGE}>{barText(walking, kind === 'tight' ? TIGHT_CELLS : CELLS)}</Text> : null
      ) : walking ? (
        <Svg
          key="bar"
          source={walkSvg(ratioOf(walking), walking.total, w, walking.isFinished)}
          alt={walking.isFinished ? `Progress: all ${walking.total} done` : `Progress: ${walking.done} of ${walking.total} done.${note ? ` Now: ${note}` : ''}`}
          width={w}
          height={BAR_H}
          isInteractive
        />
      ) : (
        <Svg key="bar" source={paceSvg(w)} alt="Working" width={w} height={BAR_H} isInteractive />
      )
      return (
        <Box key={key} flexDirection="row" flexShrink={0} alignItems="center" paddingX={key === 'progress-row' ? 1 : 0}>
          {drawing}
          {walking ? <Text key="count" color={TEXT} bold>{` ${said!.count}`}</Text> : null}
          {walking && note ? <Text key="note" color={MUTED}>{` · ${note}`}</Text> : null}
          {pacing ? <Text key="pulse" color={MUTED}>{said2}</Text> : null}
          {crewBits.length && (walking || pacing) ? <Text key="crew-gap">{'  '}</Text> : null}
          {crewBits}
        </Box>
      )
    }
    // On a row of its own the bar takes the width the words leave.
    const rowPx = bandPx(columns) - 40 - words.length * COL_PX
    const progressRow = progressOf('progress-row', rowPx, rowPx)

    if (list.length === 0 && !view) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" paddingX={1}>
            <Text color={MUTED}>USAGE · waiting for the first reply</Text>
            {grow}
            {buttons}
          </Box>
          {progressRow}
        </Box>
      )
    }

    const isWide = kind === 'wide'
    const cells = kind === 'tight' ? TIGHT_CELLS : CELLS

    const parts = (w: Window) => {
      const left = Math.max(0, Math.round((100 - w.percentUsed) * 10) / 10)
      return {
        left,
        col: COLORS[w.kind] ?? TEXT,
        name: NAMES[w.kind] ?? w.kind.toUpperCase(),
        d: dots(left, cells),
        reset: fmtReset(w.resetsAt, now),
      }
    }

    // Wide: every window on one row. Narrow: each window is a block of three
    // lines (name and dots, percent left, reset time) so nothing wraps or clips.
    const wide = (w: Window, i: number) => {
      const p = parts(w)
      return (
        <Box key={`w-${i}`} flexDirection="row" flexShrink={0} marginRight={3}>
          <Text color={MUTED} bold>{p.name} </Text>
          <Text color={p.col}>{p.d.on}</Text>
          <Text color={EMPTY}>{p.d.off}</Text>
          <Text color={p.col} bold> {p.left}% left</Text>
          {p.left < LOW_AT ? <Text color={TEXT} bold> LOW</Text> : null}
          {p.reset ? <Text color={MUTED}> · {p.reset}</Text> : null}
        </Box>
      )
    }

    const stacked = (w: Window, i: number) => {
      const p = parts(w)
      return (
        <Box key={`w-${i}`} flexDirection="column" flexShrink={0} marginRight={3}>
          <Box flexDirection="row">
            <Text color={MUTED} bold>{p.name} </Text>
            <Text color={p.col}>{p.d.on}</Text>
            <Text color={EMPTY}>{p.d.off}</Text>
          </Box>
          <Box flexDirection="row">
            <Text color={p.col} bold>{p.left}% left</Text>
            {p.left < LOW_AT ? <Text color={TEXT} bold> LOW</Text> : null}
          </Box>
          {p.reset ? <Text color={MUTED}>resets {p.reset}</Text> : null}
        </Box>
      )
    }

    const label = (
      <Box key="label" flexShrink={0} marginRight={isWide ? 2 : 3}>
        <Text color={TEXT} bold>USAGE</Text>
      </Box>
    )
    const usage = list.length > 0
      ? list.map(isWide ? wide : stacked)
      : [<Box key="wait" flexShrink={0} marginRight={3}><Text color={MUTED}>waiting for the first reply</Text></Box>]

    // Before the first reply there is no cache to show: today's band, as it was.
    if (!view) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" paddingX={1}>
            {label}
            {usage}
            {grow}
            {buttons}
          </Box>
          {progressRow}
        </Box>
      )
    }

    const mode = view.mode
    const cold = mode === 'cold'
    const hue = HUE[mode]
    const mine = mineModel(view)
    const stored = await read($, fold)
    // Folding needs the card, and the card is a drawing: the terminal stays folded.
    const open = Svg !== null && (stored && stored.mode === mode ? stored.open : cold)
    const toggle = () =>
      update($, fold, f => ({ mode, open: !(f && f.mode === mode ? f.open : mode === 'cold') }))

    const badge = Svg
      ? [
          <Svg key="robo" source={roboSvg(mode)} alt={cold ? 'Robo, frozen' : 'Robo, bobbing'} width={ROBO_SIZE} height={ROBO_SIZE} isInteractive />,
          <Text key="gap"> </Text>,
          (() => {
            const c = chipSvg(mode)
            return <Svg key="chip" source={c.source} alt={WORD[mode]} width={c.w} height={c.h} />
          })(),
        ]
      : [<Text key="chip" backgroundColor={hue} color={INK} bold>{` ${WORD[mode]} `}</Text>]

    const summary = cold
      ? [
          <Text key="idle" color={hue} bold>{` ${view.idle}`}</Text>,
          mine ? <Text key="dot" color={MUTED}> · </Text> : null,
          mine ? <Text key="cost" color={TEXT} bold>{usd(costOf(mine, mode, view.tokens))}</Text> : null,
        ]
      : [<Text key="left" color={hue} bold>{` ${Math.max(0, TTL_MIN - view.idleMin)}m left`}</Text>]

    const button = Svg ? (
      <Box key="fold" flexShrink={0} alignItems="flex-start">
        <Button key="cache-fold" label={open ? '▴' : '▾'} onPress={toggle} />
      </Box>
    ) : null
    // The wide row's spare room, counted in columns from what the row says: the bar goes there when it fits.
    const usedCols =
      7 +
      list.reduce((n, w) => {
        const p = parts(w)
        return n + p.name.length + 1 + cells + ` ${p.left}% left`.length + (p.left < LOW_AT ? 4 : 0) + (p.reset ? 3 + p.reset.length : 0) + 3
      }, 0) +
      (open ? 0 : 12 + (cold ? view.idle.length + 9 : 9)) +
      (Svg ? 5 : 0) +
      (keep === null ? 0 : 17) +
      (wrapButton ? 15 : 0) +
      2
    const freeCols = columns - usedCols - words.length
    const progressInline = isWide && freeCols >= INLINE_MIN_COLS ? progressOf('progress', freeCols * COL_PX, BAR_MAX_PX) : null

    let rows
    if (kind === 'wide') {
      rows = (
        <Box key="row" flexDirection="row" paddingX={1} alignItems="center">
          {label}
          {usage}
          {open ? null : (
            <Box key="inline" flexDirection="row" flexShrink={0} marginRight={2} alignItems="center">
              {badge}
              {summary}
            </Box>
          )}
          {progressInline}
          {grow}
          {button}
          {buttons}
        </Box>
      )
    } else if (kind === 'stacked') {
      // The cache becomes a third stacked block, the same shape as 7D and 5H.
      rows = (
        <Box key="row" flexDirection="row" paddingX={1}>
          {label}
          {usage}
          {open ? null : (
            <Box key="block" flexDirection="column" flexShrink={0} marginRight={2}>
              <Box flexDirection="row" alignItems="center">{badge}</Box>
              <Text color={hue} bold>{cold ? `${view.idle} idle` : `${Math.max(0, TTL_MIN - view.idleMin)}m left`}</Text>
              {mine ? (
                <Box flexDirection="row">
                  <Text color={TEXT} bold>{usd(costOf(mine, mode, view.tokens))}</Text>
                  <Text color={MUTED}> next</Text>
                </Box>
              ) : null}
            </Box>
          )}
          {grow}
          {button}
          {buttons}
        </Box>
      )
    } else {
      // Narrow: the cache gets its own row under the usage blocks.
      rows = [
        <Box key="row" flexDirection="row" paddingX={1}>
          {label}
          {usage}
        </Box>,
        <Box key="cache" flexDirection="row" paddingX={1} alignItems="center">
          {badge}
          {summary}
          {grow}
          {button}
          {buttons}
        </Box>,
      ]
    }

    let card = null
    if (open && Svg) {
      const c = cardSvg(view, kind, bandPx(columns))
      card = (
        <Box key="card" flexDirection="row">
          <Svg source={c.source} alt={c.alt} width={c.w} height={c.h} isInteractive={kind !== 'tight'} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {rows}
        {progressInline ? null : progressRow}
        {card}
      </Box>
    )
  })
}
