// Original page-action fractions, shared by picture and material sound.
// These describe this page, not a required timing recipe for other works.
export const PAGE_ACTIONS = Object.freeze({
  drawOutline: Object.freeze([0.06, 0.30]),
  drawFill: Object.freeze([0.32, 0.58]),
  reach: Object.freeze([0.60, 0.68]),
  lift: Object.freeze([0.68, 0.80]),
  wash: Object.freeze([0.76, 0.93]),
  settle: Object.freeze([0.90, 1]),
});

export function pageActionAt(fraction) {
  return Object.fromEntries(Object.entries(PAGE_ACTIONS).map(([id, [start, end]]) => {
    const u = Math.max(0, Math.min(1, (fraction - start) / (end - start)));
    return [id, u * u * (3 - 2 * u)];
  }));
}
