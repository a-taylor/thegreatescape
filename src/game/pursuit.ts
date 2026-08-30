/**
 * follow_suspicious_character (c$C892) and what it decides.
 *
 * Once a frame this walks the seven NPC slots and, for each HOSTILE character,
 * asks whether it should react to the hero. Three separate reactions come out
 * of it, and they are different flags rather than degrees of the same one:
 *
 *   PURSUIT_HASSLE ($02)   the guard has SEEN him but nothing is wrong; it
 *                          walks over to have a look
 *   PURSUIT_PURSUE ($01)   the red flag is up, or something incriminating was
 *                          found; every hostile converges and the bell rings
 *   PURSUIT_DOG_FOOD ($03) a dog has smelled the food the hero dropped
 *
 * The gate in front of all of it ($C8CE) is "red_flag OR the player is idle" --
 * a hero under active control who is behaving is not looked at.
 */

import { ITEMSTRUCT_STRIDE, OFF_ROOM, type ItemState } from './inventory.js';
import { NEARBY_7 } from './items.js';
import { tinyposStash } from './coords.js';
import type { TinyPos } from './math.js';
import { CHARACTER_NONE, type Vischar } from './vischar.js';

/** vischar_PURSUIT_* ($CC9E / $CCC6 / $C8EF / $CC48). */
export const PURSUIT_PURSUE = 0x01;
export const PURSUIT_HASSLE = 0x02;
export const PURSUIT_DOG_FOOD = 0x03;
export const PURSUIT_SAW_BRIBE = 0x04;

/** The first NON-hostile character ($C8C5 CP $14): guards and dogs are 0..19. */
export const FIRST_FRIENDLY_CHARACTER = 0x14;
/** character_15_GUARD_15 -- above this and up to 19 are the dogs ($C8DC CP $0F). */
export const LAST_GUARD_CHARACTER = 0x0f;
/** item_FOOD ($C8AC LD C,$07). */
export const ITEM_FOOD = 7;

/**
 * Guards standing high up do not react ($CC9B / $CCBE CP $20).
 *
 * The watchtower and gate guards are placed at height 32 or more, and both the
 * hassle and the pursue loops exclude them by height rather than by character
 * index -- so a guard who ever ended up on a tower would stop reacting.
 */
export const TOWER_HEIGHT = 0x20;

export interface PursuitContext {
  /** The global current room index ($68A0). */
  readonly room: number;
  /** red_flag ($A138). */
  readonly redFlag: boolean;
  /** automatic_player_counter ($A139): non-zero means the player is active. */
  readonly automaticPlayerCounter: number;
  /** hero_map_position ($81B8). */
  readonly heroMapPosition: TinyPos;
  /** Whether the hero is wearing the guard's uniform ($CC3E). */
  readonly heroInUniform: boolean;
  readonly items: ItemState;
}

/**
 * hostiles_pursue ($CCAB): every hostile that is not up a tower gives chase.
 *
 * Called when the bell is already ringing ($C89A), when an item is discovered,
 * and from guards_follow_suspicious_character once the flag is red.
 */
export function hostilesPursue(vischars: Vischar[]): void {
  for (const v of vischars.slice(1)) { // $CCB0 starts at the second vischar
    if (v.character === CHARACTER_NONE) continue;
    if ((v.character & 0x1f) >= FIRST_FRIENDLY_CHARACTER) continue; // $CCB6
    if (v.pos.height >= TOWER_HEIGHT) continue; // $CCBE, not the tower guards
    v.flags = PURSUIT_PURSUE; // $CCC6
  }
}

/**
 * guards_follow_suspicious_character ($CC37).
 *
 * Line of sight, but only outdoors ($CC57) -- indoors the check is skipped
 * entirely and the guard reacts on the flag alone.
 *
 * The sight test is a 3-wide corridor on the axis the guard is NOT facing
 * along, plus a check that the hero is on the correct SIDE of him. Which axis
 * is which comes from the bottom bit of the direction ($CC66), and the side
 * test flips on the other bit ($CC78) -- so a guard facing top-left and one
 * facing bottom-right scan the same corridor in opposite directions.
 */
