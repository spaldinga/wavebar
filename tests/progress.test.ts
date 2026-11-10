import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { afterListCall, afterReport, fromSteps, pulseText, ratioOf } from '../hooks/progress'

const NOW = Date.parse('2098-12-31T22:00:00Z')
const PLAN = 'mcp__ccd_turn__update_plan'
const REPORT = 'mcp__ribbon__progress'
const props = (isWorking: boolean, bodyColumns = 160) => ({
  hasSurvey: false,
  isWorking,
  maxRows: 12,
  bodyColumns,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
})
const ITEMS = [
  { content: 'Read the code', status: 'completed' },
  { content: 'Write tests', status: 'in_progress' },
  { content: 'Write the fix', status: 'pending' },
  { content: 'Run tests', status: 'pending' },
]

type T$ = Parameters<Parameters<typeof test>[1]>[0]

const engine = (on: On) => {
  mock.store(on, { keep: true })
  const registered: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000, tokens: 200000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('command.list', () => ({ value: [] }))
  on('tool.register', ($, e) => { registered.push(e.name); return { value: { tool: `mcp__ribbon__${e.name}` } } })
  on('tool.call', () => ({ result: 'beneath' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return { registered }
}

const step = async ($: T$, index: number) => {
  for await (const c of $.turn.step({ turnId: 'T1', index, model: 'claude-opus-5-5', messageCount: 2 + index })) void c
}

const start = ($: T$) => $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })

test('a whole list counts what is done and names the step in progress', () => {
  const p = afterListCall(null, PLAN, { items: ITEMS })
  expect(p).toMatchObject({ done: 1, total: 4, note: 'Write tests', hasCurrent: true, isFinished: false })
  // One done and one under way of four: Robo is between the first and second marks.
  expect(ratioOf(p!)).toBe(0.375)
})

test('advance, done and start move the list the way the plan tool does', () => {
  let p = afterListCall(null, PLAN, { items: ITEMS })
  p = afterListCall(p, PLAN, { advance: true })
  expect(p).toMatchObject({ done: 2, note: 'Write the fix' })
  p = afterListCall(p, PLAN, { done: [3], start: 4 })
  expect(p).toMatchObject({ done: 3, note: 'Run tests', isFinished: false })
  p = afterListCall(p, PLAN, { advance: true })
  expect(p).toMatchObject({ done: 4, total: 4, hasCurrent: false, isFinished: true })
  expect(ratioOf(p!)).toBe(1)
})

test('the terminal task tools build the same list', () => {
  const todo = afterListCall(null, 'TodoWrite', { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }] })
  expect(todo).toMatchObject({ done: 1, total: 2, note: 'B' })

  let p = afterListCall(null, 'TaskCreate', { subject: 'First' })
  p = afterListCall(p, 'TaskCreate', { subject: 'Second' })
  p = afterListCall(p, 'TaskUpdate', { taskId: '1', status: 'completed' })
  p = afterListCall(p, 'TaskUpdate', { taskId: '2', status: 'in_progress' })
  expect(p).toMatchObject({ done: 1, total: 2, note: 'Second' })
  // A task the list never saw changes nothing.
  expect(afterListCall(p, 'TaskUpdate', { taskId: '9', status: 'completed' })).toEqual(p)
})

test('input outside the schema cannot break the list', () => {
  const p = afterListCall(null, PLAN, { items: [null, 7, { content: 42, status: 'weird' }, { content: 'x'.repeat(500) }] })
  expect(p).toMatchObject({ done: 0, total: 2 })
  expect(p!.steps[1].title.length).toBe(80)
  expect(afterListCall(fromSteps([]), PLAN, { done: ['a', -3, 99], start: 'no' })).toMatchObject({ total: 0 })
})

test('a report keeps what it leaves out and never passes its total', () => {
  let p = afterReport(null, { total: 5, done: 2, note: 'Parsing' })
  expect(p).toMatchObject({ done: 2, total: 5, note: 'Parsing', hasCurrent: true })
  p = afterReport(p, { done: 9 })
  expect(p).toMatchObject({ done: 5, total: 5, note: 'Parsing', isFinished: true })
  expect(afterReport(afterReport(null, { total: 3, done: 1 }), { finished: true })).toMatchObject({ done: 3, isFinished: true, note: '' })
})

