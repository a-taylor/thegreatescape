/**
 * in_permitted_area (c$9F21), in_permitted_area_end_bit ($A007) and
 * within_camp_bounds ($A01A).
 *
 * The flag's colour is not cosmetic -- guards_follow_suspicious_character
 * reads red_flag -- so these pin the decision, not the drawing.
 */

import { describe, expect, it } from 'vitest';

import {
  FLAG_GREEN,
  FLAG_RED,
  HOME_ROOM,
  NIGHT_CLOCK,
  createPermitted,
  inPermittedArea,
  inPlace,
  permittedBounds,
  routeToPermitted,
  withinCampBounds,
} from '../src/game/permitted.js';
import { createVischars } from '../src/game/vischar.js';
import { FLAGS_CUTTING_WIRE, FLAGS_PICKING_LOCK } from '../src/game/actions.js';

function context(over: Record<string, unknown> = {}) {
  const hero = createVischars()[0]!;
  hero.character = 0;
  hero.flags = 0;
  hero.route = { index: 45, step: 0 };
  hero.pos = { x: 0, y: 0, height: 0 };
  hero.isoPos = { x: 0, y: 0 };
  const calls = { routes: [] as Array<[number, number]>, escaped: 0, bells: 0 };
  return {
    calls,
    ctx: {
      room: 0,
      clock: 20,
      inSolitary: false,
      hero,
      mapPosition: { x: 0, y: 0, height: 0 },
      setHeroRoute(index: number, step: number) { calls.routes.push([index, step]); },
      onEscaped() { calls.escaped++; },
      silenceBell() { calls.bells++; },
      ...over,
    },
  };
}

describe('within_camp_bounds', () => {
  it('is inclusive at the lower bound and exclusive at the upper ($A026)', () => {
    const b = permittedBounds[1]!;
    expect(withinCampBounds(1, { x: b.x0, y: b.y0, height: 0 })).toBe(true);
    expect(withinCampBounds(1, { x: b.x0 - 1, y: b.y0, height: 0 })).toBe(false);
    expect(withinCampBounds(1, { x: b.x1 - 1, y: b.y1 - 1, height: 0 })).toBe(true);
    expect(withinCampBounds(1, { x: b.x1, y: b.y0, height: 0 })).toBe(false);
    expect(withinCampBounds(1, { x: b.x0, y: b.y1, height: 0 })).toBe(false);
  });

  it('has three areas', () => {
    // permitted_bounds is indexed 0..2 by in_permitted_area_end_bit.
    expect(permittedBounds).toHaveLength(3);
  });
});

describe('in_permitted_area_end_bit', () => {
  it('treats bit 7 as a room index and everything else as an area ($A00A)', () => {
    const pos = { x: 0, y: 0, height: 0 };
    expect(inPlace(0x80 | 25, 25, pos)).toBe(true);
    expect(inPlace(0x80 | 25, 23, pos)).toBe(false);
  });

  it('fails every AREA test while indoors ($A015)', () => {
    // An area only means anything outdoors; indoors the routine returns before
    // ever looking at the bounds. So an indoor hero is judged purely on rooms.
    const inside = { x: permittedBounds[1]!.x0, y: permittedBounds[1]!.y0, height: 0 };
    expect(inPlace(1, 0, inside)).toBe(true);
    expect(inPlace(1, 5, inside)).toBe(false);
  });
});

