/**
 * Populating and emptying the vischar array.
 *
 *   spawn_characters (c$C41C)             every character near the window gets a slot
 *   purge_invisible_characters (c$C47E)   every slot too far away is given back
 *   spawn_character (c$C4E0)              one character, struct -> slot
 *   reset_visible_character (c$C5D3)      one slot, back to struct
 *
 * The two bounds tests are deliberately NOT the same, and the asymmetry is the
 * whole reason characters do not flicker at the window edge: spawning uses a
 * zone 8 tiles beyond the window, purging uses 9. A character that has just
 * spawned is therefore still comfortably inside the purge zone, so one step of
 * movement cannot immediately un-spawn it. Making the two match reintroduces
 * exactly that flicker.
 *
 * They also project positions differently, which is easier to trip over.
 * Spawning works from the CHARACTER STRUCT, whose position is tinypos, and uses
 * a cheap 8-bit version of the isometric projection scaled down by 8. Purging
 * works from the VISCHAR, whose iso_pos is already computed, and just divides
 * it down. Same geometry, two representations, because the two routines are
 * looking at characters in two different storage states.
 */

import {
  CHARACTER_COUNT,
  FLAG_ON_SCREEN,
  metaFor,
  type CharacterStruct,
} from './characters.js';
import { divideBy8, divideBy8WithRounding } from './math.js';
import { calcIsoPos } from './coords.js';
import { getTargetAssignPos } from './behaviour.js';
import {
  CHARACTER_NONE,
  FLAGS_EMPTY_SLOT,
  isEmpty,
  npcSlots,
  type Vischar,
} from './vischar.js';

/** The spawn zone: 8 tiles beyond the window on every side ($C420, $C427). */
export const SPAWN_ZONE = 8;
/** The purge zone: 9. "Compare to the spawning size of 8" ($C482). */
export const PURGE_ZONE = 9;

/**
 * The screen dimensions these routines use.
 *
 * The disassembly flags the discrepancy itself at $C4B1: "16 is used for screen
 * height here, but 24 is used for width below - so that doesn't line up with
 * the actual values which are 24x17." The window is 24 wide and 17 tall, so the
 * height is one short. Reproduced: the effect is that the spawn band is a row
 * tighter at the bottom than a corrected version would make it.
 */
export const SCREEN_WIDTH_TILES = 24;
export const SCREEN_HEIGHT_TILES = 16;

/** map_position minus a zone, floored at zero ($C420..$C425). */
function clampedLowerBound(value: number, zone: number): number {
  const v = value - zone;
  return v < 0 ? 0 : v;
}

/** ADD A,n then clamp to 255 on carry ($C44C..$C450). */
function clampedUpperBound(low: number, span: number): number {
  const v = low + span;
  return v > 0xff ? 0xff : v;
}

/**
 * The cheap projection spawn_characters uses ($C442..$C45C).
 *
 * This is calc_vischar_iso_pos at tinypos scale: $200 becomes 64 and $800
 * becomes 256, both divided down by 8 to match the byte-sized inputs. It runs
 * entirely in 8-bit registers and wraps, which is reproduced -- the y term in
 * particular starts from a register holding zero that "represents 0x100".
 */
export function spawnProjection(pos: {
  x: number;
  y: number;
  height: number;
}): { x: number; y: number } {
  // y = ((256 - pos.x) - pos.y) - pos.height, in 8 bits.
  const y = (0 - pos.x - pos.y - pos.height) & 0xff;
  // x = (64 - pos.x + pos.y) * 2, in 8 bits.
  const x = ((0x40 + pos.y - pos.x) & 0xff) * 2 & 0xff;
  return { x, y };
}

/**
 * Is this character close enough to the window to be given a slot?
 *
 * Both axes must pass, and each is a pair of tests against the clamped bounds.
 * The lower test rejects on EQUAL ($C449 JR NC), the upper does not ($C452
 * JR C), so the band is half-open.
 */
