/**
 * Presents a SpectrumScreen on a canvas.
 *
 * BUILD_PROMPT.md §2: a single <canvas> at the native 256x192, integer-scaled
 * with nearest-neighbour and `image-rendering: pixelated`. Letterbox; never
 * stretch non-uniformly. A non-integer scale would resample the 1bpp bitmap and
 * destroy exactly the pixel fidelity the rest of the project is built to
 * preserve, so the scale is always floored to a whole number.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH, type SpectrumScreen } from './display.js';

export class CanvasPresenter {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly buffer: HTMLCanvasElement;
  private readonly bufferCtx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;

    // Compose at native resolution in an offscreen buffer, then upscale in one
    // step. Drawing ImageData straight to a scaled canvas would ignore the
    // transform, so the intermediate is required, not incidental.
    this.buffer = document.createElement('canvas');
    this.buffer.width = SCREEN_WIDTH;
    this.buffer.height = SCREEN_HEIGHT;
    const bctx = this.buffer.getContext('2d', { alpha: false });
    if (!bctx) throw new Error('2d buffer context unavailable');
    this.bufferCtx = bctx;

    this.image = this.bufferCtx.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
  }

  /** Largest whole-number scale that fits, never below 1. */
  static scaleFor(width: number, height: number): number {
    return Math.max(1, Math.floor(Math.min(width / SCREEN_WIDTH, height / SCREEN_HEIGHT)));
  }

  /** Size the canvas to its container, accounting for device pixel ratio. */
  resize(containerWidth: number, containerHeight: number): void {
    const scale = CanvasPresenter.scaleFor(containerWidth, containerHeight);
    this.canvas.width = SCREEN_WIDTH * scale;
    this.canvas.height = SCREEN_HEIGHT * scale;
    this.canvas.style.width = `${SCREEN_WIDTH * scale}px`;
    this.canvas.style.height = `${SCREEN_HEIGHT * scale}px`;
    this.canvas.style.imageRendering = 'pixelated';
  }

  present(screen: SpectrumScreen, flashPhase = false): void {
    screen.toImageData(this.image.data, flashPhase);
    this.bufferCtx.putImageData(this.image, 0, 0);

    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.buffer, 0, 0, this.canvas.width, this.canvas.height);
  }
}
