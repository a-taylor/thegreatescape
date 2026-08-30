/**
 * The searchlights: nighttime ($ADBD), searchlight_movement ($AD59) and
 * searchlight_caught ($AE78).
 *
 * Three lights sweep the camp after dark. Each walks a $FF-terminated list of
 * {counter, direction} pairs, stepping two units a frame until its counter
 * runs out, then taking the next pair. The list can be walked BACKWARDS: bit 7
 * of the step index is a reverse flag, so a light retraces its sweep rather
 * than jumping back to the start.
 *
 * Once a light has the hero it stops sweeping. `searchlight_state` becomes
 * CAUGHT, and from then on ONE light tracks him -- the other two stop being
 * simulated at all ($ADD2 takes the single-searchlight path) -- until he gets
 * indoors, which is the only thing that shakes it off ($ADCC).
 */

import timingJson from '../../data/timing.json';
import { decreaseMorale, type PlayerState } from './player.js';

const timing = timingJson as unknown as {
  searchlightState: { initial: number };
  searchlightMovements: {
    entries: Array<{
      index: number;
      x: number;
      y: number;
      counter: number;
      direction: number;
      step: number;
      path: Array<{ counter: number; direction: number }>;
    }>;
  };
};

/** searchlight_STATE_SEARCHING ($ADC1 CP $FF). */
export const STATE_SEARCHING = 0xff;
/** searchlight_STATE_CAUGHT ($ADD0 CP $1F). */
export const STATE_CAUGHT = 0x1f;
/**
 * The state is a COUNTER, and $1F is only its top.
 *
 * $81BD's own table in the disassembly reads: 255 searching, 31 caught, and
 * 0..30 "tracking the hero". Every frame the hero is fully hidden behind
 * scenery the counter drops by one ($B854); the moment any part of him is
 * exposed it snaps back to 31 ($B863). Escaping therefore takes 32 consecutive
 * frames out of sight, and that countdown IS the mechanic -- without it a
 * light that has him never lets go except by his going indoors.
 */
export const STATE_TRACKING_MAX = 0x1e;
/** Being caught costs 10 morale ($AEB3 LD B,$0A). */
export const CAUGHT_MORALE_COST = 0x0a;
/** The step index's reverse flag ($AD64 BIT 7). */
export const STEP_REVERSED = 0x80;

/** mask_buffer ($8100) + $31, "approximately the middle" ($B841). */
export const MASK_TEST_OFFSET = 0x31;
/** Eight rows ($B844 LD B of $0804). */
export const MASK_TEST_ROWS = 8;
/** Four INC L per row ($B84B..$B84E) -- the buffer is four bytes wide. */
export const MASK_TEST_STRIDE = 4;

export interface Searchlight {
  x: number;
  y: number;
  counter: number;
  direction: number;
  /** movement.index, with bit 7 as the reverse flag. */
  step: number;
  readonly path: ReadonlyArray<{ counter: number; direction: number }>;
}

export interface SearchlightState {
  lights: Searchlight[];
  /** searchlight_state ($81BD). */
  state: number;
  /** searchlight_caught_coord ($AE76), where the tracking light sits. */
  caught: { x: number; y: number };
}

export function createSearchlights(): SearchlightState {
  return {
    lights: timing.searchlightMovements.entries.map((e) => ({
      x: e.x,
      y: e.y,
      counter: e.counter,
      direction: e.direction,
      step: e.step,
      path: e.path,
    })),
    // $81BD ships as $04, not $FF: the game begins with a light four frames
    // from giving up, not sweeping. Parsed, not typed.
    state: timing.searchlightState.initial,
    caught: { x: 0, y: 0 },
  };
}

