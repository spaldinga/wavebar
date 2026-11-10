import type { EngineInterface } from 'claude-code'

// Hold and show: a git command that throws work away is held before it runs, and
// the band shows what it would lose, with Proceed and Cancel. The idea, and the way
// each command is measured, follow Blast Radius (Anthropic, claude-code-playground,
// Apache-2.0); this version reads Bash and PowerShell command lines alike and asks
// only git, so it needs no Unix tools.
//
// It reads the command's text and is a second look, not a lock: a command inside
// `bash -c "..."`, a script or an alias is not seen. Permission rules stay the guard.

export type RiskKind = 'reset' | 'checkout' | 'clean' | 'push'

/** A risky git command: what kind, its own arguments, the folder it runs in when the line moved there, and its name for the band. */
export type Risk = { kind: RiskKind; args: string[]; dir: string | null; label: string }

/** What the command would lose: one line, the first few items, how many more, and where the figures came from. */
export type Report = { summary: string; lines: string[]; more: number; note: string }

export const LIST_MAX = 6

/** Words of one command, quotes taken off. Enough for the commands held here; not a shell parser. */
const wordsOf = (segment: string): string[] =>
  (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(w => (/^(".*"|'.*')$/.test(w) ? w.slice(1, -1) : w))

const isForce = (a: string): boolean =>
  a === '-f' || a === '--force' || a.startsWith('--force-with-lease') || a.startsWith('--force-if-includes') || (/^-[a-zA-Z]+$/.test(a) && a.includes('f'))

/** The risk in one git command's arguments (after `git` and any -C), or null. */
const gitRisk = (args: string[], dir: string | null): Risk | null => {
  const [verb, ...rest] = args
  if (verb === 'reset' && rest.includes('--hard')) return { kind: 'reset', args: rest, dir, label: 'git reset --hard' }
  if (verb === 'clean') {
    const isDry = rest.some(a => a === '-n' || a === '--dry-run' || (/^-[a-zA-Z]+$/.test(a) && a.includes('n')))
    return rest.some(isForce) && !isDry ? { kind: 'clean', args: rest, dir, label: 'git clean' } : null
  }
  if (verb === 'push') {
    const forced = rest.some(a => a.startsWith('--force') || a === '-f' || (!a.startsWith('-') && a.startsWith('+')))
    return forced ? { kind: 'push', args: rest, dir, label: 'git push --force' } : null
  }
  // checkout -- <paths>, checkout ., restore <paths>: throw away unstaged changes. Switching branch does not.
  if (verb === 'checkout') {
    const at = rest.indexOf('--')
    const paths = at >= 0 ? rest.slice(at + 1) : rest.filter(a => a === '.')
    return paths.length ? { kind: 'checkout', args: rest, dir, label: 'git checkout (discard changes)' } : null
  }
  if (verb === 'restore') {
    const onlyStaged = rest.includes('--staged') && !rest.includes('--worktree') && !rest.includes('-W')
    const paths = rest.filter(a => !a.startsWith('-'))
    return paths.length && !onlyStaged ? { kind: 'checkout', args: rest, dir, label: 'git restore (discard changes)' } : null
  }
  return null
}

/** The first risky git command on a command line, Bash or PowerShell, or null when there is none. */
export const classify = (command: string): Risk | null => {
  let dir: string | null = null
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = wordsOf(segment.trim())
    if (!words.length) continue
    const head = words[0].toLowerCase()
    // The line moved first: measure there. Only a plain folder; anything else is measured where the session is.
    if ((head === 'cd' || head === 'pushd' || head === 'set-location' || head === 'sl') && words[1] && !words[1].startsWith('-')) {
      dir = words[1]
      continue
    }
    if (head !== 'git' && head !== 'git.exe') continue
    let args = words.slice(1)
    let at = dir
    while (args[0] === '-C' && args[1]) {
      at = args[1]
      args = args.slice(2)
    }
    // Other options before the verb (-c name=value, --no-pager) are stepped over.
    while (args[0]?.startsWith('-')) args = args.slice(args[0] === '-c' ? 2 : 1)
    const risk = gitRisk(args, at)
    if (risk) return risk
  }
  return null
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Runs git where the command would run. Paths go as arguments, so nothing in them runs as shell. */
async function git($: EngineInterface, risk: Risk, cwd: string, args: string[]) {
  return $.process.run(['git', ...(risk.dir ? ['-C', risk.dir] : []), ...args], { cwd, timeoutMs: 15000 })
}

const listed = (items: string[]): Pick<Report, 'lines' | 'more'> => ({ lines: items.slice(0, LIST_MAX), more: Math.max(0, items.length - LIST_MAX) })

async function measureClean($: EngineInterface, risk: Risk, cwd: string): Promise<Report> {
  const flags = risk.args.filter(a => a.startsWith('-') && a !== '--')
  const paths = risk.args.filter(a => !a.startsWith('-'))
  const run = await git($, risk, cwd, ['clean', '-n', ...flags, '--', ...paths])
  if (run.exitCode !== 0) return { summary: 'git clean (could not dry-run it)', lines: [], more: 0, note: run.stderr.trim().slice(0, 200) }
  const gone = run.stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('Would remove ')).map(l => l.slice(13))
  return {
    summary: gone.length ? `remove ${plural(gone.length, 'untracked path', 'untracked paths')}` : 'remove nothing: no untracked files match',
    ...listed(gone),
    note: "From git clean -n. Untracked files are not in git, so they can't be recovered.",
  }
}

