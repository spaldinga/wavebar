import { expect, mock, test } from 'claude-code/testing'
import type { On, Plugin } from 'claude-code'

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
const BAND = { plugin: 'ribbon', component: 'AbovePrompt', props: PROPS } as const
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
const engine = (on: On, opts: { keep?: boolean; commands?: string[]; fork?: Fork } = {}) => {
  const store = new Map<string, unknown>()
  if (opts.keep !== undefined) store.set('keep', opts.keep)
  const ran: string[] = []
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => { store.set(e.key, e.value); return { value: undefined } })
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
  return { store, ran }
}

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

test('the first session ever turns keep-warm on, once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { store, ran } = engine(on)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await clock.advance(5000)
  expect(store.get('keep')).toBe(true)
  expect(ran).toEqual(['keepwarm always'])
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