/**
 * searchlight_mask_test ($B83B): has the hero broken line of sight?
 *
 * Called from plot_sprites ($B87B) for every vischar plotted, but only while
 * the state is not SEARCHING, and it returns immediately for anyone who is not
 * the hero -- `LD A,L / AND A` ($B83E) is the SLOT test again, not a character
 * index.
 *
 * It samples eight rows of the mask buffer starting at `mask_buffer + $31`
 * ($B841), "approximately the middle of the character", four bytes apart --
 * which is one byte per PIXEL row, since the buffer is four bytes wide.
 *
 * The polarity is the part worth getting right, and it is not what the
 * routine's own header comment ("is the hero hiding behind the scenery")
 * suggests on a first read. The mask buffer is a PERMISSION mask, not an
 * occlusion mask: render_mask_buffer fills it with $FF and ANDs scenery in, so
 * a 1 bit means "the sprite may draw here" and 0 means "scenery covers it".
 * So a NON-ZERO byte means some of the hero is still exposed, and all eight
 * bytes zero means he is completely behind something. That is why non-zero
 * jumps to still_in_searchlight.
 *
 * The original also does a fused `LD BC,$0804` and never uses C ($B844) -- a
 * leftover stride constant, flagged as such in the disassembly. Nothing to
 * reproduce; the stride of four is in the pointer arithmetic either way.
 *
 * @param maskBuffer the buffer render_mask_buffer just filled for the hero.
 * @returns true if the state reached SEARCHING on this call, which is the
 *   moment the light gives up and the window attributes must be restored
 *   ($B859).
 */
export function searchlightMaskTest(s: SearchlightState, maskBuffer: Uint8Array): boolean {
  // $B87B: the caller only calls at all when the light has him.
  if (s.state === STATE_SEARCHING) return false;

  for (let row = 0; row < MASK_TEST_ROWS; row++) {
    const byte = maskBuffer[MASK_TEST_OFFSET + row * MASK_TEST_STRIDE] ?? 0;
    if (byte !== 0) {
      // $B860 still_in_searchlight: exposed, so the countdown restarts.
      s.state = STATE_CAUGHT;
      return false;
    }
  }

  // $B854: out of sight for this frame -- one step closer to escaping.
  s.state = (s.state - 1) & 0xff;
  // $B855: DEC wrapping $00 -> $FF is exactly how the light gives up.
  return s.state === STATE_SEARCHING;
}

/**
 * searchlight_movement ($AD59): advance one light by one frame.
 *
 * The counter is decremented FIRST ($AD5D). While it is non-zero the light
 * just steps; when it hits zero the next pair of the path is loaded.
 *
 * The reverse walk ($AD64..$AD77) is the interesting half. With bit 7 set the
 * index counts DOWN, and on reaching zero the flag is cleared so the light
 * sweeps forward again. Running off the END of the list sets the flag instead
 * ($AD8B), so a light bounces along its path rather than looping.
 */
export function searchlightMovement(light: Searchlight): void {
  light.counter = (light.counter - 1) & 0xff; // $AD5D

  if (light.counter === 0) {
    // $AD63: pick the next step, forwards or backwards.
    let index = light.step;
    if ((index & STEP_REVERSED) !== 0) {
      index &= 0x7f; // $AD69
      if (index === 0) {
        light.step &= ~STEP_REVERSED & 0xff; // $AD6E, done reversing
      } else {
        light.step = (light.step - 1) & 0xff; // $AD72
        index -= 1;
      }
    } else {
      index += 1; // $AD76
      light.step = index;
    }

    const next = light.path[index];
    if (!next) {
      // $AD8A: ran off the end -- step back and start reversing.
      light.step = ((light.step - 1) & 0xff) | STEP_REVERSED;
      const back = light.path[Math.max(0, index - 1)];
      if (back) {
        light.counter = back.counter;
        light.direction = back.direction;
      }
      return;
    }
    light.counter = next.counter; // $AD92
    light.direction = next.direction; // $AD96
    return;
  }

  // $AD99: step. A reversed light travels the opposite way along the same
  // line, which is what `XOR $02` does to the direction.
  let direction = light.direction;
  if ((light.step & STEP_REVERSED) !== 0) direction ^= 0x02; // $ADA0

  // $ADA2: TOP_* moves up the screen, BOTTOM_* down.
  light.y = (light.y + (direction < 2 ? -1 : 1)) & 0xff;
  // $ADA9: directions 0 and 3 move left, 1 and 2 right -- two units at a time.
  light.x = (light.x + (direction === 0 || direction === 3 ? -2 : 2)) & 0xff;
}

