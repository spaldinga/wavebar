import type { Progress, Step, StepStatus, Turn } from '../types'

// Where the main session is in the request, from what it already says about itself:
// the task list it keeps (the desktop app's plan, TodoWrite, the Task tools), or a
// report through this mod's own `progress` tool. Nothing here asks the model anything.

/** The task-list tools the band reads. Their calls pass through untouched. */
export const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
export const LIST_TOOLS = [PLAN_TOOL, 'TodoWrite', 'TaskCreate', 'TaskUpdate'] as const
/** This mod's own tool, as the model names it. */
export const REPORT_TOOL = 'mcp__ribbon__progress'

const MAX_STEPS = 60
const MAX_TITLE = 80

const clip = (v: unknown): string => {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''
  return s.length > MAX_TITLE ? s.slice(0, MAX_TITLE - 1) + '…' : s
}

const statusOf = (v: unknown): StepStatus => (v === 'completed' || v === 'in_progress' ? v : 'pending')

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null)

/** A list of steps as the band keeps it: counted, with the step in progress as its note. */
export const fromSteps = (steps: Step[]): Progress => {
  const list = steps.slice(0, MAX_STEPS)
  const current = list.find(s => s.status === 'in_progress')
  const done = list.filter(s => s.status === 'completed').length
  return { steps: list, done, total: list.length, note: current?.title ?? '', hasCurrent: !!current, isFinished: list.length > 0 && done === list.length }
}

const stepsOf = (items: unknown, titleKey: string): Step[] | null => {
  if (!Array.isArray(items)) return null
  return items
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
    .map(i => ({ title: clip(i[titleKey]), status: statusOf(i.status) }))
}

/** The desktop app's plan: a whole list, or a move on the one already there. */
const planCall = (prev: Step[], input: Record<string, unknown>): Step[] => {
  const whole = stepsOf(input.items, 'content')
  if (whole) return whole
  const steps = prev.map(s => ({ ...s }))
  if (input.advance === true) {
    const at = steps.findIndex(s => s.status === 'in_progress')
    if (at >= 0) steps[at].status = 'completed'
    const next = steps.findIndex(s => s.status === 'pending')
    if (next >= 0) steps[next].status = 'in_progress'
  }
  // done and start count from 1.
  if (Array.isArray(input.done)) {
    for (const n of input.done) {
      const s = steps[(int(n) ?? 0) - 1]
      if (s) s.status = 'completed'
    }
  }
  const start = steps[(int(input.start) ?? 0) - 1]
  if (start) {
    for (const s of steps) if (s.status === 'in_progress') s.status = 'completed'
    start.status = 'in_progress'
  }
  return steps
}

/** The Task tools name a task by the number it was created with. */
const taskUpdate = (prev: Step[], input: Record<string, unknown>): Step[] => {
  const at = Number(input.taskId) - 1
  if (!Number.isInteger(at) || !prev[at]) return prev
  return prev.map((s, i) =>
    i !== at ? s : { title: clip(input.subject) || s.title, status: typeof input.status === 'string' ? statusOf(input.status) : s.status },
  )
}

/** What a task-list tool call leaves the progress at; null when the call says nothing about it. */
export const afterListCall = (prev: Progress | null, tool: string, input: Record<string, unknown>): Progress | null => {
  const steps = prev?.steps ?? []
  if (tool === PLAN_TOOL) return fromSteps(planCall(steps, input))
  if (tool === 'TodoWrite') {
    const todos = stepsOf(input.todos, 'content')
    return todos ? fromSteps(todos) : prev
  }
  if (tool === 'TaskCreate') return fromSteps([...steps, { title: clip(input.subject), status: 'pending' }])
  if (tool === 'TaskUpdate') return fromSteps(taskUpdate(steps, input))
  return prev
}

/** A report through the mod's own tool. Fields left out keep their value. */
export const afterReport = (prev: Progress | null, input: Record<string, unknown>): Progress => {
  const total = int(input.total) ?? prev?.total ?? 0
  const isFinished = input.finished === true
  const done = isFinished ? total : Math.min(total || Infinity, int(input.done) ?? prev?.done ?? 0)
  const note = isFinished ? '' : input.note === undefined ? (prev?.note ?? '') : clip(input.note)
  return { steps: [], done, total, note, hasCurrent: !isFinished && done < total, isFinished: isFinished || (total > 0 && done >= total) }
}

/**
 * How far along the bar Robo stands, 0 to 1. A step in progress counts as half done,
 * so Robo is between two marks while working and on a mark when a step lands.
 */
export const ratioOf = (p: Progress): number => {
  if (p.isFinished) return 1
  if (p.total <= 0) return 0
  return Math.max(0, Math.min(1, (p.done + (p.hasCurrent ? 0.5 : 0)) / p.total))
}

/** "3/7", and the step in progress when there is one. */
export const labelOf = (p: Progress): { count: string; note: string } => ({
  count: p.isFinished ? `${p.total}/${p.total}` : `${p.done}/${p.total}`,
  note: p.isFinished ? 'done' : p.note,
})

export const fmtElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** The line for a request with no list: what is known is that it is working, for how long, over how many requests. */
export const pulseText = (t: Turn, now: number): string =>
  `working · ${t.steps} ${t.steps === 1 ? 'step' : 'steps'} · ${fmtElapsed(now - t.startedAt)}`

/** The terminal's bar: filled and empty cells. */
export const barText = (p: Progress, cells: number): string => {
  const on = Math.round(ratioOf(p) * cells)
  return '▰'.repeat(on) + '▱'.repeat(Math.max(0, cells - on))
}
