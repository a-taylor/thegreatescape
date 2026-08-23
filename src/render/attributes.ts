/**
 * choose_game_window_attributes (c$AB6B).
 *
 * The game window is a single flat attribute block -- the Spectrum has one
 * attribute per 8x8 cell, and the game simply picks one value for the whole
 * window rather than colouring per tile. Which value depends on where the hero
 * is, whether it is night, and whether he is carrying a torch.
 */

/** Attribute values, from the constants block of TheGreatEscape.skool. */
export const ATTRIBUTE_RED_OVER_BLACK = 0x02;
export const ATTRIBUTE_CYAN_OVER_BLACK = 0x05;
export const ATTRIBUTE_WHITE_OVER_BLACK = 0x07;
export const ATTRIBUTE_BRIGHT_BLUE_OVER_BLACK = 0x41;

/** room_29_SECOND_TUNNEL_START -- the first of the tunnel rooms. */
export const FIRST_TUNNEL_ROOM = 29;
export const ROOM_OUTDOORS = 0;
export const ITEM_TORCH = 4;

export interface WindowAttributeResult {
  readonly attribute: number;
  /**
   * True when the tunnel is unlit: $AB96 wipes the visible tiles array so
   * nothing is drawn at all. Being in a dark tunnel is not a colour, it is an
   * absence of scenery, which is why this is a separate flag.
   */
  readonly wipeTiles: boolean;
}

/**
 * @param room       global current room index ($68A0)
 * @param night      the night-time flag ($A146)
 * @param itemsHeld  the two carried item slots ($8215); torch in either lights a tunnel
 */
export function chooseGameWindowAttributes(
  room: number,
  night: boolean,
  itemsHeld: readonly [number, number],
): WindowAttributeResult {
  // $AB6E CP $1D / JR NC -- room index >= 29 means a tunnel.
  if (room >= FIRST_TUNNEL_ROOM) {
    const holdsTorch = itemsHeld[0] === ITEM_TORCH || itemsHeld[1] === ITEM_TORCH;
    return holdsTorch
      ? { attribute: ATTRIBUTE_RED_OVER_BLACK, wipeTiles: false }
      : { attribute: ATTRIBUTE_RED_OVER_BLACK, wipeTiles: true };
  }

  if (!night) {
    return { attribute: ATTRIBUTE_WHITE_OVER_BLACK, wipeTiles: false };
  }

  return room === ROOM_OUTDOORS
    ? { attribute: ATTRIBUTE_BRIGHT_BLUE_OVER_BLACK, wipeTiles: false }
    : { attribute: ATTRIBUTE_CYAN_OVER_BLACK, wipeTiles: false };
}