/**
 * searchlight_caught ($AE78): does this light have the hero?
 *
 * Tested against `map_position` ($81BB) -- the VIEW -- not against the hero's
 * own position. Outdoors the view is centred on him, so the two agree; but it
 * means the beam catches the camera, and the offsets below are all relative to
 * the window rather than to the man.
 *
 * @returns true if this call is the moment of capture.
 */
export function searchlightCaught(
  s: SearchlightState,
  light: Searchlight,
  mapPosition: { x: number; y: number },
  player: PlayerState,
  ringBell: () => void,
): boolean {
  // $AE7C..$AE8A, x overlap.
  if (((light.x + 5) & 0xff) >= ((mapPosition.x + 12) & 0xff)) return false;
  if (((light.x + 10) & 0xff) < ((mapPosition.x + 10) & 0xff)) return false;
  // $AE8C..$AE9C, y overlap. Note the asymmetric margins: +5/+12 against
  // +10/+6, not a square box.
  if (((light.y + 5) & 0xff) >= ((mapPosition.y + 10) & 0xff)) return false;
  if (((mapPosition.y + 6) & 0xff) >= ((light.y + 12) & 0xff)) return false;

  // $AE9D: already caught, so no repeat penalty.
  if (s.state === STATE_CAUGHT) return false;

  s.state = STATE_CAUGHT; // $AEA5
  s.caught = { x: light.x, y: light.y }; // $AEAB
  ringBell(); // $AEB0, bell_RING_PERPETUAL
  decreaseMorale(player, CAUGHT_MORALE_COST); // $AEB5
  return true;
}

export interface NighttimeContext {
  /** The global current room index ($68A0). */
  readonly room: number;
  /** map_position ($81BB). */
  readonly mapPosition: { x: number; y: number };
  readonly player: PlayerState;
  ringBell(): void;
}

/**
 * nighttime ($ADBD), called once a frame while day_or_night is set.
 *
 * @returns the lights that should be drawn this frame.
 */
export function nighttime(s: SearchlightState, ctx: NighttimeContext): Searchlight[] {
  if (s.state === STATE_SEARCHING) {
    // $AE0D: all three sweep, and each is tested against the hero.
    for (const light of s.lights) {
      searchlightMovement(light); // $AE14
      searchlightCaught(s, light, ctx.mapPosition, ctx.player, ctx.ringBell); // $AE19
    }
    return s.lights;
  }

  // $ADC6: going indoors is the only way to lose the beam.
  if (ctx.room !== 0) {
    s.state = STATE_SEARCHING; // $ADCC
    return [];
  }

  // $ADD5: caught, so one light tracks him. The other two stop moving
  // entirely -- the sweep does not carry on behind the scenes.
  if (s.state === STATE_CAUGHT) {
    const target = { x: (ctx.mapPosition.x + 4) & 0xff, y: ctx.mapPosition.y };
    if (s.caught.x < target.x) s.caught.x++;
    else if (s.caught.x > target.x) s.caught.x--;
    if (s.caught.y < target.y) s.caught.y++;
    else if (s.caught.y > target.y) s.caught.y--;
  }

  // $AE00: one searchlight, drawn at the caught coordinate.
  return [{ ...s.lights[0]!, x: s.caught.x, y: s.caught.y }];
}

/** attribute_YELLOW_OVER_BLACK, the lit beam ($AF24 LD (HL),$06). */
export const ATTR_BEAM = 0x06;
/** attribute_BRIGHT_BLUE_OVER_BLACK, the night around it ($AF28 LD (HL),$41). */
export const ATTR_NIGHT = 0x41;

/** The shape is 16 rows of 2 bytes ($AEBC LD C,$10, $AEF2 LD B,$02). */
export const SHAPE_ROWS = 16;
export const SHAPE_BYTES_PER_ROW = 2;

