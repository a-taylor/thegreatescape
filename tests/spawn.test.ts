/**
 * spawn_characters (c$C41C), purge_invisible_characters (c$C47E),
 * spawn_character (c$C4E0) and reset_visible_character (c$C5D3).
 */

import { describe, expect, it } from 'vitest';

import {
  PURGE_ZONE,
  SPAWN_ZONE,
  purgeInvisibleCharacters,
  resetVisibleCharacter,
  shouldKeep,
  shouldSpawn,
  spawnCharacter,
  spawnCharacters,
  spawnProjection,
} from '../src/game/spawn.js';
import {
  CHARACTER_COUNT,
  characterClass,
  characterStructs,
  metaFor,
} from '../src/game/characters.js';
import {
  CHARACTER_NONE,
  VISCHAR_COUNT,
  createVischars,
  isEmpty,
  npcSlots,
} from '../src/game/vischar.js';
import { calcIsoPos } from '../src/game/coords.js';
import {
  installMovable,
  movableItems,
  pushMovable,
} from '../src/game/movable.js';
import { INTERIOR_MAP_POSITION } from '../src/game/doors.js';

describe('the vischar array', () => {
  it('is eight slots, all empty', () => {
    const vs = createVischars();
    expect(vs).toHaveLength(VISCHAR_COUNT);
    expect(vs.every(isEmpty)).toBe(true);
  });

  it('exposes seven non-player slots, never the hero', () => {
    // Every routine that walks NPCs starts at $8020 with a count of seven
    // ($C48F, $C4E4). Including slot 0 would let the hero be purged.
    const vs = createVischars();
    expect(npcSlots(vs)).toHaveLength(7);
    expect(npcSlots(vs).map((v) => v.slot)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('character_structs', () => {
  const structs = characterStructs();

  it('is 26 records', () => {
    expect(structs).toHaveLength(CHARACTER_COUNT);
  });

  it('decodes the commandant as the disassembly comments it', () => {
    // $7612 DEFB $00,$0B,$2E,$2E,$18,$03,$00
    //   { character_0_COMMANDANT, room_11_PAPERS, (46,46,24), (0x03,0x00) }
    const c = structs[0]!;
    expect(c.character).toBe(0);
    expect(c.room).toBe(11);
    expect(c.pos).toEqual({ x: 0x2e, y: 0x2e, height: 0x18 });
    expect(c.route).toEqual({ index: 3, step: 0 });
  });

  it('starts with nobody on screen', () => {
    expect(structs.some((s) => s.onScreen)).toBe(false);
  });

  it('hands out fresh records each call', () => {
    // These are mutated during play; a shared array would leak state across a
    // demo reset.
    const a = characterStructs();
    a[0]!.onScreen = true;
    expect(characterStructs()[0]!.onScreen).toBe(false);
  });
});

describe('character classification', () => {
  it('splits at the thresholds the comparison chain uses', () => {
    // $C53A / $C540 CP $10 / $C547 CP $14.
    expect(characterClass(0)).toBe('commandant');
    expect(characterClass(1)).toBe('guard');
    expect(characterClass(15)).toBe('guard');
    expect(characterClass(16)).toBe('dog');
    expect(characterClass(19)).toBe('dog');
    expect(characterClass(20)).toBe('prisoner');
    expect(characterClass(25)).toBe('prisoner');
  });

  it('gives each class its own sprite', () => {
    const sprites = ['commandant', 'guard', 'dog', 'prisoner'].map(
      (_, i) => metaFor([0, 1, 16, 20][i]!).spriteIndex,
    );
    expect(new Set(sprites).size).toBe(4);
    // sprites[2] is bitmap_prisoner_facing_top_left_1 -- the same base the
    // hero uses, which is the cross-check that the resolution is right.
    expect(metaFor(20).spriteIndex).toBe(2);
  });
});

describe("spawn_characters' cheap projection", () => {
  it('is exactly calc_vischar_iso_pos divided by 8', () => {
    // $C442..$C45C computes the isometric position in 8-bit registers, with
    // $200 written as 64 and $800 as 256 because its inputs are tinypos. This
    // asserts the two really are the same geometry -- if the constants were
    // misread the spawn band would sit somewhere else entirely.
    let checked = 0;
    for (let x = 0; x < 128; x += 3) {
      for (let y = 0; y < 128; y += 3) {
        for (const height of [0, 3, 24]) {
          const cheap = spawnProjection({ x, y, height });
          const real = calcIsoPos({ x: x * 8, y: y * 8, height: height * 8 });
          expect(cheap.x, `(${x},${y},${height}) x`).toBe((real.x >> 3) & 0xff);
          expect(cheap.y, `(${x},${y},${height}) y`).toBe((real.y >> 3) & 0xff);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });
});

describe('spawn eligibility', () => {
  const struct = () => characterStructs()[1]!; // guard 1, outdoors

  it('skips a character already on screen', () => {
    const s = struct();
    s.onScreen = true;
    expect(shouldSpawn(s, { x: 0, y: 0 }, 0)).toBe(false);
  });

  it('skips a character in a different room', () => {
    const s = struct();
    expect(s.room).toBe(0);
    expect(shouldSpawn(s, { x: 0, y: 0 }, 3)).toBe(false);
  });

  it('spawns everyone in an interior without testing position', () => {
    // $C43F jumps straight to the spawn call when indoors: a room is never
    // bigger than the window, so there is nothing to cull.
    const s = struct();
    s.room = 5;
    expect(shouldSpawn(s, { x: 200, y: 200 }, 5)).toBe(true);
  });

  it('accepts the character when the window is over him', () => {
    const s = struct();
    const p = spawnProjection(s.pos);
    expect(shouldSpawn(s, { x: p.x - 4, y: p.y - 4 }, 0)).toBe(true);
  });

  it('rejects him when the window is far away', () => {
    const s = struct();
    const p = spawnProjection(s.pos);
    expect(shouldSpawn(s, { x: (p.x + 120) & 0xff, y: (p.y + 120) & 0xff }, 0))
      .toBe(false);
  });
});

describe('the spawn and purge zones differ, and must', () => {
  it('is 8 for spawning and 9 for purging', () => {
    // "9 is the size, in UDGs, of a buffer zone around the visible screen in
    // which visible characters will persist. (Compare to the spawning size
    // of 8)."
    expect(SPAWN_ZONE).toBe(8);
    expect(PURGE_ZONE).toBe(9);
    expect(PURGE_ZONE).toBeGreaterThan(SPAWN_ZONE);
  });

  it('never purges a character on the frame it spawned', () => {
    // This is what the one-tile difference buys. If the zones matched, a
    // character spawning exactly on the boundary could be purged immediately
    // and respawned next frame -- visible as flicker at the window edge.
    const structs = characterStructs();
    const vs = createVischars();

    let spawnedAnywhere = 0;
    for (let mx = 0; mx < 220; mx += 5) {
      for (let my = 0; my < 140; my += 5) {
        const map = { x: mx, y: my };
        for (const s of structs) {
          if (s.room !== 0 || s.onScreen) continue;
          if (!shouldSpawn(s, map, 0)) continue;

          const slot = spawnCharacter(vs, s, 0);
          if (!slot) continue;
          spawnedAnywhere++;
          expect(shouldKeep(slot, map, 0), `char ${s.character} at ${mx},${my}`)
            .toBe(true);
          resetVisibleCharacter(slot, structs);
        }
      }
    }
    expect(spawnedAnywhere).toBeGreaterThan(50);
  });
});

describe('spawning into a slot', () => {
  it('scales position by 8 outdoors and not at all indoors', () => {
    // $C505 vs $C518. Getting this wrong puts indoor characters eight times
    // too far from the origin.
    const structs = characterStructs();
    const s = structs[1]!;
    s.pos = { x: 10, y: 20, height: 3 };

    const out = spawnCharacter(createVischars(), s, 0)!;
    expect(out.pos).toEqual({ x: 80, y: 160, height: 24 });

    s.onScreen = false;
    const inside = spawnCharacter(createVischars(), s, 5)!;
    expect(inside.pos).toEqual({ x: 10, y: 20, height: 3 });
  });

  it('marks the struct on-screen so it is not spawned twice', () => {
    const structs = characterStructs();
    const vs = createVischars();
    const s = structs[1]!;

    expect(spawnCharacter(vs, s, 0)).not.toBeNull();
    expect(s.onScreen).toBe(true);
    expect(spawnCharacter(vs, s, 0)).toBeNull();
    expect(npcSlots(vs).filter((v) => !isEmpty(v))).toHaveLength(1);
  });

  it('gives up quietly when all seven slots are taken', () => {
    // $C4F4 "spawn no spare slot" just returns. A crowded scene leaves
    // characters unspawned rather than growing the array.
    const structs = characterStructs();
    const vs = createVischars();
    for (let i = 1; i <= 7; i++) spawnCharacter(vs, structs[i]!, 0);
    expect(npcSlots(vs).every((v) => !isEmpty(v))).toBe(true);
    expect(spawnCharacter(vs, structs[8]!, 0)).toBeNull();
  });

  it('leaves the hero slot alone', () => {
    const structs = characterStructs();
    const vs = createVischars();
    for (let i = 1; i <= 10; i++) spawnCharacter(vs, structs[i]!, 0);
    expect(vs[0]!.character).toBe(CHARACTER_NONE);
  });

  it('fills iso_pos, because purging reads it immediately', () => {
    const s = characterStructs()[1]!;
    const slot = spawnCharacter(createVischars(), s, 0)!;
    expect(slot.isoPos).toEqual(calcIsoPos(slot.pos));
  });
});

describe('returning a slot', () => {
  it('writes the position back at the struct\'s scale', () => {
    const structs = characterStructs();
    const vs = createVischars();
    const s = structs[1]!;
    const original = { ...s.pos };

    const slot = spawnCharacter(vs, s, 0)!;
    resetVisibleCharacter(slot, structs);

    expect(s.onScreen).toBe(false);
    expect(s.pos).toEqual(original); // *8 out, /8 back
    expect(slot.character).toBe(CHARACTER_NONE);
  });

  it('records the room the character was left in', () => {
    const structs = characterStructs();
    const s = structs[1]!;
    const slot = spawnCharacter(createVischars(), s, 0)!;
    slot.room = 7;
    resetVisibleCharacter(slot, structs);
    expect(s.room).toBe(7); // $C60E
  });

  it('does nothing to an already-empty slot', () => {
    const structs = characterStructs();
    const vs = createVischars();
    expect(() => resetVisibleCharacter(vs[3]!, structs)).not.toThrow();
    expect(structs.some((s) => s.onScreen)).toBe(false);
  });
});

describe('a full spawn and purge cycle', () => {
  it('populates near the hero and empties again when he leaves', () => {
    const structs = characterStructs();
    const vs = createVischars();

    // Park the window over guard 1 and spawn.
    const p = spawnProjection(structs[1]!.pos);
    const near = { x: (p.x - 4) & 0xff, y: (p.y - 4) & 0xff };
    expect(spawnCharacters(vs, structs, near, 0)).toBeGreaterThan(0);

    const occupied = npcSlots(vs).filter((v) => !isEmpty(v)).length;
    expect(occupied).toBeGreaterThan(0);

    // Walk the window away; everyone should be handed back.
    purgeInvisibleCharacters(vs, structs, { x: 0, y: 0 }, 0);
    expect(npcSlots(vs).every(isEmpty)).toBe(true);
    expect(structs.every((s) => !s.onScreen)).toBe(true);
  });

  it('is stable when run repeatedly in the same place', () => {
    // Spawn/purge must reach a fixed point rather than churning slots.
    const structs = characterStructs();
    const vs = createVischars();
    const p = spawnProjection(structs[1]!.pos);
    const map = { x: (p.x - 4) & 0xff, y: (p.y - 4) & 0xff };

    spawnCharacters(vs, structs, map, 0);
    const first = npcSlots(vs).map((v) => v.character);

    for (let i = 0; i < 10; i++) {
      purgeInvisibleCharacters(vs, structs, map, 0);
      spawnCharacters(vs, structs, map, 0);
    }
    expect(npcSlots(vs).map((v) => v.character)).toEqual(first);
  });
});

describe('a room whose slot 1 holds a movable', () => {
  /** Room 2: the stove in slot 1, and guard 13 to spawn alongside it. */
  function room2() {
    const structs = characterStructs();
    const vs = createVischars();
    installMovable(vs[1]!, movableItems.stove1!, 2);
    return { structs, vs };
  }

  it('survives a purge instead of being evicted immediately', () => {
    // The bug this covers: marking slot 1 occupied but leaving its room at 0
    // fails purge's very first test ($C4A3), so the stove was evicted on the
    // next tick and the slot handed to a real character.
    const { structs, vs } = room2();
    expect(vs[1]!.room).toBe(2);
    purgeInvisibleCharacters(vs, structs, INTERIOR_MAP_POSITION, 2);
    expect(isEmpty(vs[1]!)).toBe(false);
    expect(vs[1]!.character).toBe(movableItems.stove1!.character);
  });

  it('makes the room\'s guard take slot 2, not slot 1', () => {
    // With slot 1 wrongly freed, the guard landed in it and the renderer --
    // which special-cased index 1 as "the movable" -- drew a stove on top of a
    // stove and no guard at all.
    const { structs, vs } = room2();
    purgeInvisibleCharacters(vs, structs, INTERIOR_MAP_POSITION, 2);
    spawnCharacters(vs, structs, INTERIOR_MAP_POSITION, 2);

    expect(vs[1]!.character).toBe(movableItems.stove1!.character);
    expect(vs[2]!.character).toBe(13);
  });

  it('is stable over many ticks', () => {
    const { structs, vs } = room2();
    for (let i = 0; i < 20; i++) {
      purgeInvisibleCharacters(vs, structs, INTERIOR_MAP_POSITION, 2);
      spawnCharacters(vs, structs, INTERIOR_MAP_POSITION, 2);
    }
    expect(vs[1]!.character).toBe(movableItems.stove1!.character);
    expect(vs[2]!.character).toBe(13);
    expect(npcSlots(vs).filter((v) => !isEmpty(v))).toHaveLength(2);
  });

  it('keeps the projected position in step with a push', () => {
    // purge reads iso_pos, not pos, so a stale projection would judge the
    // stove from where it used to be.
    const { vs } = room2();
    const slot = vs[1]!;
    const before = { ...slot.isoPos };

    // pushMovable refreshes the projection itself, so a caller cannot forget.
    pushMovable(slot, 1);
    expect(slot.isoPos).not.toEqual(before);
    expect(slot.isoPos).toEqual(calcIsoPos(slot.pos));
  });
});
