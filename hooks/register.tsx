import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheFacts, Ending, Fold, Progress, Spend, Spent, Turn, Window, Worker } from '../types'
import { LIST_TOOLS, REPORT_TOOL, afterListCall, afterReport, barText, labelOf, pulseText, ratioOf } from './progress'
import { BAR_H, crewSvg, paceSvg, walkSvg } from './progress-art'
import { classify, measure as measureRisk, refusal } from './guard'
import type { Report, Risk } from './guard'
import {
  EMPTY, HUE, INK, MUTED, ORANGE, ROBO_SIZE, TEXT, TTL_MIN, TTL_MS, WORD, YELLOW,
  bandPx, cardSvg, chipSvg, costOf, familyOf, fmtIdle, kindOf, mineModel, roboSvg, turnCost, usd,
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
// on or off for every session, off until pressed. A keep-warm ping that really read the
// cache starts the hour again here too, so the band and cache-tax agree.

const CELLS = 10
const LOW_AT = 15
const TIGHT_CELLS = 6
/** How often the band redraws, so the countdown and the warm-to-cold flip stay current. */
const TICK_MS = 30_000
/** cache-tax's command, and the key this band remembers the switch under, for every session. */
const KEEPWARM = 'keepwarm'
const KEEP_KEY = 'keep'
/** The mod's own settings command: one name, so a rename touches one line. */
const SETTINGS = 'wavebar'
const WRAP_KEY = 'wrapUp'
const HOLD_KEY = 'hold'
/** The cost per session lives in the store under this prefix; entries not written for this long are dropped at session start. */
const SPEND_PREFIX = 'spend:'
const SPEND_KEEP_MS = 30 * 24 * 60 * 60 * 1000

const windows = atom({ plugin: 'wavebar', key: 'windows' } as const, [] as Window[])
const cache = atom({ plugin: 'wavebar', key: 'cache' } as const, null as CacheFacts | null)
const fold = atom({ plugin: 'wavebar', key: 'fold' } as const, null as Fold | null)
const progress = atom({ plugin: 'wavebar', key: 'progress' } as const, null as Progress | null)
const turn = atom({ plugin: 'wavebar', key: 'turn' } as const, null as Turn | null)
const crew = atom({ plugin: 'wavebar', key: 'crew' } as const, [] as Worker[])
const ending = atom({ plugin: 'wavebar', key: 'ending' } as const, null as Ending)
/** Subagent cost since the last main turn finished: it joins the next main turn's `last`. */
const subsSince = atom({ plugin: 'wavebar', key: 'subsSince' } as const, 0)

/** The conversation's cost as one line for the transcript, so a debrief can quote it instead of leaving cost empty. */
export const spendLine = (s: Spend): string =>
  `this conversation has cost about ${usd(s.main + s.subs)} so far (main session ${usd(s.main)}, subagents ${usd(s.subs)}). ` +
  'An estimate from token counts at list prices, since this session started or was last resumed; not a bill.'

/** This session's saved cost, or null when there is none or the id or the store cannot be read. */
const readSpend = async ($: EngineInterface): Promise<Spent | null> => {
  try {
    const s = (await $.store.get(SPEND_PREFIX + (await $.session.id()))) as Partial<Spent> | null | undefined
    if (!s || typeof s.main !== 'number' || typeof s.subs !== 'number') return null
    return { main: s.main, subs: s.subs, last: typeof s.last === 'number' ? s.last : 0, at: typeof s.at === 'number' ? s.at : 0 }
  } catch {
    return null
  }
}

/** Adds a finished turn's cost to this session's saved figures. A failing store or id loses the figure, never the turn. */
const addSpend = async ($: EngineInterface, paid: number, isMain: boolean): Promise<void> => {
  try {
    const key = SPEND_PREFIX + (await $.session.id())
    const was = await readSpend($)
    const next: Spent = { main: was?.main ?? 0, subs: was?.subs ?? 0, last: was?.last ?? 0, at: await $.clock.now() }
    if (isMain) {
      next.main += paid
      next.last = paid + (await read($, subsSince))
      await update($, subsSince, () => 0)
    } else {
      next.subs += paid
      await update($, subsSince, n => n + paid)
    }
    await $.store.set(key, next)
    $.ui.invalidate('ui.render')
  } catch { /* the band shows no cost; the turn goes on */ }
}

/** A switch kept in the store: its saved value, or `fallback` when none was saved or the store cannot be read. */
const switchOf = async ($: EngineInterface, key: string, fallback: boolean): Promise<boolean> => {
  try {
    const v = await $.store.get(key)
    return typeof v === 'boolean' ? v : fallback
  } catch {
    return fallback
  }
}

/** The settings command's answer to `args`; a change is saved and the band redrawn. */
const settingsAnswer = async ($: EngineInterface, args: string): Promise<string> => {
  const [name, value, ...rest] = args.trim().split(/\s+/)
  const usage = `Usage: /${SETTINGS} [status] | wrapup on|off | hold on|off`
  const key = name === 'wrapup' ? WRAP_KEY : name === 'hold' ? HOLD_KEY : null
  if (key !== null && rest.length === 0 && (value === 'on' || value === 'off')) {
    await $.store.set(key, value === 'on')
    $.ui.invalidate('ui.render')
    return `${name}: ${value}`
  }
  if (name !== '' && name !== 'status') return usage
  const wrap = await switchOf($, WRAP_KEY, false)
  const hold = await switchOf($, HOLD_KEY, true)
  return (
    `wrapup: ${wrap ? 'on' : 'off'} - a Wrap up button that runs the debrief skill and lets this conversation go cold\n` +
    `hold: ${hold ? 'on' : 'off'} - holds risky git commands (hard reset, clean, force push) until you answer in the band`
  )
}

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

// ---------- Hold and show ----------
/** The shells whose command lines are read. */
const SHELLS = ['Bash', 'PowerShell'] as const
const HOLD_LIMIT_MS = 10 * 60 * 1000
/** A wait that came back sooner than this did not wait, so it is not used to hold. */
const WAIT_FLOOR_MS = 100
/**
 * A hook has seconds of its own time, but time inside a `$` call is free, so a hold
 * waits in a short process: `sleep` where there is one, and on Windows, where there
 * is not, one second of `ping`.
 */
const WAITS: readonly (readonly string[])[] = [['sleep', '0.5'], ['ping', '-n', '2', '127.0.0.1']]

type Held = { command: string; risk: Risk; report: Report | null; decision: 'proceed' | 'cancel' | null }
/** The call being held, or null. One at a time; a second risky call waits its turn. */
let held: Held | null = null
/** Which of WAITS works on this machine: unknown until tried, -1 when none does. */
let waitAt: number | null = null

/** Waits a moment inside a process. False when this machine has no way to: then nothing can be held. */
async function waitTick($: EngineInterface): Promise<boolean> {
  for (let i = waitAt ?? 0; i < WAITS.length && waitAt !== -1; i++) {
    try {
      const before = await $.clock.now()
      const r = await $.process.run([...WAITS[i]], { timeoutMs: 5000 })
      if (r.exitCode === 0 && (await $.clock.now()) - before >= WAIT_FLOOR_MS) {
        waitAt = i
        return true
      }
    } catch { /* not on this machine: try the next */ }
    if (waitAt === i) break
  }
  waitAt = -1
  return false
}

/** For tests: forget the held call and which wait works. */
export const resetHold = (): void => {
  held = null
  waitAt = null
}

export const register: Register = on => {
  // A git command that throws work away is held until the person answers in the band.
  // Cancel, no answer and an interrupted turn refuse it. A machine that cannot hold,
  // or an error while holding, lets it through with a note: this is a second look,
  // and the permission rules are still in front of it.
  for (const tool of SHELLS) {
    on('tool.call', { tool }, async ($, e, next) => {
      const command = String(e.command ?? '')
      const risk = classify(command)
      if (risk === null) return next(e)
      // The hold is on unless /wavebar hold off said otherwise.
      if (!(await switchOf($, HOLD_KEY, true))) return next(e)
      const interrupted = { deny: refusal('the turn was interrupted', risk.label) }
      // `held` is claimed with no await between the check and the claim, so two waiting calls can't both get through.
      while (held !== null) {
        if (next.signal?.aborted) return interrupted
        if (!(await waitTick($))) break
      }
      if (waitAt === -1) {
        void Promise.resolve($.ui.log(`could not hold \`${risk.label}\` to show what it changes: this machine has no way to wait. It runs as usual.`)).catch(() => {})
        return next(e)
      }
      const mine: Held = { command, risk, report: null, decision: null }
      held = mine
      let why: string | null = null
      try {
        mine.report = await measureRisk($, risk, await $.session.cwd())
        $.ui.invalidate('ui.render')
        const startedAt = await $.clock.now()
        while (mine.decision === null && why === null) {
          if (next.signal?.aborted) why = 'the turn was interrupted'
          else if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) why = 'no answer within 10 minutes'
          else if (!(await waitTick($))) break
        }
      } catch { /* an error while holding lets the command through, below */ } finally {
        if (held === mine) held = null
        $.ui.invalidate('ui.render')
      }
      const summary = mine.report?.summary ?? risk.label
      if (mine.decision === 'cancel') return { deny: refusal('the user pressed Cancel', summary) }
      if (why !== null) return { deny: refusal(why, summary) }
      if (mine.decision !== 'proceed') {
        void Promise.resolve($.ui.log(`could not keep holding \`${risk.label}\`, so it runs as usual.`)).catch(() => {})
      }
      return next(e)
    })
  }

  on('session.start', async ($, e, next) => {
    await pull($)
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    try {
      await $.command.register({
        name: SETTINGS,
        description: "Settings for the band above the prompt: the Wrap up button and the hold for risky git commands",
        argumentHint: '[status] | wrapup on|off | hold on|off',
        immediate: true,
      })
    } catch { /* without the command the settings keep their defaults */ }
    // Saved costs of sessions not touched for a month are dropped.
    try {
      const cutoff = (await $.clock.now()) - SPEND_KEEP_MS
      for (const key of await $.store.keys()) {
        if (!key.startsWith(SPEND_PREFIX)) continue
        const s = (await $.store.get(key)) as Partial<Spent> | null | undefined
        if (s && typeof s.at === 'number' && s.at < cutoff) await $.store.delete(key)
      }
    } catch { /* an entry that stays is only a few bytes */ }
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

  on('command.run', { command: SETTINGS }, async ($, e) => ({ text: await settingsAnswer($, String(e.args ?? '')) }))

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
    // What the turn used, at list prices, onto the conversation's running cost.
    const paid = turnCost(e.usage) ?? 0
    if (e.agentId) {
      const id = e.agentId
      await update($, crew, list => list.map(w => (w.id === id ? { ...w, isDone: true } : w)))
      if (paid > 0) await addSpend($, paid, false)
      return r
    }
    if (paid > 0) await addSpend($, paid, true)
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

    // A held command takes the band: what it would lose, and the two answers. Cancel comes first.
    const holding = held
    if (holding && holding.report) {
      const rep = holding.report
      const shown = holding.command.length > 90 ? holding.command.slice(0, 89) + '…' : holding.command
      return (
        <Box key="held" flexDirection="column" paddingX={1}>
          <Box flexDirection="row" alignItems="center">
            <Text key="held-chip" backgroundColor={ORANGE} color={INK} bold>{' HELD '}</Text>
            <Text key="held-command" color={TEXT} bold>{` ${shown}`}</Text>
            <Box key="grow" flexGrow={1} />
            <Box key="held-no" flexShrink={0} marginLeft={1}>
              <Button key="held-cancel" label="Cancel" onPress={() => { holding.decision = 'cancel' }} />
            </Box>
            <Box key="held-yes" flexShrink={0} marginLeft={1}>
              <Button key="held-proceed" label="Proceed" onPress={() => { holding.decision = 'proceed' }} />
            </Box>
          </Box>
          <Text key="held-summary" color={YELLOW} bold>{`Would ${rep.summary}`}</Text>
          {rep.lines.map((l, i) => <Text key={`held-line-${i}`} color={TEXT}>{`  ${l}`}</Text>)}
          {rep.more > 0 ? <Text key="held-more" color={MUTED}>{`  and ${rep.more} more`}</Text> : null}
          {rep.note ? <Text key="held-note" color={MUTED}>{rep.note}</Text> : null}
        </Box>
      )
    }
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
    const wrapButton = (await switchOf($, WRAP_KEY, false)) && (await hasCommand($, DEBRIEF)) ? (
      <Box key="wrap" flexShrink={0} alignItems="flex-start" marginLeft={1}>
        <Button
          key="wrap-up"
          label={wrapping ? 'Wrapping up…' : 'Wrap up'}
          onPress={async () => {
            if ((await read($, ending)) !== null) return
            await update($, ending, () => 'asked' as const)
            // Into the transcript first, so the debrief has the figure to quote.
            const s = await readSpend($)
            if (s && s.main + s.subs > 0) void Promise.resolve($.ui.log(spendLine(s))).catch(() => {})
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

    // What the conversation has cost so far, read from the store: it survives a restart.
    const isWide = kind === 'wide'
    const paid = await readSpend($)
    const total = paid ? paid.main + paid.subs : 0
    const lastText = paid && paid.last > 0 ? usd(paid.last) : null
    const spendBox = total <= 0 ? null : (
      <Box key="spend" flexDirection={isWide ? 'row' : 'column'} flexShrink={0} marginRight={3}>
        <Text color={MUTED} bold>{isWide ? 'COST ' : 'COST'}</Text>
        <Text key="spend-total" color={TEXT} bold>{`≈${usd(total)}`}</Text>
        {lastText ? <Text key="spend-last" color={MUTED}>{isWide ? ` · last ${lastText}` : `last ${lastText}`}</Text> : null}
      </Box>
    )

    if (list.length === 0 && !view) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" paddingX={1}>
            <Text color={MUTED}>USAGE · waiting for the first reply</Text>
            {spendBox ? <Box key="wait-spend" marginLeft={2}>{spendBox}</Box> : null}
            {grow}
            {buttons}
          </Box>
          {progressRow}
        </Box>
      )
    }

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
    const usage = [
      ...(list.length > 0
        ? list.map(isWide ? wide : stacked)
        : [<Box key="wait" flexShrink={0} marginRight={3}><Text color={MUTED}>waiting for the first reply</Text></Box>]),
      spendBox,
    ]

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
        <Button key="cache-fold" label={open ? '−' : '+'} onPress={toggle} />
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
      (spendBox ? 9 + usd(total).length + (lastText ? 8 + lastText.length : 0) : 0) +
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
