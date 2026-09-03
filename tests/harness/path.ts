/**
 * Route-finding for the walkthrough, over the game's own wall data.
 *
 * `walkUntil` in `navigate.ts` is a hand: it pushes toward a target and slides
 * along whatever it bumps into. That is enough to cross a hut, and it is not
 * enough to cross the camp -- pushed east from hut 2 the hero walks 224 units
 * and stops dead against wall 7, which no amount of axis-swapping gets him
 * round. A person looking at the screen would simply walk around the hut. This
 * is that decision, made mechanically.
 *
 * It is scaffolding, not a port. The one thing it borrows from the game is the
 * obstacle test -- `outdoorBoundsCheck` ($B14C), the same routine `step` uses
 * to refuse a move -- so the route it finds is walkable by construction rather
 * than by a second, guessed model of the map. A hand-rolled idea of where the
 * fences are is exactly the mistake CLAUDE.md records costing a day on the
 * searchlight sweep.
 *
 * The grid is four world units, which is the hero's own outdoor stride, so
 * every edge of the search is one step he can actually take.
 */

import { outdoorBoundsCheck } from '../../src/game/bounds.js';

/**
 * The search grid, in world units.
 *
 * TWO, not four, and the difference is not cosmetic. Wall 12 is a two-unit
 * sliver at x=562: a four-unit grid steps straight over it and reports a clear
 * straight line down the corridor east of hut 2, which the hero then walks
 * into and stops dead against. The animation frames carry deltas of two as
 * well as four, so two is the finest step he actually takes, and a grid at his
 * finest step is the only one that cannot invent a gap.
 */
export const STRIDE = 2;

/** The map is 216x136 tiles; this bounds the search well outside it. */
const MAX_COORD = 2200;

export interface Waypoint {
  x: number;
  y: number;
}

function snap(v: number): number {
  return Math.round(v / STRIDE) * STRIDE;
}

/**
 * Breadth-first search from `from` to `to`, avoiding every wall volume.
 *
 * `height` matters: the wall test is three-dimensional ($B19B/$B1A9), so a
 * crawling hero fits under things a standing one does not. Pass the height he
 * will actually be walking at.
 *
 * Returns the waypoints INCLUDING the destination, or null if the target is
 * unreachable on the grid -- which is a real answer worth having, not a
 * failure to paper over.
 */
export function findPath(
  from: Waypoint,
  to: Waypoint,
  height: number,
  maxNodes = 1500000,
): Waypoint[] | null {
  const start = { x: snap(from.x), y: snap(from.y) };
  const goal = { x: snap(to.x), y: snap(to.y) };
  const key = (x: number, y: number) => x * 4096 + y;

  if (outdoorBoundsCheck({ x: goal.x, y: goal.y, height }).blocked) return null;

  const cameFrom = new Map<number, number>();
  const startKey = key(start.x, start.y);
  cameFrom.set(startKey, -1);

  let frontier: Waypoint[] = [start];
  const deltas: ReadonlyArray<readonly [number, number]> = [
    [STRIDE, 0],
    [-STRIDE, 0],
    [0, STRIDE],
    [0, -STRIDE],
  ];

  while (frontier.length > 0 && cameFrom.size < maxNodes) {
    const next: Waypoint[] = [];
    for (const p of frontier) {
      for (const [dx, dy] of deltas) {
        const nx = p.x + dx;
        const ny = p.y + dy;
        if (nx < 0 || ny < 0 || nx > MAX_COORD || ny > MAX_COORD) continue;
        const k = key(nx, ny);
        if (cameFrom.has(k)) continue;
        if (outdoorBoundsCheck({ x: nx, y: ny, height }).blocked) continue;
        cameFrom.set(k, key(p.x, p.y));

        if (nx === goal.x && ny === goal.y) return rebuild(cameFrom, k);
        next.push({ x: nx, y: ny });
      }
    }
    frontier = next;
  }
  return null;
}

function rebuild(cameFrom: Map<number, number>, end: number): Waypoint[] {
  const out: Waypoint[] = [];
  let cur = end;
  while (cur !== -1 && cur !== undefined) {
    out.push({ x: Math.floor(cur / 4096), y: cur % 4096 });
    const prev = cameFrom.get(cur);
    if (prev === undefined) break;
    cur = prev;
  }
  return out.reverse();
}

/**
 * Thin a path down to its corners.
 *
 * The BFS emits one node per stride, which is hundreds of waypoints across the
 * camp and hundreds of pointless re-aims for the navigator. Only the turns
 * matter -- between them `walkUntil` walks a straight line perfectly well.
 */
export function corners(path: Waypoint[]): Waypoint[] {
  if (path.length <= 2) return path;
  const out: Waypoint[] = [path[0]!];
  for (let i = 1; i < path.length - 1; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const c = path[i + 1]!;
    const turned = (b.x - a.x) !== (c.x - b.x) || (b.y - a.y) !== (c.y - b.y);
    if (turned) out.push(b);
  }
  out.push(path[path.length - 1]!);
  return out;
}
