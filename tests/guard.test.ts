import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { classify } from '../hooks/guard'
import { resetHold } from '../hooks/register'

const NOW = Date.parse('2098-12-31T22:00:00Z')
const PROPS = { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} } as const
const BAND = { plugin: 'wavebar', surface: 'desktop', component: 'AbovePrompt', props: PROPS } as const

type T$ = Parameters<Parameters<typeof test>[1]>[0]
type Clock = ReturnType<typeof mock.clock>

test('git commands that throw work away are risky; the everyday ones are not', () => {
  const kind = (c: string) => classify(c)?.kind ?? null
  expect(kind('git reset --hard')).toBe('reset')
  expect(kind('git reset --hard HEAD~3')).toBe('reset')
  expect(kind('git checkout -- .')).toBe('checkout')
  expect(kind('git checkout .')).toBe('checkout')
  expect(kind('git restore src/app.cs')).toBe('checkout')
  expect(kind('git clean -fdx')).toBe('clean')
  expect(kind('git push --force origin main')).toBe('push')
  expect(kind('git push -f')).toBe('push')
  expect(kind('git push --force-with-lease')).toBe('push')
  expect(kind('git push origin +main')).toBe('push')

  expect(kind('git status')).toBe(null)
  expect(kind('git reset --soft HEAD~1')).toBe(null)
  expect(kind('git reset HEAD file.cs')).toBe(null)
  expect(kind('git checkout main')).toBe(null)
  expect(kind('git checkout -b feature/x')).toBe(null)
  expect(kind('git restore --staged file.cs')).toBe(null)
  expect(kind('git clean -n')).toBe(null)
  expect(kind('git clean -nfd')).toBe(null)
  expect(kind('git push origin main')).toBe(null)
  expect(kind('dotnet test')).toBe(null)
  expect(kind('')).toBe(null)
})

test('the folder the line moved to is where it is measured, in Bash and in PowerShell', () => {
  expect(classify('cd src/api && git reset --hard')).toMatchObject({ kind: 'reset', dir: 'src/api' })
  expect(classify('Set-Location "C:\\repos\\my app"; git clean -fd')).toMatchObject({ kind: 'clean', dir: 'C:\\repos\\my app' })
  expect(classify('git -C ../other reset --hard')).toMatchObject({ kind: 'reset', dir: '../other' })
  expect(classify('git --no-pager -c core.pager=cat reset --hard')).toMatchObject({ kind: 'reset', dir: null })
  // The first risky command on the line is the one shown.
  expect(classify('git status; git stash && git clean -fd; git reset --hard')).toMatchObject({ kind: 'clean' })
})

/** The engine beneath: git answers from a table, and a wait moves the clock. */
const engine = (on: On, clock: Clock, opts: { git?: Record<string, string>; waits?: boolean; waitMs?: number; hold?: boolean } = {}) => {
  resetHold()
  mock.store(on, opts.hold === undefined ? { keep: true } : { keep: true, hold: opts.hold })
  const ran: string[] = []
  const logs: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:/work' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('command.list', () => ({ value: [] }))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('tool.call', () => ({ result: 'ran' }))
  on('process.run', async ($, e) => {
    const line = e.argv.join(' ')
    if (e.argv[0] !== 'git') {
      if (opts.waits === false) return { deny: 'not found' }
      // Only the wait this machine has is answered, as on Windows where there is no sleep.
      if (e.argv[0] === 'sleep') return { deny: 'not found' }
      await clock.advance(opts.waitMs ?? 1000)
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    ran.push(line)
    const key = Object.keys(opts.git ?? {}).find(k => line.includes(k))
    return { value: { exitCode: 0, stdout: key ? opts.git![key] : '', stderr: '' } }
  })
  return { ran, logs }
}

/** The band once the held command is drawn in it. */
const heldBand = async ($: T$) => {
  const band = await $.ui.mount(BAND)
  for (let i = 0; i < 50 && !(await band.find({ key: 'held-proceed' })); i++) await new Promise(r => setTimeout(r, 5))
  return band
}

const DIRTY = { 'status --porcelain': ' M src/app.cs\nM  src/api.cs\n?? notes.txt\n', 'diff --shortstat': ' 2 files changed, 40 insertions(+), 3 deletions(-)\n' }

for (const tool of ['Bash', 'PowerShell'] as const) {
  test(`${tool}: a hard reset is held with what it would discard, and Proceed runs it`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { ran } = engine(on, clock, { git: DIRTY })
    const call = $.tool.call({ tool, command: 'git reset --hard' } as never)
    const band = await heldBand($)

    expect(await band.find({ text: ' HELD ' })).toBeDefined()
    expect(await band.find({ text: ' git reset --hard' })).toBeDefined()
    expect(await band.find({ text: 'Would discard uncommitted changes in 2 files' })).toBeDefined()
    expect(await band.find({ text: '   M src/app.cs' })).toBeDefined()
    expect(await band.find({ text: "2 files changed, 40 insertions(+), 3 deletions(-). Uncommitted changes can't be recovered." })).toBeDefined()
    expect(ran).toEqual(['git status --porcelain', 'git diff --shortstat HEAD'])

    await band.press({ key: 'held-proceed' })
    expect(await call).toMatchObject({ result: 'ran' })
    // The band is the usual one again.
    expect(await band.find({ key: 'held-proceed' })).toBeUndefined()
    await band.unmount()
  })
}