export function guardsFollowSuspiciousCharacter(
  v: Vischar,
  vischars: Vischar[],
  ctx: PursuitContext,
): { ringBell: boolean } {
  const character = v.character & 0x1f;

  const seen = { ringBell: false };

  // $CC3B: the uniform fools everyone except the commandant.
  if (character !== 0 && ctx.heroInUniform) return seen;

  // $CC48: a character who watched the hero hand over a bribe looks away.
  if (v.flags === PURSUIT_SAW_BRIBE) return seen;

  if (ctx.room === 0) {
    // $CC5A: the guard's own position, scaled the way stash_pos does it --
    // rounding x but truncating y, which is NOT what pos_to_tinypos does.
    const mine = tinyposStash(v.pos, true);
    const hero = ctx.heroMapPosition;
    const direction = v.direction;

    // $CC66 RRA puts direction bit 0 into carry: clear means TOP_LEFT or
    // BOTTOM_RIGHT, which scan along y; set means TOP_RIGHT or BOTTOM_LEFT.
    const scansY = (direction & 0x01) === 0;
    const along = scansY ? mine.y : mine.x;
    const heroAlong = scansY ? hero.y : hero.x;
    // $CC6D: (mine - 1) >= hero, or (mine + 1) < hero, and he is not in view.
    if (((along - 1) & 0xff) >= heroAlong) return seen;
    if (((along + 1) & 0xff) < heroAlong) return seen;

    // $CC76: is he on the side the guard is facing? The comparison is on the
    // OTHER axis, and bit 1 of the direction decides whether it is inverted.
    const across = scansY ? mine.x : mine.y;
    const heroAcross = scansY ? hero.x : hero.y;
    let facing = across < heroAcross; // carry from `CP`
    if ((direction & 0x02) === 0) facing = !facing; // $CC7C CCF
    if (facing) return seen; // $CC7D RET C
  }

  // $CC92: seen. What happens next depends on the flag, not on the sighting.
  if (!ctx.redFlag) {
    // $CC9B: tower guards do not leave their posts to hassle.
    if (v.pos.height >= TOWER_HEIGHT) return seen;
    v.flags = PURSUIT_HASSLE; // $CC9E
    return seen;
  }

  // $CCA3: the bell rings perpetually and EVERY hostile converges -- not just
  // the one that saw him. The bell's sound is P7; setting it ringing is not.
  seen.ringBell = true;
  hostilesPursue(vischars); // $CCA7
  return seen;
}

export interface FollowResult {
  /** True when the bell should be set ringing perpetually ($CCA4). */
  ringBell: boolean;
}

/**
 * follow_suspicious_character ($C892), the once-per-frame driver.
 *
 * Order matters and is reproduced: the food counter is aged BEFORE the vischar
 * loop, so the frame on which poisoned food expires is also the frame the dogs
 * stop smelling it.
 */
export function followSuspiciousCharacter(
  vischars: Vischar[],
  ctx: PursuitContext,
  state: { foodDiscoveredCounter: number; bellRingingPerpetually: boolean },
  hooks: {
    /** is_item_discoverable ($CCCD) -> item_discovered. */
    checkItemDiscoverable(): void;
    /** item_discovered ($CD31) for the food, when the counter runs out. */
    foodExpired(): void;
  },
): FollowResult {
  const out: FollowResult = { ringBell: false };

  // $C896: if the bell is already ringing perpetually, everyone is already
  // after him -- re-assert it rather than waiting to be seen again.
  if (state.bellRingingPerpetually) hostilesPursue(vischars);

  // $C8A0: age the poisoned food. When it reaches zero the poison wears off
  // and the food is "discovered", which puts it back where it belongs.
  if (state.foodDiscoveredCounter !== 0) {
    state.foodDiscoveredCounter--;
    if (state.foodDiscoveredCounter === 0) {
      const o = ITEM_FOOD * ITEMSTRUCT_STRIDE;
      ctx.items.structs[o] = ctx.items.structs[o]! & ~0x20 & 0xff; // $C8AA
      hooks.foodExpired(); // $C8AE
    }
  }

  for (const v of vischars.slice(1)) { // $C8B1, slots 1..7
    if (v.flags === 0xff) continue; // $C8BB, empty slot
    const character = v.character & 0x1f;
    if (character >= FIRST_FRIENDLY_CHARACTER) continue; // $C8C7, not hostile

    hooks.checkItemDiscoverable(); // $C8CB

    // $C8CE: react only when the flag is red OR the player is idle enough for
    // the CPU to be driving. A player actively behaving himself is ignored.
    if (ctx.redFlag || ctx.automaticPlayerCounter !== 0) {
      // The bell and the general pursuit are set from INSIDE this call
      // ($CCA3), only when the guard actually saw him -- not by the driver.
      if (guardsFollowSuspiciousCharacter(v, vischars, ctx).ringBell) {
        out.ringBell = true;
      }
    }

    // $C8DC: dogs only, and only dogs -- `CP $0F / JP Z / JP C` excludes
    // everything at or below guard 15.
    if (character > LAST_GUARD_CHARACTER) {
      const foodRoom = ctx.items.structs[ITEM_FOOD * ITEMSTRUCT_STRIDE + OFF_ROOM]!;
      if ((foodRoom & NEARBY_7) !== 0) v.flags = PURSUIT_DOG_FOOD; // $C8EF
    }
  }

  return out;
}
