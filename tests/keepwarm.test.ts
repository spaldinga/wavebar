import { expect, mock, test } from 'claude-code/testing'
import type { On, Plugin } from 'claude-code'

import { turnCost, usd } from '../hooks/cache-art'
import { pingKeptCacheWarm } from '../hooks/register'

/** The brown the band used to paint behind itself. */
const BG = '#24221c'
const NOW = Date.parse('2098-12-31T22:00:00Z')
const MIN = 60_000
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
} as const
const BAND = { plugin: 'wavebar', component: 'AbovePrompt', props: PROPS } as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

/** Stands in for cache-tax: another mod whose /ping forks the main thread, as a keep-warm ping does. */
const pinger: Plugin = {
  name: 'pinger',
  register(on) {
    on('command.run', { command: 'ping' }, async $ => {
      await $.model.fork({ prompt: 'Reply with the single word: warm' })
      return { text: '' }
    })
  },
}

type Fork ={ read: number; write: number } | null

/** The engine beneath the band: a store to inspect, cache-tax's commands, and what a fork answers. */
const engine = (on: On, opts: { keep?: boolean; commands?: string[]; fork?: Fork; prefill?: Record<string, unknown>; idThrows?: boolean; registerThrows?: boolean } = {}) => {
  const store = new Map<string, unknown>(Object.entries(opts.prefill ?? {}))
  if (opts.keep !== undefined) store.set('keep', opts.keep)
  const ran: string[] = []
  const session = { id: 'S1' }
  const registered: string[] = []
  on('session.id', () => { if (opts.idThrows) throw new Error('no id'); return { value: session.id } })
  on('command.register', ($, e) => { if (opts.registerThrows) throw new Error('nope'); registered.push(e.name); return { value: undefined } })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', ($, e) => { store.delete(e.key); return { value: undefined } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000, tokens: 200000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('classic.SessionStart', () => ({}))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.list', () => ({
    value: (opts.commands ?? ['keepwarm', 'cache-tax']).map(name => ({ name, description: '', source: 'plugin' as const })),
  }))
  on('command.run', ($, e) => { ran.push(`${e.command} ${e.args}`.trim()); return { text: '' } })
  on('model.fork', () => {
    const f = opts.fork
    if (!f) return { value: { isAnswered: false as const, reason: 'api-error' as const, status: 500, error: 'down' } }
    return {
      value: {
        isAnswered: true as const,
        text: 'warm',
        usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: f.read, cache_creation_input_tokens: f.write },
      },
    }
  })
  return { store, ran, session, registered }
}

const WRAP = { wrapUp: true }

/** A session whose last main-thread request was `idleMin` minutes before the clock's now. */
const seed = async ($: Parameters<Parameters<typeof test>[1]>[0], idleMin: number) => {
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: idleMin * 60, context_tokens: 200000, model: 'claude-opus-5-5' })
}

test('the ping rule: a read with next to no write kept the cache; anything else did not', () => {
  const u = (read: number, write: number) => ({ input_tokens: 2, output_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: write })
  expect(pingKeptCacheWarm(u(200000, 0))).toBe(true)
  expect(pingKeptCacheWarm(u(200000, 150))).toBe(true)
  // Nothing read: the prefix was not in the cache.
  expect(pingKeptCacheWarm(u(0, 0))).toBe(false)
  // A write of a tenth of the read or more: the prefix broke and was written again.
  expect(pingKeptCacheWarm(u(200000, 20000))).toBe(false)
  expect(pingKeptCacheWarm(u(0, 200000))).toBe(false)
  expect(pingKeptCacheWarm(null)).toBe(false)
  expect(pingKeptCacheWarm(undefined)).toBe(false)
})

test('a keep-warm ping that read the cache starts the hour again', { plugins: [pinger] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { keep: true, fork: { read: 200000, write: 0 } })
  await seed($, 0)
  await clock.advance(50 * MIN)
  await $.command.run({ command: 'ping', args: '', ...RUN })
  await clock.advance(30 * MIN)

  // 80 minutes after the last turn, 30 after the ping: warm, with 30 minutes left.
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.findAll({ type: 'Svg' })).map(s => s.props.alt)).toEqual(['Robo, bobbing', 'WARM'])
  expect(await band.find({ text: ' 30m left' })).toBeDefined()
  await band.unmount()
})

test('a ping that found the cache gone leaves the band cold', { plugins: [pinger] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { keep: true, fork: { read: 0, write: 200000 } })
  await seed($, 0)
  await clock.advance(50 * MIN)
  await $.command.run({ command: 'ping', args: '', ...RUN })
  await clock.advance(30 * MIN)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ text: ' COLD ' })).toBeDefined()
  await band.unmount()
})

