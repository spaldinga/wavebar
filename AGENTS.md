# wavebar: working notes for agents

A Claude Code mod: a band above the prompt. A fork of `robonuggets/ribbon` (MIT), installed locally as
`wavebar@wavebar` from a folder marketplace, so the app reads the files in this repo directly. It
drives `cache-tax` (keep-warm) and adds a progress bar, subagent display, session cost, a Wrap up
button and a hold for risky git commands.

## Dev loop

1. Change code in `hooks/`, tests in `tests/`. Write the test first.
2. `claude plugin test .` (no login needed) and `claude plugin validate .`
3. To see it in the app: ask the user to run `/reload-plugins` in the open session; fall back to
   restarting the app. `/reload-plugins` is the documented route but was not yet confirmed in the
   desktop app on 2026-11-10: note here whether it works once tried.
4. Ship one visible change at a time, so each is seen in the app before the next is built.

A reload re-runs `register`: `$.state` and `$.store` keep their values; module variables and
timers are lost.

## Machine gotchas (Windows, this user)

- "Failed to start server. Is port 9220 in use?" from test or validate means the shell has
  `BUN_INSPECT` set. Prefix the command with `BUN_INSPECT=` in Git Bash.
- No Python and no Node. Edit with the editor tools, not scripts.
- The test kit has no `Bun` global and no `toBeCloseTo`, and refuses dynamic `import()`.
- Host type definitions are not on disk (`.claude-plugin/types/` is written only by a
  `claude --plugin-dir .` load, which needs the CLI logged in). The mod has never been type-checked;
  call shapes were taken from other mods' tests and probe tests.
- On this managed machine `classic.SessionStart` hooks are skipped for user-installed mods. Don't
  rely on that event; use `session.start`, `turn.step`, `turn.complete` and `$.store`.

## Conventions

- `on(...)` and `$.noun.method(...)` are spelled literally; helpers that take `$` are top-level
  functions. Pure logic lives beside `register.tsx` (`progress.ts`, `guard.ts`, `cache-art.ts`).
- Calls that drive Claude (`$.command.run`) are fired, never awaited, inside a hook.
- Anything that can stop the user's work (the git hold) fails open with a note in the transcript.
- Keep the upstream MIT notice and the Blast Radius (Apache-2.0) credit in `hooks/guard.ts`.
