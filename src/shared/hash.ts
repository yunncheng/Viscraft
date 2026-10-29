import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Deterministic key order: code-unit (`<`/`>`) comparison, NOT `localeCompare`.
 * `localeCompare` depends on the process locale (e.g. `LANG=sv_SE` reorders
 * `ä`/`z`), so the same object would hash differently under different locales.
 * A code-unit order is a total order independent of the environment, so the
 * digest is a function of the value alone.
 */
function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function stableHash(value: unknown): string {
  const normalize = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => codeUnitCompare(a, b))
              .map(([k, val]) => [k, normalize(val)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(normalize(value)))
    .digest('hex');
}
export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