test('a ping the API refused leaves the clock alone', { plugins: [pinger] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { keep: true, fork: null })
  await seed($, 0)
  await clock.advance(50 * MIN)
  await $.command.run({ command: 'ping', args: '', ...RUN })
  await clock.advance(30 * MIN)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ text: ' COLD ' })).toBeDefined()
  await band.unmount()
})

test('the switch turns keep-warm off and on again through cache-tax, and remembers it', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { store, ran } = engine(on, { keep: true })
  await seed($, 18)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ key: 'keep-warm' }))?.props.label).toBe('Keep warm: on')

  await band.press({ key: 'keep-warm' })
  expect((await band.find({ key: 'keep-warm' }))?.props.label).toBe('Keep warm: off')
  expect(store.get('keep')).toBe(false)
  expect(ran).toEqual(['keepwarm off'])

  await band.press({ key: 'keep-warm' })
  expect((await band.find({ key: 'keep-warm' }))?.props.label).toBe('Keep warm: on')
  expect(store.get('keep')).toBe(true)
  expect(ran).toEqual(['keepwarm off', 'keepwarm always'])
  await band.unmount()
})

test('the switch shows in the terminal too, and before the first reply', async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on, { keep: false })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ key: 'keep-warm' }))?.props.label).toBe('Keep warm: off')
  await band.unmount()
})

test('the first session ever stores nothing and runs nothing; the switch reads off', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { store, ran } = engine(on)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await clock.advance(5000)
  expect(store.has('keep')).toBe(false)
  expect(ran).toEqual([])
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ key: 'keep-warm' }))?.props.label).toBe('Keep warm: off')
  await band.unmount()
})

test('a later session leaves a saved choice alone', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { store, ran } = engine(on, { keep: false })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await clock.advance(5000)
  expect(store.get('keep')).toBe(false)
  expect(ran).toEqual([])
})

test('a typed /keepwarm off or always moves the switch', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { store } = engine(on, { keep: true })
  await seed($, 18)
  await $.command.run({ command: 'keepwarm', args: 'off', ...RUN })
  expect(store.get('keep')).toBe(false)
  await $.command.run({ command: 'keepwarm', args: 'always', ...RUN })
  expect(store.get('keep')).toBe(true)
  // A timed window is neither: the switch stays where it was.
  await $.command.run({ command: 'keepwarm', args: '3h', ...RUN })
  expect(store.get('keep')).toBe(true)
})

test('without cache-tax there is no switch', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { ran } = engine(on, { commands: [] })
  await seed($, 18)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ key: 'keep-warm' })).toBeUndefined()
  expect(ran).toEqual([])
  await band.unmount()
})

test('the band and the card paint no background of their own', async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on, { keep: true })
  await seed($, 3 * 24 * 60)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const card = await band.find({ key: 'card' })
  expect(card).toBeDefined()
  const tree = JSON.stringify([card, await band.findAll({ type: 'Box' })])
  expect(tree).not.toContain(BG)
  expect(tree).not.toContain('backgroundColor')
  await band.unmount()
})

test('Wrap up runs the debrief, then lets this conversation go cold while the switch stays on', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { store, ran } = engine(on, { keep: true, commands: ['keepwarm', 'cache-tax', 'debrief'], prefill: WRAP })
  on('turn.step', async function* ($, e) {
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  await seed($, 18)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ key: 'wrap-up' }))?.props.label).toBe('Wrap up')

  await band.press({ key: 'wrap-up' })
  expect(ran).toEqual(['debrief'])
  expect((await band.find({ key: 'wrap-up' }))?.props.label).toBe('Wrapping up…')
  // A second press while it runs asks for nothing more.
  await band.press({ key: 'wrap-up' })
  expect(ran).toEqual(['debrief'])

  // The debrief's own turn starts and ends; only then is the cache let go.
  for await (const c of $.turn.step({ turnId: 'T9', index: 0, model: 'claude-opus-5-5', messageCount: 4 })) void c
  await clock.advance(5000)
  expect(ran).toEqual(['debrief'])
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: 'ok', usage: null, durationMs: 1000 })
  await clock.advance(5000)
  expect(ran).toEqual(['debrief', 'keepwarm 1m'])
  expect(store.get('keep')).toBe(true)
  expect((await band.find({ key: 'wrap-up' }))?.props.label).toBe('Wrap up')
  await band.unmount()
})

