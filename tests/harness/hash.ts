/**
 * A state hash, for `BUILD_PROMPT.md` §8's determinism harness.
 *
 * "Fixed seed plus a scripted input sequence produces a state hash at frame N.
 * Use it to catch regressions when refactoring, and to replay the P6
 * walkthrough in CI."
 *
 * The value of a hash is entirely in what it covers, so this walks every field
 * that a tick can write and nothing that it cannot. Two things are deliberately
 * excluded:
 *
 * - **the SpectrumScreen.** It is a rendering product, and the panel is drawn
 *   into it by `wave_morale_flag` and `message_display` from state that is
 *   already hashed. Including it would make the hash fail on a font change.
 * - **anything derived.** `hero_map_position` is a pure function of `hero.pos`;
 *   hashing both says nothing extra and invites a false sense of coverage.
 *
 * FNV-1a over a byte stream, which is not cryptographic and does not need to
 * be: it is a tripwire for "the simulation changed", read by a human who then
 * goes and looks.
 */

import type { GameState } from './loop.js';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

class Hasher {
  private h = FNV_OFFSET;

  byte(b: number): void {
    this.h = ((this.h ^ (b & 0xff)) * FNV_PRIME) >>> 0;
  }

  /** Numbers are hashed as four bytes, so 256 and 0 cannot collide. */
  num(n: number): void {
    const v = n | 0;
    this.byte(v);
    this.byte(v >> 8);
    this.byte(v >> 16);
    this.byte(v >> 24);
  }

  bool(b: boolean): void {
    this.byte(b ? 1 : 0);
  }

  bytes(a: ArrayLike<number>): void {
    for (let i = 0; i < a.length; i++) this.byte(a[i]!);
  }

  get value(): string {
    return this.h.toString(16).padStart(8, '0');
  }
}

export function hashGameState(g: GameState): string {
  const h = new Hasher();

  // The hero, and the vischar that shares his fields.
  h.num(g.hero.pos.x);
  h.num(g.hero.pos.y);
  h.num(g.hero.pos.height);
  h.num(g.hero.room);
  h.num(g.hero.direction);
  h.num(g.hero.animation);
  h.num(g.hero.frame);
  h.num(g.hero.counterAndFlags);
  h.bool(g.hero.reverse);

  for (const v of g.vischars) {
    h.num(v.slot);
    h.num(v.character);
    h.num(v.flags);
    h.num(v.room);
    h.num(v.pos.x);
    h.num(v.pos.y);
    h.num(v.pos.height);
    h.num(v.target.x);
    h.num(v.target.y);
    h.num(v.route.index);
    h.num(v.route.step);
    h.num(v.counterAndFlags);
    h.num(v.anim);
    h.num(v.animIndex);
    h.num(v.animbase);
    h.num(v.input);
    h.num(v.direction);
  }

  for (const s of g.structs) {
    h.num(s.character);
    h.num(s.room);
    h.num(s.pos.x);
    h.num(s.pos.y);
    h.num(s.pos.height);
    h.num(s.route.index);
    h.num(s.route.step);
  }

  // Items: the whole struct table plus what he is carrying.
  h.bytes(g.items.structs);
  h.bytes(g.items.held);

  // The player's own numbers.
  h.num(g.player.morale);
  h.num(g.player.displayedMorale);
  h.num(g.player.gameCounter);
  h.bool(g.player.moraleExhausted);
  h.bytes(g.player.score);

  // The day, the night, and where in both he is.
  h.num(g.schedule.clock);
  h.bool(g.schedule.night);
  h.bool(g.schedule.heroInBed);
  h.bool(g.schedule.heroInBreakfast);

  h.num(g.searchlights.state);
  for (const l of g.searchlights.lights) {
    h.num(l.x);
    h.num(l.y);
    h.num(l.counter);
    h.num(l.direction);
    h.num(l.step);
  }

  h.bool(g.permitted.redFlag);
  h.num(g.permitted.flagAttribute);
  h.bool(g.solitaryState.inSolitary);
  h.num(g.solitaryState.currentDoor);
  h.num(g.pursuit.foodDiscoveredCounter);
  h.bool(g.pursuit.bellRingingPerpetually);

  // Runtime writes to what is otherwise constant data.
  h.bytes(g.lockedDoors);
  for (const [key, value] of [...g.pokes.objects].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const c of key) h.byte(c.charCodeAt(0));
    h.num(value);
  }
  for (const [key, value] of [...g.pokes.bounds].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const c of key) h.byte(c.charCodeAt(0));
    h.num(value);
  }

  h.num(g.parcels.contents);
  h.num(g.messages.messageIndex);
  h.num(g.messages.displayIndex);

  // The view, and the PRNG's own cursor -- without the latter two runs that
  // reached the same board by different routes would hash the same.
  h.num(g.view.position.x);
  h.num(g.view.position.y);
  h.num(g.prng.pointer);

  h.num(g.moveIndex);
  h.num(g.frame);

  return h.value;
}