describe('in_permitted_area', () => {
  it('keeps hero_map_position up to date ($9F2E / $9F49)', () => {
    const { ctx } = context({ room: 0 });
    ctx.hero.pos = { x: 0x0400, y: 0x0300, height: 0x20 };
    inPermittedArea(createPermitted(), ctx);
    expect(ctx.mapPosition).toEqual({ x: 0x80, y: 0x60, height: 4 });

    const indoor = context({ room: 5 });
    indoor.ctx.hero.pos = { x: 62, y: 35, height: 16 };
    inPermittedArea(createPermitted(), indoor.ctx);
    expect(indoor.ctx.mapPosition).toEqual({ x: 62, y: 35, height: 16 });
  });

  it('reports the escape when he walks off the edge ($9F34)', () => {
    const { ctx, calls } = context({ room: 0 });
    ctx.hero.isoPos = { x: 217 * 8, y: 0 };
    inPermittedArea(createPermitted(), ctx);
    expect(calls.escaped).toBe(1);

    const y = context({ room: 0 });
    y.ctx.hero.isoPos = { x: 0, y: 137 * 8 };
    inPermittedArea(createPermitted(), y.ctx);
    expect(y.calls.escaped).toBe(1);
  });

  it('cannot escape from indoors', () => {
    // The check is inside the outdoors branch, so an interior position that
    // happens to be large does not trigger it.
    const { ctx, calls } = context({ room: 25 });
    ctx.hero.isoPos = { x: 217 * 8, y: 137 * 8 };
    inPermittedArea(createPermitted(), ctx);
    expect(calls.escaped).toBe(0);
  });

  it('goes red while picking a lock or cutting wire ($9F54)', () => {
    for (const flag of [FLAGS_PICKING_LOCK, FLAGS_CUTTING_WIRE]) {
      const { ctx } = context();
      ctx.hero.flags = flag;
      const s = createPermitted();
      expect(inPermittedArea(s, ctx)).toBe(true);
      expect(s.flagAttribute).toBe(FLAG_RED);
    }
  });

  it('at night, only the home room is safe ($9F5C)', () => {
    const home = context({ clock: NIGHT_CLOCK, room: HOME_ROOM });
    expect(inPermittedArea(createPermitted(), home.ctx)).toBe(false);

    const elsewhere = context({ clock: NIGHT_CLOCK, room: 3 });
    expect(inPermittedArea(createPermitted(), elsewhere.ctx)).toBe(true);

    // One tick earlier it is still day and the room does not matter.
    const day = context({ clock: NIGHT_CLOCK - 1, room: 3 });
    day.ctx.hero.route = { index: 0, step: 0 };
    expect(inPermittedArea(createPermitted(), day.ctx)).toBe(false);
  });

  it('bypasses every check while in solitary ($9F6F)', () => {
    const { ctx } = context({ inSolitary: true, room: 40 });
    expect(inPermittedArea(createPermitted(), ctx)).toBe(false);
  });

  it('lets an unlisted route go anywhere ($9FA2)', () => {
    // Most routes are absent from route_to_permitted, and absence means
    // unrestricted rather than forbidden.
    const listed = routeToPermitted.map((e) => e.route);
    const unlisted = [...Array(60).keys()].find((n) => n > 0 && !listed.includes(n))!;
    const { ctx } = context({ room: 40 });
    ctx.hero.route = { index: unlisted, step: 0 };
    expect(inPermittedArea(createPermitted(), ctx)).toBe(false);
  });

  it('is happy when the hero is where his route step says ($9FAB)', () => {
    // Route 43 is "at breakfast" and permits exactly room 25.
    const entry = routeToPermitted.find((e) => e.route === 43)!;
    expect(entry.places).toEqual([0x80 | 25]);

    const { ctx } = context({ room: 25 });
    ctx.hero.route = { index: 43, step: 0 };
    expect(inPermittedArea(createPermitted(), ctx)).toBe(false);
  });

  it('MOVES THE ROUTE rather than going red when he is somewhere else on it', () => {
    // $9FD5. Route 16 permits areas then rooms 21, 23, 25. Standing in room 23
    // while the step says otherwise advances the step instead of alarming the
    // guards -- the single most surprising thing this routine does.
    const entry = routeToPermitted.find((e) => e.route === 16)!;
    const target = entry.places.indexOf(0x80 | 23);
    expect(target).toBeGreaterThan(0);

    const { ctx, calls } = context({ room: 23 });
    ctx.hero.route = { index: 16, step: 0 };
    const s = createPermitted();

    expect(inPermittedArea(s, ctx)).toBe(false);
    expect(calls.routes).toEqual([[16, target]]);
    expect(s.flagAttribute).toBe(FLAG_GREEN);
  });

  it('goes red when he is nowhere on his route at all', () => {
    const { ctx, calls } = context({ room: 40 });
    ctx.hero.route = { index: 43, step: 0 }; // permits only room 25
    const s = createPermitted();
    expect(inPermittedArea(s, ctx)).toBe(true);
    expect(calls.routes).toEqual([]);
    expect(s.flagAttribute).toBe(FLAG_RED);
  });

  it('freezes the hero once, on the transition to red ($A000)', () => {
    const { ctx } = context({ room: 40 });
    ctx.hero.route = { index: 43, step: 0 };
    const s = createPermitted();

    ctx.hero.input = 9;
    inPermittedArea(s, ctx);
    expect(ctx.hero.input).toBe(0);

    // Still out of bounds: the input is NOT cleared again, so the player can
    // walk back out of trouble.
    ctx.hero.input = 9;
    inPermittedArea(s, ctx);
    expect(ctx.hero.input).toBe(9);
  });

  it('silences the bell only when the flag turns green ($9FF1)', () => {
    const { ctx, calls } = context({ room: 40 });
    ctx.hero.route = { index: 43, step: 0 };
    const s = createPermitted();

    inPermittedArea(s, ctx); // -> red
    expect(calls.bells).toBe(0);

    ctx.room = 25;
    inPermittedArea(s, ctx); // -> green, transition
    expect(calls.bells).toBe(1);

    inPermittedArea(s, ctx); // still green, no repaint
    expect(calls.bells).toBe(1);
  });

  it('wanders inside the huts for step block 8 and the yard otherwise ($9F84)', () => {
    const inHuts = context({ room: 0 });
    inHuts.ctx.hero.route = { index: 0xff, step: 0x08 };
    inHuts.ctx.mapPosition = { x: 0, y: 0, height: 0 };
    // Put him inside area 1, which is what block 8 permits.
    const b1 = permittedBounds[1]!;
    inHuts.ctx.hero.pos = { x: b1.x0 * 8, y: b1.y0 * 8, height: 0 };
    expect(inPermittedArea(createPermitted(), inHuts.ctx)).toBe(false);

    // The same position on a different block is judged against area 2.
    const yard = context({ room: 0 });
    yard.ctx.hero.route = { index: 0xff, step: 0x10 };
    yard.ctx.hero.pos = { x: b1.x0 * 8, y: b1.y0 * 8, height: 0 };
    const inArea2 = withinCampBounds(2, { x: b1.x0, y: b1.y0, height: 0 });
    expect(inPermittedArea(createPermitted(), yard.ctx)).toBe(!inArea2);
  });
});