async function measureDiscard($: EngineInterface, risk: Risk, cwd: string): Promise<Report> {
  const status = await git($, risk, cwd, ['status', '--porcelain'])
  if (status.exitCode !== 0) return { summary: `${risk.label} (not a git repo here?)`, lines: [], more: 0, note: status.stderr.trim().slice(0, 200) }
  const rows = status.stdout.split('\n').filter(l => l.length > 3 && !l.startsWith('??'))
  // reset --hard drops staged and unstaged changes; checkout and restore drop unstaged ones.
  const lost = risk.kind === 'reset' ? rows : rows.filter(l => l[1] !== ' ')
  const stat = await git($, risk, cwd, ['diff', '--shortstat', ...(risk.kind === 'reset' ? ['HEAD'] : [])])
  const shortstat = stat.exitCode === 0 ? stat.stdout.trim() : ''
  return {
    summary: lost.length ? `discard uncommitted changes in ${plural(lost.length, 'file', 'files')}` : 'discard nothing: no uncommitted changes',
    ...listed(lost.map(l => `${l.slice(0, 2)} ${l.slice(3)}`)),
    note: shortstat ? `${shortstat}. Uncommitted changes can't be recovered.` : 'From git status --porcelain.',
  }
}

async function measurePush($: EngineInterface, risk: Risk, cwd: string): Promise<Report> {
  const positional = risk.args.filter(a => !a.startsWith('-'))
  const remote = positional[0] ?? 'origin'
  // A refspec is src:dst. With no colon, the local branch of the same name is pushed.
  const spec = (positional[1] ?? '').replace(/^\+/, '')
  let [source, branch] = spec.includes(':') ? spec.split(':') : [spec, spec]
  branch = (branch ?? '').replace(/^refs\/heads\//, '')
  if (!branch || branch === 'HEAD') {
    branch = (await git($, risk, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
    source = 'HEAD'
  }
  source = source || 'HEAD'
  const ref = `${remote}/${branch}`
  const known = await git($, risk, cwd, ['rev-parse', '--verify', '--quiet', ref])
  if (known.exitCode !== 0) {
    return { summary: `force-push to ${ref}`, lines: [], more: 0, note: `No local copy of ${ref}, so the commits the push would drop can't be listed. Run git fetch first.` }
  }
  const log = await git($, risk, cwd, ['log', '--oneline', '--no-decorate', `${source}..${ref}`])
  const dropped = log.stdout.split('\n').map(l => l.trim()).filter(Boolean)
  return {
    summary: dropped.length ? `force-push to ${ref}: drops ${plural(dropped.length, 'commit', 'commits')}` : `force-push to ${ref}: drops no commits`,
    ...listed(dropped),
    note: `Commits on ${ref} that ${source} doesn't have, as of the last fetch.`,
  }
}

/** What the held command would lose. A measure that fails still gives a report, so the question is always asked. */
export async function measure($: EngineInterface, risk: Risk, cwd: string): Promise<Report> {
  try {
    if (risk.kind === 'clean') return await measureClean($, risk, cwd)
    if (risk.kind === 'push') return await measurePush($, risk, cwd)
    return await measureDiscard($, risk, cwd)
  } catch {
    return { summary: risk.label, lines: [], more: 0, note: "Couldn't measure what this would change." }
  }
}

/** The line Claude reads when a held command is refused. */
export const refusal = (why: string, summary: string): string =>
  `ribbon held this command and did not run it: ${why}. It would have: ${summary}. Do not retry it unless the user asks you to.`
