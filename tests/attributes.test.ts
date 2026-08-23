/**
 * choose_game_window_attributes (c$AB6B).
 *
 * Every branch of the routine, asserted against the constants named in the
 * disassembly's own comments rather than against observed output.
 */

import { describe, expect, it } from 'vitest';

import {
  ATTRIBUTE_BRIGHT_BLUE_OVER_BLACK,
  ATTRIBUTE_CYAN_OVER_BLACK,
  ATTRIBUTE_RED_OVER_BLACK,
  ATTRIBUTE_WHITE_OVER_BLACK,
  FIRST_TUNNEL_ROOM,
  ITEM_TORCH,
  chooseGameWindowAttributes,
} from '../src/render/attributes.js';

const NOTHING: [number, number] = [0xff, 0xff];
const OUTDOORS = 0;
const HUT1LEFT = 28; // the last room before the tunnels

describe('choose_game_window_attributes', () => {
  it('uses white over black by day, outdoors and inside', () => {
    // $AB75 LD C,$07 -- "Default attribute is attribute_WHITE_OVER_BLACK"
    expect(chooseGameWindowAttributes(OUTDOORS, false, NOTHING)).toEqual({
      attribute: ATTRIBUTE_WHITE_OVER_BLACK,
      wipeTiles: false,
    });
    expect(chooseGameWindowAttributes(HUT1LEFT, false, NOTHING).attribute).toBe(
      ATTRIBUTE_WHITE_OVER_BLACK,
    );
  });

  it('uses bright blue outdoors at night', () => {
    // $AB7D LD C,$41
    expect(chooseGameWindowAttributes(OUTDOORS, true, NOTHING)).toEqual({
      attribute: ATTRIBUTE_BRIGHT_BLUE_OVER_BLACK,
      wipeTiles: false,
    });
  });

  it('uses cyan indoors at night', () => {
    // $AB82 LD C,$05
    expect(chooseGameWindowAttributes(HUT1LEFT, true, NOTHING).attribute).toBe(
      ATTRIBUTE_CYAN_OVER_BLACK,
    );
  });

  it('treats room 29 and above as tunnels', () => {
    // $AB6E CP $1D / JR NC -- 29 is room_29_SECOND_TUNNEL_START.
    expect(FIRST_TUNNEL_ROOM).toBe(29);
    expect(chooseGameWindowAttributes(28, false, NOTHING).wipeTiles).toBe(false);
    expect(chooseGameWindowAttributes(29, false, NOTHING).wipeTiles).toBe(true);
  });

  it('lights a tunnel red when the torch is held, in either slot', () => {
    // $AB89 LD C,$02, then $AB90/$AB93 test both halves of items_held.
    for (const held of [
      [ITEM_TORCH, 0xff],
      [0xff, ITEM_TORCH],
    ] as Array<[number, number]>) {
      expect(chooseGameWindowAttributes(30, false, held)).toEqual({
        attribute: ATTRIBUTE_RED_OVER_BLACK,
        wipeTiles: false,
      });
    }
  });

  it('wipes the tiles in an unlit tunnel', () => {
    // $AB96 CALL $6A27 -- "The hero holds no torch - wipe the tiles so that
    // nothing gets drawn." Darkness is an absence of scenery, not a colour.
    const r = chooseGameWindowAttributes(30, false, NOTHING);
    expect(r.wipeTiles).toBe(true);
  });

  it('ignores the night flag inside tunnels', () => {
    // The tunnel branch returns before the night check is ever reached.
    expect(chooseGameWindowAttributes(40, true, [ITEM_TORCH, 0xff]).attribute).toBe(
      ATTRIBUTE_RED_OVER_BLACK,
    );
    expect(chooseGameWindowAttributes(40, false, [ITEM_TORCH, 0xff]).attribute).toBe(
      ATTRIBUTE_RED_OVER_BLACK,
    );
  });
});