export function shouldSpawn(
  struct: CharacterStruct,
  mapPosition: { x: number; y: number },
  currentRoom: number,
): boolean {
  if (struct.onScreen) return false; // $C432
  if (struct.room !== currentRoom) return false; // $C43C

  // $C43F: indoors the position tests are skipped entirely -- everyone in the
  // room is spawned, because a room is never bigger than the window.
  if (currentRoom !== 0) return true;

  const mapX = clampedLowerBound(mapPosition.x, SPAWN_ZONE);
  const mapY = clampedLowerBound(mapPosition.y, SPAWN_ZONE);
  const p = spawnProjection(struct.pos);

  // Y first, as the routine does ($C448..$C453).
  if (mapY >= p.y) return false;
  if (clampedUpperBound(mapY, SCREEN_HEIGHT_TILES + 2 * SPAWN_ZONE) < p.y) {
    return false;
  }

  // Then X ($C45D..$C468).
  if (mapX >= p.x) return false;
  if (clampedUpperBound(mapX, SCREEN_WIDTH_TILES + 2 * SPAWN_ZONE) < p.x) {
    return false;
  }

  return true;
}

/**
 * Is this occupied slot still close enough to keep?
 *
 * The X and Y halves divide differently -- $C4A9 rounds, $C4BE does not -- and
 * that is not tidied up here. It shifts the effective boundary by half a tile
 * on one axis only.
 */
export function shouldKeep(
  v: Vischar,
  mapPosition: { x: number; y: number },
  currentRoom: number,
): boolean {
  if (v.room !== currentRoom) return false; // $C4A3

  const minX = clampedLowerBound(mapPosition.x, PURGE_ZONE);
  const minY = clampedLowerBound(mapPosition.y, PURGE_ZONE);

  // $C4A9 CALL $E550 -- divide by 8 WITH rounding.
  const isoY = divideBy8WithRounding((v.isoPos.y >> 8) & 0xff, v.isoPos.y & 0xff);
  if (minY >= isoY) return false;
  if (clampedUpperBound(minY, SCREEN_HEIGHT_TILES + 2 * PURGE_ZONE) < isoY) {
    return false;
  }

  // $C4BE CALL $E555 -- divide by 8 with NO rounding.
  const isoX = divideBy8((v.isoPos.x >> 8) & 0xff, v.isoPos.x & 0xff);
  if (minX >= isoX) return false;
  // $C4CD is written inversely (JR NC keeps) because it is the last test; the
  // condition itself is the same as the other three.
  return clampedUpperBound(minX, SCREEN_WIDTH_TILES + 2 * PURGE_ZONE) >= isoX;
}

/**
 * Move a character struct into a free slot ($C4E0).
 *
 * Returns the slot used, or null when there was no free one -- "spawn no spare
 * slot" ($C4F4) simply gives up, so a crowded scene silently leaves characters
 * unspawned rather than growing the array.
 *
 * The position scaling branches on the room ($C502): outdoors the tinypos bytes
 * are multiplied by 8 into the 16-bit field, indoors they are widened
 * unchanged. That is the same 8:1 relationship the hero has, and getting it
 * wrong puts indoor characters eight times too far from the origin.
 *
 * $C592 onward acquires the character's first target, so it starts walking the
 * moment it appears rather than standing until something else prompts it. The
 * collision and bounds checks at $C523 are still absent -- they need `touch`,
 * which lands with the rest of the collision system.
 */
