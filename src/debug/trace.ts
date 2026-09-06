/**
 * Trace mode, per the brief's §8.
 *
 * The requirement is to log routine entry by address, so that what the game
 * did can be checked against a reading of the disassembly when something looks
 * wrong.
 *
 * That last clause is the design brief. The point is not a profiler and not a
 * complete instruction trace -- it is to be able to sit with the disassembly
 * open and check that the game went through the routines it should have, in
 * the order it should have, on the frame in question. So what is traced is
 * routine ENTRY, by address, with the one or two values that make the entry
 * meaningful.
 *
 * Off by default and free when off: `trace()` returns on a boolean before
 * touching its arguments, so the call sites cost nothing in a normal run.
 * Enable with `?trace=1`, or `?trace=200` to keep only the last 200 frames.
 *
 * The log is kept in memory and exposed as `window.__trace` rather than
 * printed, because a per-frame console.log of a dozen entries drowns the
 * console within seconds. Read it with `__trace.dump()`.
 */

export interface TraceEntry {
  /** The frame this happened on. */
  frame: number;
  /** The disassembly address, as it is written everywhere else: "$9D7B". */
  addr: string;
  /** The label, so the log reads without the .skool open. */
  label: string;
  /** Whatever makes this entry worth having. */
  detail?: string | undefined;
}

let enabled = false;
let frameLimit = 0;
let frame = 0;
const entries: TraceEntry[] = [];

/**
 * Turn tracing on.
 *
 * @param frames how many frames of history to keep; 0 keeps everything, which
 *   is fine for a few thousand frames and not for a day.
 */
export function enableTrace(frames = 0): void {
  enabled = true;
  frameLimit = frames;
}

export function traceEnabled(): boolean {
  return enabled;
}

/** Record entry to a routine. */
export function trace(addr: string, label: string, detail?: string): void {
  if (!enabled) return;
  entries.push({ frame, addr, label, detail });
}

/**
 * Mark a frame boundary, and drop history beyond the limit.
 *
 * Trimming here rather than on every push keeps the common path to one integer
 * compare.
 */
export function traceFrame(): void {
  if (!enabled) return;
  frame++;
  if (frameLimit > 0) {
    const oldest = frame - frameLimit;
    while (entries.length > 0 && entries[0]!.frame < oldest) entries.shift();
  }
}

export function traceEntries(): readonly TraceEntry[] {
  return entries;
}

/** The log as text, one routine per line, grouped by frame. */
export function traceDump(fromFrame = 0): string {
  const lines: string[] = [];
  let current = -1;
  for (const e of entries) {
    if (e.frame < fromFrame) continue;
    if (e.frame !== current) {
      current = e.frame;
      lines.push(`--- frame ${current}`);
    }
    lines.push(`  ${e.addr}  ${e.label}${e.detail ? `  ${e.detail}` : ''}`);
  }
  return lines.join('\n');
}

export function traceClear(): void {
  entries.length = 0;
  frame = 0;
}

/** The current frame number, for a caller that wants to correlate. */
export function traceFrameNumber(): number {
  return frame;
}