test('a turn already running when Wrap up is pressed does not end the conversation early', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { ran } = engine(on, { keep: true, commands: ['keepwarm', 'debrief'], prefill: WRAP })
  await seed($, 18)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'wrap-up' })
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: 'ok', usage: null, durationMs: 1000 })
  await clock.advance(5000)
  expect(ran).toEqual(['debrief'])
  await band.unmount()
})

test('with keep-warm off, Wrap up only runs the debrief; without the debrief skill there is no button', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { ran } = engine(on, { keep: false, commands: ['keepwarm', 'debrief'], prefill: WRAP })
  on('turn.step', async function* ($, e) {
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  await seed($, 18)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'wrap-up' })
  for await (const c of $.turn.step({ turnId: 'T9', index: 0, model: 'claude-opus-5-5', messageCount: 4 })) void c
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: 'ok', usage: null, durationMs: 1000 })
  await clock.advance(5000)
  expect(ran).toEqual(['debrief'])
  await band.unmount()
})

test('without the debrief skill there is no Wrap up button', async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on, { keep: true, prefill: WRAP })
  await seed($, 18)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ key: 'wrap-up' })).toBeUndefined()
  await band.unmount()
})

const USED = { model: 'claude-opus-5-5', input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 2e6, cache_creation_input_tokens: 1e6 }
const done = ($: Parameters<Parameters<typeof test>[1]>[0], extra: object) =>
  ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: 'ok', durationMs: 1000, ...extra })

test('a turn is priced at list prices, with cache writes at the 1-hour rate', () => {
  // Opus 5.5: 4 in + 20 out + 2 x 0.20 read + 8 write, per million.
  expect(usd(turnCost(USED) ?? -1)).toBe(usd(32.4))
  expect(usd(turnCost({ ...USED, model: 'claude-haiku-5-5' }) ?? -1)).toBe(usd(0.5 + 2.5 + 0.1 + 1))
  // The turn's model wins; the fallback prices a turn that names none.
  expect(usd(turnCost({ ...USED, model: null }, 'claude-sonnet-5-5') ?? -1)).toBe(usd(2 + 10 + 0.4 + 4))
  expect(turnCost({ ...USED, model: 'some-other-model' })).toBe(null)
  expect(turnCost(null)).toBe(null)
})

test("the band adds up the conversation's cost, the main session's and its subagents'", async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on, { keep: true })
  await seed($, 18)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ key: 'spend' })).toBeUndefined()

  await done($, { usage: USED })
  expect(await band.find({ text: '≈$32.40' })).toBeDefined()
  await done($, { usage: { ...USED, model: 'claude-haiku-5-5' }, agentId: 'sub1' })
  expect(await band.find({ text: '≈$36.50' })).toBeDefined()
  // A turn that reports no usage, or a model the table does not price, adds nothing.
  await done($, { usage: null })
  await done($, { usage: { ...USED, model: 'some-other-model' } })
  expect(await band.find({ text: '≈$36.50' })).toBeDefined()
  await band.unmount()
})

test('Wrap up puts the cost in the transcript before the debrief runs', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { ran } = engine(on, { keep: true, commands: ['keepwarm', 'debrief'], prefill: WRAP })
  const logs: string[] = []
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  await seed($, 18)
  await done($, { usage: USED })
  await done($, { usage: { ...USED, model: 'claude-haiku-5-5' }, agentId: 'sub1' })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'wrap-up' })
  expect(logs).toEqual([
    'this conversation has cost about $36.50 so far (main session $32.40, subagents $4.10). ' +
      'An estimate from token counts at list prices, since this session started or was last resumed; not a bill.',
  ])
  expect(ran).toEqual(['debrief'])
  await band.unmount()
})

const DAY = 24 * 60 * MIN
const FRESH = (main: number, subs = 0, last = 0, at = NOW) => ({ main, subs, last, at })
const figures = (store: Map<string, unknown>) => {
  const s = store.get('spend:S1') as { main: number; subs: number; last: number; at: number }
  expect(s.at).toBe(NOW)
  return [usd(s.main), usd(s.subs), usd(s.last)]
}

test('the cost is kept in the store per session and shown straight after a restart', async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on, { keep: true, prefill: { 'spend:S1': FRESH(12.4, 0, 0.35) } })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...PROPS, bodyColumns: 160 } })
  expect(await band.find({ text: '≈$12.40' })).toBeDefined()
  expect(await band.find({ text: ' · last $0.35' })).toBeDefined()
  await band.unmount()
})

