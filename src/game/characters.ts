/**
 * character_structs ($7612): where the 26 characters are when off-screen.
 *
 * The game keeps every character's position in one of two places, never both.
 * When a character is far from the hero it lives here, as a seven-byte record
 * at tinypos scale. When the hero comes close, spawn_character copies it into a
 * vischar slot and sets characterstruct_FLAG_ON_SCREEN; when he leaves,
 * reset_visible_character copies the position back and clears the flag. So this
 * table is authored starting state AND live storage, and the flag is what says
 * which of the two representations is current.
 */

import charactersJson from '../../data/characters.json';

/** vischars_LENGTH aside, there are 26 characters ($C430 sets B to $1A). */
export const CHARACTER_COUNT = 26;

/** characterstruct_CHARACTER_MASK ($C530). */
export const CHARACTER_MASK = 0x1f;

/** characterstruct_FLAG_ON_SCREEN, "this disables the character" ($C432). */
export const FLAG_ON_SCREEN = 1 << 6;

export const CHARACTER_COMMANDANT = 0;
export const FIRST_GUARD = 1;
export const FIRST_DOG = 16;
export const FIRST_PRISONER = 20;
/** character_26_STOVE_1: the movable items sit at the top of the range. */
export const FIRST_MOVABLE = 26;

export type CharacterClass = 'commandant' | 'guard' | 'dog' | 'prisoner';

export interface CharacterMeta {
  readonly class: CharacterClass;
  readonly animbaseAddr: string;
  readonly spriteAddr: string;
  readonly spriteIndex: number;
}

const data = charactersJson as unknown as {
  count: number;
  structStride: number;
  structs: number[][];
  metaData: CharacterMeta[];
};

export const characterMeta: readonly CharacterMeta[] = data.metaData;

/**
 * Which metadata a character gets ($C537..$C54B).
 *
 * A chain of comparisons, not a table: commandant is 0, guards run to 15, dogs
 * to 19, and everything from 20 up falls through to prisoner. Note the last
 * branch has no upper bound, so characters 26..28 -- the stove and crate --
 * would classify as prisoners here. They never reach this code, because
 * spawn_characters only walks the 26 real characters and the movables are
 * placed by setup_movable_items instead.
 */
export function characterClass(character: number): CharacterClass {
  if (character === CHARACTER_COMMANDANT) return 'commandant'; // $C53A
  if (character < FIRST_DOG) return 'guard'; // $C540 CP $10
  if (character < FIRST_PRISONER) return 'dog'; // $C547 CP $14
  return 'prisoner'; // $C54B
}

export function metaFor(character: number): CharacterMeta {
  const wanted = characterClass(character);
  const meta = characterMeta.find((m) => m.class === wanted);
  if (!meta) throw new Error(`no character_meta_data for class ${wanted}`);
  return meta;
}

export interface CharacterStruct {
  readonly index: number;
  /** Low 5 bits of byte 0. */
  character: number;
  /** Bit 6: the character is currently in a vischar slot, so ignore this record. */
  onScreen: boolean;
  /** Byte 1. */
  room: number;
  /** Bytes 2..4, tinypos scale. */
  pos: { x: number; y: number; height: number };
  /** Bytes 5..6. Bit 7 of index is route_REVERSED. */
  route: { index: number; step: number };
}

/**
 * Decode the table into live records.
 *
 * Returns fresh objects each call: these are mutated during play (the on-screen
 * flag, the room, the position on the way back out), so handing out a shared
 * array would leak state between a demo reset and the next run.
 */
export function characterStructs(): CharacterStruct[] {
  return data.structs.map((r, index) => ({
    index,
    character: r[0]! & CHARACTER_MASK,
    onScreen: (r[0]! & FLAG_ON_SCREEN) !== 0,
    room: r[1]!,
    pos: { x: r[2]!, y: r[3]!, height: r[4]! },
    route: { index: r[5]!, step: r[6]! },
  }));
}

/**
 * get_character_struct ($C7B9): the record for a character index.
 *
 * The table is in character order, so this is a plain index -- but going
 * through a named function keeps the assumption checkable rather than spread
 * across call sites.
 */
export function characterStructFor(
  structs: CharacterStruct[],
  character: number,
): CharacterStruct | undefined {
  return structs[character & CHARACTER_MASK];
}