/** Column clip: plot only within [7, 30) ($AEF6 LD DE,$071E). */
export const CLIP_LEFT = 7;
export const CLIP_RIGHT = 30;
/** ...or [7, 22) when searchlight_clip_left is set ($AF06 CP $16). */
export const CLIP_RIGHT_CLIPPED = 22;
/** Row clip: attribute rows 2..17 ($AED6 $5840 .. $AEC2 $5A40). */
export const CLIP_TOP_ROW = 2;
export const CLIP_BOTTOM_ROW = 18;

/**
 * searchlight_plot ($AEB8).
 *
 * The beam is an ATTRIBUTE effect, not pixels: a 16x16 block where a set bit
 * of searchlight_shape paints YELLOW and a CLEAR bit paints BRIGHT BLUE. So
 * the light does not just brighten its circle -- it repaints the night around
 * it too, which is why the camp is blue after dark.
 *
 * @param shape searchlight_shape ($AF3E), 32 bytes.
 * @param write receives (col, row, attribute) for each cell that survives the
 *   clip; the caller owns the attribute file.
 */
/**
 * The window's top-left attribute cell ($5847 -> column 7, row 2).
 *
 * Searchlight positions are in MAP space; the window shows map columns
 * [map_x, map_x + 23) at screen columns [7, 30), and map rows [map_y,
 * map_y + 16) at screen rows [2, 18). The clip bounds above are the same
 * numbers seen from the other end.
 */
export const WINDOW_ORIGIN_COL = 7;
export const WINDOW_ORIGIN_ROW = 2;

/**
 * Is this light on screen, and where ($AE22..$AE53)?
 *
 * The four bounds tests are each 16 or 23 units, and a light straddling the
 * left edge sets the clip flag ($AE4B CPL) rather than being dropped -- it is
 * drawn cropped.
 *
 * @returns screen attribute coordinates, or null if the light is off-window.
 */
export function lightOnScreen(
  light: { x: number; y: number },
  mapPosition: { x: number; y: number },
): { x: number; y: number; clipLeft: boolean } | null {
  if (mapPosition.x + 23 < light.x) return null; // $AE26, off the right
  if (light.x + 16 < mapPosition.x) return null; // $AE2D, off the left
  if (mapPosition.y + 16 < light.y) return null; // $AE35, off the top
  if (light.y + 16 < mapPosition.y) return null; // $AE3C, off the bottom

  const dx = light.x - mapPosition.x; // $AE45
  return {
    x: WINDOW_ORIGIN_COL + dx,
    y: WINDOW_ORIGIN_ROW + (light.y - mapPosition.y), // $AE53
    clipLeft: dx < 0, // $AE49, straddling the left edge
  };
}

export function searchlightPlot(
  light: { x: number; y: number },
  shape: Uint8Array,
  clipLeft: boolean,
  write: (col: number, row: number, attr: number) => void,
): void {
  const right = clipLeft ? CLIP_RIGHT_CLIPPED : CLIP_RIGHT; // $AF06 / $AF0E

  for (let r = 0; r < SHAPE_ROWS; r++) {
    const row = light.y + r;
    // $AED2 / $AEE6: rows outside the window are skipped whole, and the shape
    // pointer still advances -- the beam is cropped, not shifted.
    if (row < CLIP_TOP_ROW || row >= CLIP_BOTTOM_ROW) continue;

    for (let b = 0; b < SHAPE_BYTES_PER_ROW; b++) {
      const bits = shape[r * SHAPE_BYTES_PER_ROW + b] ?? 0;
      for (let bit = 0; bit < 8; bit++) {
        const col = light.x + b * 8 + bit;
        // $AF18 `CP D` with D = 7: columns left of the window are skipped.
        if (col < CLIP_LEFT || col >= right) continue;
        const set = (bits & (0x80 >> bit)) !== 0; // $AF1F RL C
        write(col, row, set ? ATTR_BEAM : ATTR_NIGHT);
      }
    }
  }
}
