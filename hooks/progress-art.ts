import { EMPTY, MUTED, ORANGE, YELLOW, roboShapes, svgDoc } from './cache-art'

// The progress drawings: a line with Robo surfing along the top of it on a board. Left of
// Robo is the way come, in the band's orange running to yellow; marks stand where
// one step ends and the next begins. With no list to measure against, Robo paces
// the track instead. The line runs low in the box, leaving Robo the room above it,
// and starts at the box's left edge, so a bar on a row of its own lines up with the
// row above.

export const BAR_H = 26
const ROBO = 18
/** The board Robo stands on: it rides the top of the line, nose up, in the direction of travel. */
const BOARD_W = 24
const BOARD_H = 3
const LEAN_DEG = -7
const TRACK_H = 4
const TRACK_Y = BAR_H - TRACK_H - 2
/** Robo's feet come at about 0.94 of its box, and they stand on the board. */
const ROBO_Y = TRACK_Y - BOARD_H - ROBO * 0.94 + 0.5
/** Room at the right end for the goal's ring. */
const GOAL_R = 3.5
const END_PAD = GOAL_R + 1.5
/** Above this many steps the marks would run together, so none are drawn. */
const MAX_MARKS = 24
const PACE_W = 44
/** A subagent's Robo in the crew, and the step from one to the next. */
const CREW_ROBO = 16
const CREW_STEP = 18

const GRADIENT =
  `<defs><linearGradient id="way" x1="0" x2="1" y1="0" y2="0">` +
  `<stop offset="0" stop-color="${ORANGE}"/><stop offset="1" stop-color="${YELLOW}"/></linearGradient></defs>`

const track = (x0: number, x1: number): string =>
  `<rect x="${x0}" y="${TRACK_Y}" width="${x1 - x0}" height="${TRACK_H}" rx="${TRACK_H / 2}" fill="${EMPTY}"/>`

/** Robo's box stays inside the drawing at both ends of the track. */
const surferX = (at: number, W: number): number => Math.max(0, Math.min(W - BOARD_W - 2, at - BOARD_W / 2))

/** Robo on the board, the board's tail at x: leaning back a little, with spray off the tail. SMIL only. */
const surfer = (x: number): string => {
  const top = TRACK_Y - BOARD_H
  const cx = x + BOARD_W / 2
  const board =
    `<path d="M${x} ${TRACK_Y} Q${x + 1} ${top} ${x + 6} ${top} H${x + BOARD_W - 4} Q${x + BOARD_W} ${top} ${x + BOARD_W + 2} ${top - 1.5} ` +
    `Q${x + BOARD_W} ${TRACK_Y} ${x + BOARD_W - 5} ${TRACK_Y} Z" fill="${YELLOW}"/>`
  const spray = [0, 1]
    .map(
      i =>
        `<circle cx="${x - 1 - i * 3}" cy="${TRACK_Y - 1 - i * 2}" r="${1.1 - i * 0.3}" fill="${YELLOW}">` +
        `<animate attributeName="opacity" values="0;.9;0" dur="0.9s" begin="${i * 0.3}s" repeatCount="indefinite"/></circle>`,
    )
    .join('')
  return `<g transform="rotate(${LEAN_DEG} ${cx} ${TRACK_Y})">` + spray + board + roboShapes(cx - ROBO / 2, ROBO_Y, ROBO, 'warm') + '</g>'
}

/** Robo at `ratio` of the way along a track `W` pixels wide, with a mark between each of `steps` steps. */
export const walkSvg = (ratio: number, steps: number, W: number, isFinished: boolean): string => {
  const x0 = 0
  const x1 = W - END_PAD
  const at = x0 + (x1 - x0) * Math.max(0, Math.min(1, ratio))
  let g = GRADIENT + track(x0, x1)
  if (at > x0) g += `<rect x="${x0}" y="${TRACK_Y}" width="${at - x0}" height="${TRACK_H}" rx="${TRACK_H / 2}" fill="url(#way)"/>`
  if (steps > 1 && steps <= MAX_MARKS) {
    for (let i = 1; i < steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps
      const isPassed = x <= at
      g += `<rect x="${x - 0.75}" y="${TRACK_Y - 1}" width="1.5" height="${TRACK_H + 2}" fill="${isPassed ? '#000' : MUTED}" opacity="${isPassed ? 0.45 : 0.7}"/>`
    }
  }
  // The goal: a ring, filled once reached.
  g += `<circle cx="${x1}" cy="${TRACK_Y + TRACK_H / 2}" r="${GOAL_R}" fill="${isFinished ? YELLOW : 'none'}" stroke="${YELLOW}" stroke-width="1.5"/>`
  g += surfer(surferX(at, W))
  return svgDoc(W, BAR_H, g, false)
}

/** No list, so no distance: a lit stretch and Robo pace the track end to end. SMIL only, so the Svg needs isInteractive. */
export const paceSvg = (W: number): string => {
  const x0 = 0
  const x1 = W - END_PAD
  const span = Math.max(0, x1 - x0 - PACE_W)
  const ease = 'calcMode="spline" keyTimes="0;0.5;1" keySplines=".45 0 .55 1;.45 0 .55 1"'
  const dur = 'dur="3.2s" repeatCount="indefinite"'
  return svgDoc(
    W,
    BAR_H,
    GRADIENT +
      track(x0, x1) +
      `<rect x="${x0}" y="${TRACK_Y}" width="${PACE_W}" height="${TRACK_H}" rx="${TRACK_H / 2}" fill="url(#way)">` +
      `<animate attributeName="x" values="${x0};${x0 + span};${x0}" ${dur} ${ease}/></rect>` +
      `<g><animateTransform attributeName="transform" type="translate" values="0 0;${span} 0;0 0" ${dur} ${ease}/>` +
      surfer(x0 + PACE_W / 2 - BOARD_W / 2) +
      '</g>',
    false,
  )
}

/** The subagents at work: one small Robo a head, side by side. */
export const crewSvg = (heads: number): { source: string; w: number } => {
  const n = Math.max(1, heads)
  const w = CREW_ROBO + (n - 1) * CREW_STEP
  let g = ''
  for (let i = 0; i < n; i++) g += roboShapes(i * CREW_STEP, (BAR_H - CREW_ROBO) / 2, CREW_ROBO, 'warm')
  return { source: svgDoc(w, BAR_H, g, false), w }
}