test('Cancel refuses the command and tells Claude why', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, clock, { git: { 'clean -n': 'Would remove build/\nWould remove notes.txt\n' } })
  const call = $.tool.call({ tool: 'Bash', command: 'cd api && git clean -fd' } as never)
  const band = await heldBand($)
  expect(await band.find({ text: 'Would remove 2 untracked paths' })).toBeDefined()
  await band.press({ key: 'held-cancel' })
  expect(await call).toMatchObject({
    deny: 'wavebar held this command and did not run it: the user pressed Cancel. It would have: remove 2 untracked paths. Do not retry it unless the user asks you to.',
  })
  await band.unmount()
})

test('a force push shows the commits it would drop, measured in the folder the line names', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { ran } = engine(on, clock, { git: { 'rev-parse --abbrev-ref': 'main\n', 'log --oneline': 'abc1234 Fix the parser\ndef5678 Add tests\n' } })
  const call = $.tool.call({ tool: 'PowerShell', command: 'git -C ../svc push --force' } as never)
  const band = await heldBand($)
  expect(await band.find({ text: 'Would force-push to origin/main: drops 2 commits' })).toBeDefined()
  expect(await band.find({ text: '  abc1234 Fix the parser' })).toBeDefined()
  expect(ran[ran.length - 1]).toBe('git -C ../svc log --oneline --no-decorate HEAD..origin/main')
  await band.press({ key: 'held-cancel' })
  await call
  await band.unmount()
})

test('no answer within ten minutes refuses the command', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, clock, { git: DIRTY, waitMs: 4 * 60 * 1000 })
  expect(await $.tool.call({ tool: 'Bash', command: 'git reset --hard' } as never)).toMatchObject({
    deny: 'wavebar held this command and did not run it: no answer within 10 minutes. It would have: discard uncommitted changes in 2 files. Do not retry it unless the user asks you to.',
  })
})

test('a machine with no way to wait lets the command through, with a note', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { logs } = engine(on, clock, { git: DIRTY, waits: false })
  expect(await $.tool.call({ tool: 'Bash', command: 'git reset --hard' } as never)).toMatchObject({ result: 'ran' })
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('git reset --hard')
})

test('a command that is not risky is never held or measured', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { ran } = engine(on, clock)
  expect(await $.tool.call({ tool: 'Bash', command: 'git status && dotnet test' } as never)).toMatchObject({ result: 'ran' })
  expect(ran).toEqual([])
})

test('with the hold switched off in the store, a risky command goes straight through', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { ran } = engine(on, clock, { git: DIRTY, hold: false })
  for (const tool of ['Bash', 'PowerShell'] as const) {
    expect(await $.tool.call({ tool, command: 'git reset --hard' } as never)).toMatchObject({ result: 'ran' })
  }
  expect(ran).toEqual([])
})
