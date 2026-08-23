/**
 * Enforces BUILD_PROMPT.md §3: "Layer 2: src/ ... Contains zero literal game
 * data -- a lint rule or a test should enforce that no magic tables appear in
 * src/."
 *
 * The rule this guards is the one the brief calls non-negotiable: every byte
 * must come out of the disassembly via the extractor. Hand-transcription is the
 * failure mode that would quietly invalidate the whole project, and it is
 * invisible in review once it exists -- a plausible-looking table of numbers
 * reads the same whether it was parsed or typed.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** A numeric array literal of this length or more counts as a data table. */
const MAX_ARRAY_LITERAL = 8;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Strip comments and strings so their contents never trip the scan. */
function stripNonCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('src/ contains no literal game data', () => {
  const files = sourceFiles(SRC);

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [f.slice(SRC.length + 1), f]))(
    'no long numeric array literal in %s',
    (_rel, path) => {
      const code = stripNonCode(readFileSync(path, 'utf8'));

      // Any bracketed run of >= MAX_ARRAY_LITERAL comma-separated numbers.
      const arrays = code.matchAll(/\[\s*((?:-?(?:0[xXbB])?[\da-fA-F_]+\s*,\s*){7,}[^\]]*)\]/g);
      const offenders: string[] = [];
      for (const m of arrays) {
        const items = m[1]!.split(',').filter((s) => s.trim().length > 0);
        if (items.length >= MAX_ARRAY_LITERAL) {
          offenders.push(`${items.length} entries: ${m[0]!.slice(0, 72)}...`);
        }
      }

      expect(
        offenders,
        `Literal data table found. Game data must come from data/*.json via the ` +
          `extractor, never typed into src/. See BUILD_PROMPT.md §3.`,
      ).toEqual([]);
    },
  );

  it('rejects a planted table, proving the check actually bites', () => {
    const planted = 'const map = [0x2D, 0x8B, 0xCC, 1, 2, 3, 4, 5, 6, 7];';
    const arrays = [
      ...stripNonCode(planted).matchAll(
        /\[\s*((?:-?(?:0[xXbB])?[\da-fA-F_]+\s*,\s*){7,}[^\]]*)\]/g,
      ),
    ];
    expect(arrays.length).toBe(1);
  });

  it('ignores numbers that appear only in comments', () => {
    const commented = '// bank table: [0, 145, 365, 1, 2, 3, 4, 5, 6, 7, 8]\nconst x = 1;';
    const arrays = [
      ...stripNonCode(commented).matchAll(
        /\[\s*((?:-?(?:0[xXbB])?[\da-fA-F_]+\s*,\s*){7,}[^\]]*)\]/g,
      ),
    ];
    expect(arrays.length).toBe(0);
  });
});