test('the store holds main, subs, last and when; last is the latest main turn plus subagent turns since the one before', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { store } = engine(on, { keep: true })
  await seed($, 18)
  const HAIKU = { ...USED, model: 'claude-haiku-5-5' }
  // A subagent finishes before the first main turn: it counts toward that turn's last.
  await done($, { usage: HAIKU, agentId: 'sub1' })
  await done($, { usage: USED })
  expect(figures(store)).toEqual(['$32.40', '$4.10', '$36.50'])
  await done($, { usage: USED })
  expect(figures(store)).toEqual(['$64.80', '$4.10', '$32.40'])

  const band = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...PROPS, bodyColumns: 160 } })
  expect(await band.find({ text: '≈$68.90' })).toBeDefined()
  expect(await band.find({ text: ' · last $32.40' })).toBeDefined()
  await band.unmount()
})

test('without a last turn the last part is left out; stacked layouts put it under the total', async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on, { keep: true, prefill: { 'spend:S1': FRESH(2, 1, 0) } })
  await seed($, 18)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...PROPS, bodyColumns: 160 } })
  expect(await band.find({ text: '≈$3.00' })).toBeDefined()
  expect(await band.find({ key: 'spend-last' })).toBeUndefined()
  await band.unmount()

  await done($, { usage: { ...USED, model: 'claude-haiku-5-5' } })
  const tight = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...PROPS, bodyColumns: 60 } })
  expect(await tight.find({ text: 'last $4.10' })).toBeDefined()
  await tight.unmount()
})

test('two sessions keep separate totals', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { session } = engine(on, { keep: true })
  await seed($, 18)
  await done($, { usage: USED })
  session.id = 'S2'
  await done($, { usage: { ...USED, model: 'claude-haiku-5-5' } })
  const b = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await b.find({ text: '≈$4.10' })).toBeDefined()
  await b.unmount()
  session.id = 'S1'
  const a = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await a.find({ text: '≈$32.40' })).toBeDefined()
  await a.unmount()
})

test('an entry older than 30 days is pruned at session start; a recent one is kept', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { store } = engine(on, {
    keep: true,
    prefill: { 'spend:old': FRESH(1, 0, 0, NOW - 31 * DAY), 'spend:recent': FRESH(1, 0, 0, NOW - 29 * DAY), other: 'x' },
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  expect(store.has('spend:old')).toBe(false)
  expect(store.has('spend:recent')).toBe(true)
  expect(store.get('other')).toBe('x')
})

test('a session id that cannot be read leaves the band without a cost and throws nothing', async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on, { keep: true, idThrows: true })
  await seed($, 18)
  await done($, { usage: USED })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ key: 'spend' })).toBeUndefined()
  await band.unmount()
})

test('Wrap up is absent by default and appears after /wavebar wrapup on', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { store } = engine(on, { keep: true, commands: ['keepwarm', 'debrief'] })
  await seed($, 18)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ key: 'wrap-up' })).toBeUndefined()
  const r = await $.command.run({ command: 'wavebar', args: 'wrapup on', ...RUN })
  expect(store.get('wrapUp')).toBe(true)
  expect(JSON.stringify(r)).toContain('wrapup')
  expect(await band.find({ key: 'wrap-up' })).toBeDefined()
  await $.command.run({ command: 'wavebar', args: 'wrapup off', ...RUN })
  expect(store.get('wrapUp')).toBe(false)
  expect(await band.find({ key: 'wrap-up' })).toBeUndefined()
  await band.unmount()
})

test('/wavebar registers itself, reports status, and answers anything else with usage', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { store, registered } = engine(on, { keep: true })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  expect(registered).toContain('wavebar')
  const text = async (args: string) => ((await $.command.run({ command: 'wavebar', args, ...RUN })) as { text: string }).text
  const status = await text('')
  expect(status).toContain('wrapup: off')
  expect(status).toContain('hold: on')
  expect(await text('status')).toBe(status)
  await text('hold off')
  expect(store.get('hold')).toBe(false)
  expect(await text('status')).toContain('hold: off')
  await text('hold on')
  expect(store.get('hold')).toBe(true)
  const usage = await text('nonsense')
  expect(usage).toContain('Usage')
  expect(usage.includes('\n')).toBe(false)
})

test('a command that fails to register does not stop the rest of session start', async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on, { keep: true, registerThrows: true })
  const registered: string[] = []
  on('tool.register', ($, e) => { registered.push(e.name); return { value: { tool: `mcp__wavebar__${e.name}` } } })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  expect(registered).toEqual(['progress'])
})
