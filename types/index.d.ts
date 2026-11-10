/** One usage window: which one, how much is used (0 to 100), when it resets. */
export type Window = { kind: string; percentUsed: number; resetsAt?: string }

/**
 * The prompt cache as the band last saw it: when the main thread last sent a
 * request (clock milliseconds), how much context the next request re-sends,
 * the model's context window, and the model.
 */
export type CacheFacts = { lastAt: number; tokens: number; window: number; model: string | null }

/** Whether the cache card is open, remembered only for the state it was set in. */
export type Fold = { mode: 'warm' | 'cold'; open: boolean }

export type StepStatus = 'pending' | 'in_progress' | 'completed'

/** One step of the request, as the task list names it. */
export type Step = { title: string; status: StepStatus }

/**
 * Where the main session is in the request: the steps of its task list (empty
 * when it reported counts through the mod's tool instead), how many are done of
 * how many, the step in progress, and whether one is.
 */
export type Progress = { steps: Step[]; done: number; total: number; note: string; hasCurrent: boolean; isFinished: boolean }

/** The turn in flight: when its first request went out and how many requests it has made. */
export type Turn = { startedAt: number; steps: number }

/** One subagent of the main session: what kind it is, how many requests it has made, whether it is finished. */
export type Worker = { id: string; type: string; steps: number; isDone: boolean }

/** What this conversation has cost so far at list prices, in dollars: the main session's turns and its subagents'. */
export type Spend = { main: number; subs: number }

/** Wrapping up a conversation: asked for by the button, then running once the debrief's turn has started. */
export type Ending = 'asked' | 'running' | null

declare module 'claude-code' {
  interface PluginState {
    'ribbon': {
      windows: Window[]
      cache: CacheFacts | null
      fold: Fold | null
      progress: Progress | null
      turn: Turn | null
      crew: Worker[]
      ending: Ending
      spend: Spend
    }
  }
}