export function spawnCharacter(
  vischars: Vischar[],
  struct: CharacterStruct,
  currentRoom: number,
  ctx?: { random: () => number; structs: CharacterStruct[] },
): Vischar | null {
  if (struct.onScreen) return null; // $C4E0

  const slot = npcSlots(vischars).find(isEmpty); // $C4EE
  if (!slot) return null; // $C4F4

  // $C505 / $C518: scale by room.
  slot.pos =
    currentRoom === 0
      ? {
          x: struct.pos.x * 8,
          y: struct.pos.y * 8,
          height: struct.pos.height * 8,
        }
      : { x: struct.pos.x, y: struct.pos.y, height: struct.pos.height };

  struct.onScreen = true; // $C52C
  slot.character = struct.character; // $C532
  slot.flags = 0; // $C534

  const meta = metaFor(struct.character);
  slot.animbase = 0; // all four metadata entries share animations[0]
  slot.sprite = meta.spriteIndex; // $C55B, the set's base
  slot.spriteIndex = 0; // the frame within it, advanced by animate

  slot.room = currentRoom; // $C578
  slot.route = { ...struct.route }; // $C58C
  slot.counterAndFlags = 0;
  slot.anim = 0;
  slot.animIndex = 0;
  slot.input = 0;
  slot.direction = 0;
  slot.target = { ...struct.pos };

  // calc_vischar_iso_pos_from_vischar ($B71B) runs as part of placing the
  // character; purging reads iso_pos, so it must be valid immediately.
  const iso = calcIsoPos(slot.pos);
  slot.isoPos = { x: iso.x, y: iso.y };

  // $C592..$C5A1: a moving character gets its first target immediately, so it
  // walks from the frame it appears. Halted ones ($C594) skip this.
  if (ctx && slot.route.index !== 0) {
    getTargetAssignPos(slot, {
      random: ctx.random,
      structs: ctx.structs,
      room: currentRoom,
    });
  }

  return slot;
}

/**
 * Give a slot back ($C5D3).
 *
 * The position goes back into the struct at the scale the struct uses:
 * outdoors through pos_to_tinypos ($E542, divide by 8 with rounding), indoors
 * by taking the low byte of each word ($C626).
 *
 * The stove and crate take a different path entirely ($C5DC) -- their position
 * is written back into the movable_items table rather than a character struct,
 * and the disassembly notes that the resulting "stoves get left in place after
 * a restarted game" is a real bug the DOS version diverges on. Not reachable
 * here, because the demo places movables through setup_movable_items.
 */
export function resetVisibleCharacter(
  v: Vischar,
  structs: CharacterStruct[],
): void {
  if (v.character === CHARACTER_NONE) return; // $C5D6

  const struct = structs[v.character];
  if (struct) {
    struct.onScreen = false; // $C606
    struct.room = v.room; // $C60E
    struct.pos =
      v.room === 0
        ? {
            x: divideBy8WithRounding((v.pos.x >> 8) & 0xff, v.pos.x & 0xff),
            y: divideBy8WithRounding((v.pos.y >> 8) & 0xff, v.pos.y & 0xff),
            height: divideBy8WithRounding(
              (v.pos.height >> 8) & 0xff,
              v.pos.height & 0xff,
            ),
          }
        : {
            x: v.pos.x & 0xff,
            y: v.pos.y & 0xff,
            height: v.pos.height & 0xff,
          };
    struct.route = { ...v.route }; // $C64C
  }

  v.character = CHARACTER_NONE; // $C632
  v.flags = FLAGS_EMPTY_SLOT; // $C635
  v.counterAndFlags = 0; // $C615
}

/** spawn_characters ($C41C): one pass over all 26 structs. */
export function spawnCharacters(
  vischars: Vischar[],
  structs: CharacterStruct[],
  mapPosition: { x: number; y: number },
  currentRoom: number,
  ctx?: { random: () => number },
): number {
  let spawned = 0;
  for (let i = 0; i < CHARACTER_COUNT; i++) {
    const struct = structs[i];
    if (!struct) break;
    if (!shouldSpawn(struct, mapPosition, currentRoom)) continue;
    const full = ctx ? { random: ctx.random, structs } : undefined;
    if (spawnCharacter(vischars, struct, currentRoom, full)) spawned++;
  }
  return spawned;
}

/** purge_invisible_characters ($C47E): one pass over slots 1..7. */
export function purgeInvisibleCharacters(
  vischars: Vischar[],
  structs: CharacterStruct[],
  mapPosition: { x: number; y: number },
  currentRoom: number,
): number {
  let purged = 0;
  for (const v of npcSlots(vischars)) {
    if (v.character === CHARACTER_NONE) continue; // $C495
    if (shouldKeep(v, mapPosition, currentRoom)) continue;
    resetVisibleCharacter(v, structs);
    purged++;
  }
  return purged;
}

/** The flag mask, re-exported so callers need not reach into characters.js. */
export { FLAG_ON_SCREEN };
