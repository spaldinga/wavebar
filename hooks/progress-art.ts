import { EMPTY, MUTED, ORANGE, YELLOW, roboShapes, svgDoc } from './cache-art'

// The progress drawings: a track Robo walks along. Left of Robo is the way come,
// in the band's orange running to yellow; marks stand where one step ends and the
// next begins. With no list to measure against, Robo paces the track instead.

export const BAR_H = 26
const ROBO = 20
const TRACK_H = 4
const TRACK_Y = BAR_H - TRACK_H - 1
const ROBO_Y = TRACK_Y - ROBO + 2
/** Above this many steps the marks would run together, so none are drawn. */
const MAX_MARKS = 24
const PACE_W = 44

const GRADIENT =
  `<defs><linearGradient id="way" x1="0" x2="1" y1="0" y2="0">` +
  `<stop offset="0" stop-color="${ORANGE}"/><stop offset="1" stop-color="${YELLOW}"/></linearGradient></defs>`

const track = (x0: number, x1: number): string =>
  `<rect x="${x0}" y="${TRACK_Y}" width="${x1 - x0}" height="${TRACK_H}" rx="${TRACK_H / 2}" fill="${EMPTY}"/>`

/** Robo at `ratio` of the way along a track `W` pixels wide, with a mark between each of `steps` steps. */
export const walkSvg = (ratio: number, steps: number, W: number, isFinished: boolean): string => {
  const x0 = ROBO / 2
  const x1 = W - ROBO / 2
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
  g += `<circle cx="${x1}" cy="${TRACK_Y + TRACK_H / 2}" r="3.5" fill="${isFinished ? YELLOW : 'none'}" stroke="${YELLOW}" stroke-width="1.5"/>`
  g += roboShapes(at - ROBO / 2, ROBO_Y, ROBO, 'warm')
  return svgDoc(W, BAR_H, g, false)
}

/** No list, so no distance: a lit stretch and Robo pace the track end to end. SMIL only, so the Svg needs isInteractive. */
export const paceSvg = (W: number): string => {
  const x0 = ROBO / 2
  const x1 = W - ROBO / 2
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
      roboShapes(x0 + PACE_W / 2 - ROBO / 2, ROBO_Y, ROBO, 'warm') +
      '</g>',
    false,
  )
}