test('the pulse line says how many requests and how long', () => {
  expect(pulseText({ startedAt: NOW, steps: 1 }, NOW + 4000)).toBe('working · 1 step · 4s')
  expect(pulseText({ startedAt: NOW, steps: 4 }, NOW + 72000)).toBe('working · 4 steps · 1m 12s')
})

test('the desktop band draws Robo on the bar from the task list, and lets the call through', async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on)
  await start($)
  await step($, 0)
  expect(await $.tool.call({ tool: PLAN, items: ITEMS } as never)).toMatchObject({ result: 'beneath' })

  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: props(true) })
  const bar = (await band.findAll({ type: 'Svg' })).find(s => String(s.props.alt).startsWith('Progress'))
  expect(bar?.props.alt).toBe('Progress: 1 of 4 done. Now: Write tests')
  expect(await band.find({ text: ' 1/4' })).toBeDefined()
  expect(await band.find({ text: ' · Write tests' })).toBeDefined()

  await $.tool.call({ tool: PLAN, advance: true } as never)
  expect(await band.find({ text: ' 2/4' })).toBeDefined()
  expect(await band.find({ text: ' · Write the fix' })).toBeDefined()
  await band.unmount()
})

test('the terminal draws the bar as text', async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: ITEMS } as never)
  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'terminal', component: 'AbovePrompt', props: props(true, 100) })
  expect(await band.find({ text: /^[▰▱]+$/ })).toBeDefined()
  expect(await band.find({ text: ' 1/4' })).toBeDefined()
  expect(await band.findAll({ type: 'Svg' })).toEqual([])
  await band.unmount()
})

test("the mod's own tool reports progress, for the main session only", async ($, on) => {
  mock.clock(on, { now: NOW })
  const { registered } = engine(on)
  await start($)
  expect(registered).toEqual(['progress'])
  expect(await $.tool.call({ tool: REPORT, total: 5, done: 2, note: 'Parsing' } as never)).toMatchObject({ result: 'ok: 2/5' })
  const sub = { tool: REPORT, total: 9, done: 9, agentId: 'sub1' }
  expect(await $.tool.call(sub as never)).toMatchObject({ result: 'ignored: only the main session reports progress' })

  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: props(true) })
  expect(await band.find({ text: ' 2/5' })).toBeDefined()
  await band.unmount()
})

test('a subagent keeping its own list does not move the bar', async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: ITEMS } as never)
  const sub = { tool: 'TodoWrite', todos: [{ content: 'Sub', status: 'completed' }], agentId: 'sub1' }
  await $.tool.call(sub as never)
  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: props(true) })
  expect(await band.find({ text: ' 1/4' })).toBeDefined()
  await band.unmount()
})

test('with no list, a working turn shows Robo pacing with steps and time; an idle one shows nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on)
  await start($)
  await step($, 0)
  await clock.advance(72000)
  await step($, 1)

  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: props(true) })
  const alts = (await band.findAll({ type: 'Svg' })).map(s => String(s.props.alt))
  expect(alts).toContain('Working')
  expect(await band.find({ text: ' working · 2 steps · 1m 12s' })).toBeDefined()
  await band.unmount()

  const idle = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: props(false) })
  expect((await idle.findAll({ type: 'Svg' })).map(s => String(s.props.alt))).not.toContain('Working')
  expect(await idle.find({ text: / working · / })).toBeUndefined()
  await idle.unmount()
})

test('a finished list stays until the next request starts, then clears', async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on)
  await start($)
  await step($, 0)
  await $.tool.call({ tool: PLAN, items: ITEMS.map(i => ({ ...i, status: 'completed' })) } as never)

  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: props(false) })
  expect(await band.find({ text: ' 4/4' })).toBeDefined()
  expect(await band.find({ text: ' · done' })).toBeDefined()

  await step($, 0)
  expect(await band.find({ text: ' 4/4' })).toBeUndefined()
  await band.unmount()
})

test('a narrow band gives the bar a row of its own', async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: ITEMS } as never)
  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: props(true, 60) })
  expect(await band.find({ key: 'progress-row' })).toBeDefined()
  expect(await band.find({ text: ' 1/4' })).toBeDefined()
  await band.unmount()
})
