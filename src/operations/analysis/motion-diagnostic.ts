// Author-track motion diagnostic (pure, no I/O).
//
// This is the one evidence-based motion / composition diagnostic that reports
// FACTS from a *declared author track* and leaves interpretation to the caller:
// it samples the SAME `at(frame)`-style sampler an authored Source already uses,
// projects the tracked subject to output pixels, and derives deterministic
// per-frame facts — position, velocity, out-of-bounds frames, exact-zero holds
// and event frame-deltas.
//
// What this module deliberately does NOT do:
//  - It emits no thresholds, no "static ratio", no score and no verdict field.
//    Deciding whether a speed is "too fast" or a hold is "too long" is the
//    caller's job; the numbers here are the evidence it reasons over.
//  - It is *declared author evidence*, not observed visibility. A declared
//    subject position can still be occluded, cropped, or simply not drawn — that
//    requires watching the actual pixels. This module never claims a subject was
//    really visible, well-composed, or pleasing.
//
// Projection follows the canvas `setTransform` convention: `focus` maps to the viewport centre, `zoom`
// multiplies the view fit scale, `roll` rotates clockwise, and output pixels are
// y-down. The math is implemented in-module because the Runtime must not import
// an author fixture; there is no second camera authority.
//
// Units: everything is per-frame (no fps needed). `subject`/`focus` are world
// units; positions/velocities are output pixels and pixels-per-frame.

export interface AuthorMotionInput {
  /** Total frames; samples integer frames 0..frames-1. */
  frames: number;
  view: { outWidth: number; outHeight: number; worldWidth: number; worldHeight: number; fit?: 'contain' | 'cover' };
  sample: (frame: number) => {
    /** Tracked subject position in world units. */
    subject: [number, number];
    camera: { focus: [number, number]; zoom: number; roll?: number };
  };
  /** Screen-space rect; default = the whole viewport [0, 0, outWidth, outHeight]. */
  bounds?: { x: number; y: number; width: number; height: number };
  /** Inclusive placement intervals; velocity is computed WITHIN a segment only, never across a boundary. */
  segments?: { from: number; to: number }[];
  /** Declared story-time event frames. */
  events?: number[];
}

export interface AuthorMotionReport {
  /** No fps is needed: every fact is per-frame. */
  fpsNote?: never;
  /** Subject projected to output px (canvas y-down). */
  positions: { frame: number; x: number; y: number }[];
  /** Per-frame delta in px/frame; the first frame of each segment has no predecessor. */
  velocities: { frame: number; dx: number; dy: number; speed: number }[];
  /** Over frames that have a velocity (0 when no frame does). */
  maxSpeed: number;
  minSpeed: number;
  maxSpeedFrames: number[];
  minSpeedFrames: number[];
  /** Projected subject outside `bounds`. */
  outOfBoundsFrames: number[];
  /** Maximal runs (length >= 2) of exactly-zero speed — a reported fact, NOT a defect. */
  holds: { from: number; to: number }[];
  /** Distance from each declared event to the nearest sampled frame. */
  eventDeltas: { event: number; nearestFrame: number; frames: number }[];
}

interface Point {
  x: number;
  y: number;
}

interface Camera {
  focus: [number, number];
  zoom: number;
  roll: number;
}

interface Segment {
  from: number;
  to: number;
}

function fail(label: string, detail: string): never {
  throw new Error(`motion-diagnostic: ${label} ${detail}`);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(label, 'must be a finite number');
  return value as number;
}

function pair(value: unknown, label: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) fail(label, 'must be [x, y]');
  return [finite(value[0], `${label}[0]`), finite(value[1], `${label}[1]`)];
}

/** The two endpoint-validating checks shared by every sampled camera state. */
function normalizeCamera(raw: unknown): Camera {
  if (!raw || typeof raw !== 'object') fail('sample().camera', 'must be an object');
  const camera = raw as { focus?: unknown; zoom?: unknown; roll?: unknown };
  const focus = pair(camera.focus, 'sample().camera.focus');
  const zoom = finite(camera.zoom, 'sample().camera.zoom');
  if (zoom <= 0) fail('sample().camera.zoom', 'must be > 0');
  const roll = camera.roll === undefined ? 0 : finite(camera.roll, 'sample().camera.roll');
  return { focus, zoom, roll };
}

function normalizeSegments(raw: AuthorMotionInput['segments'], frames: number): Segment[] {
  if (raw === undefined) return [{ from: 0, to: frames - 1 }];
  if (!Array.isArray(raw) || raw.length === 0) fail('segments', 'must be a non-empty array when provided');
  const segments = raw.map((segment, index) => {
    if (!segment || typeof segment !== 'object') fail(`segments[${index}]`, 'must be an object');
    const from = segment.from;
    const to = segment.to;
    if (!Number.isInteger(from) || from < 0 || from > frames - 1)
      fail(`segments[${index}].from`, `must be an integer in [0, ${frames - 1}]`);
    if (!Number.isInteger(to) || to < from || to > frames - 1)
      fail(`segments[${index}].to`, `must be an integer in [${from}, ${frames - 1}]`);
    return { from, to };
  });
  // Ordered, non-overlapping segments keep velocity grouping deterministic.
  segments.sort((a, b) => a.from - b.from);
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].from <= segments[i - 1].to)
      fail(
        'segments',
        `overlap between [${segments[i - 1].from}, ${segments[i - 1].to}] and [${segments[i].from}, ${segments[i].to}]`,
      );
  }
  return segments;
}

/** Project a world point to output pixels, replicating `applyCamera`/`worldToScreen`. */
function project(view: AuthorMotionInput['view'], camera: Camera, world: Point, fitScale: number): Point {
  const scale = fitScale * camera.zoom;
  const cos = Math.cos(camera.roll);
  const sin = Math.sin(camera.roll);
  const a = scale * cos;
  const b = scale * sin;
  const c = -scale * sin;
  const d = scale * cos;
  const e = view.outWidth / 2 - (a * camera.focus[0] + c * camera.focus[1]);
  const f = view.outHeight / 2 - (b * camera.focus[0] + d * camera.focus[1]);
  return { x: a * world.x + c * world.y + e, y: b * world.x + d * world.y + f };
}

/**
 * Sample a declared author track and derive deterministic motion facts.
 * Pure: no I/O, no network, no clock, no pixels. Throws a clear Error on
 * malformed input; never returns NaN.
 */
export function analyzeAuthorMotion(input: AuthorMotionInput): AuthorMotionReport {
  if (!input || typeof input !== 'object') fail('input', 'must be an object');
  const frames = input.frames;
  if (!Number.isInteger(frames) || frames < 1) fail('frames', 'must be an integer >= 1');
  if (typeof input.sample !== 'function') fail('sample', 'must be a function');

  const rawView = input.view as AuthorMotionInput['view'] | undefined;
  if (!rawView || typeof rawView !== 'object') fail('view', 'must be an object');
  const outWidth = finite(rawView.outWidth, 'view.outWidth');
  const outHeight = finite(rawView.outHeight, 'view.outHeight');
  const worldWidth = finite(rawView.worldWidth, 'view.worldWidth');
  const worldHeight = finite(rawView.worldHeight, 'view.worldHeight');
  if (outWidth <= 0 || outHeight <= 0 || worldWidth <= 0 || worldHeight <= 0) fail('view dimensions', 'must be > 0');
  const fit = rawView.fit ?? 'cover';
  if (fit !== 'contain' && fit !== 'cover') fail('view.fit', 'must be "contain" or "cover"');
  const view = { outWidth, outHeight, worldWidth, worldHeight, fit } as const;
  const sx = outWidth / worldWidth;
  const sy = outHeight / worldHeight;
  const fitScale = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);

  const bounds = input.bounds ?? { x: 0, y: 0, width: outWidth, height: outHeight };
  const bx = finite(bounds.x, 'bounds.x');
  const by = finite(bounds.y, 'bounds.y');
  const bw = finite(bounds.width, 'bounds.width');
  const bh = finite(bounds.height, 'bounds.height');
  if (bw < 0 || bh < 0) fail('bounds', 'width and height must be >= 0');

  const segments = normalizeSegments(input.segments, frames);

  // Sample every frame once; positions cover the whole 0..frames-1 range.
  const positions: { frame: number; x: number; y: number }[] = new Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const sampled = input.sample(frame);
    if (!sampled || typeof sampled !== 'object') fail(`sample(${frame})`, 'must return an object');
    const subject = pair(sampled.subject, `sample(${frame}).subject`);
    const camera = normalizeCamera(sampled.camera);
    const point = project(view, camera, { x: subject[0], y: subject[1] }, fitScale);
    positions[frame] = { frame, x: point.x, y: point.y };
  }

  // Velocity within each segment only: a boundary between placements never
  // produces a delta, so an honest hard cut is not reported as a teleport.
  const velocities: { frame: number; dx: number; dy: number; speed: number }[] = [];
  for (const segment of segments) {
    for (let frame = segment.from + 1; frame <= segment.to; frame++) {
      const dx = positions[frame].x - positions[frame - 1].x;
      const dy = positions[frame].y - positions[frame - 1].y;
      velocities.push({ frame, dx, dy, speed: Math.hypot(dx, dy) });
    }
  }

  const maxSpeedFrames: number[] = [];
  const minSpeedFrames: number[] = [];
  let maxSpeed = 0;
  let minSpeed = 0;
  for (let i = 0; i < velocities.length; i++) {
    const speed = velocities[i].speed;
    if (i === 0 || speed > maxSpeed) {
      maxSpeed = speed;
      maxSpeedFrames.length = 0;
      maxSpeedFrames.push(velocities[i].frame);
    } else if (speed === maxSpeed) {
      maxSpeedFrames.push(velocities[i].frame);
    }
    if (i === 0 || speed < minSpeed) {
      minSpeed = speed;
      minSpeedFrames.length = 0;
      minSpeedFrames.push(velocities[i].frame);
    } else if (speed === minSpeed) {
      minSpeedFrames.push(velocities[i].frame);
    }
  }

  const outOfBoundsFrames: number[] = [];
  for (const position of positions) {
    if (position.x < bx || position.x > bx + bw || position.y < by || position.y > by + bh)
      outOfBoundsFrames.push(position.frame);
  }

  // Maximal runs of exactly-zero speed. Only frames with a velocity participate
  // (each segment's first frame has none), and a run must be >= 2 frames long.
  const holds: { from: number; to: number }[] = [];
  let holdStart: number | undefined;
  let holdEnd: number | undefined;
  for (const velocity of velocities) {
    const continues = holdEnd !== undefined && velocity.frame === holdEnd + 1;
    if (velocity.speed === 0) {
      if (holdStart === undefined || !continues) {
        if (holdStart !== undefined && holdEnd !== undefined && holdEnd - holdStart + 1 >= 2)
          holds.push({ from: holdStart, to: holdEnd });
        holdStart = velocity.frame;
      }
      holdEnd = velocity.frame;
    } else {
      if (holdStart !== undefined && holdEnd !== undefined && holdEnd - holdStart + 1 >= 2)
        holds.push({ from: holdStart, to: holdEnd });
      holdStart = undefined;
      holdEnd = undefined;
    }
  }
  if (holdStart !== undefined && holdEnd !== undefined && holdEnd - holdStart + 1 >= 2)
    holds.push({ from: holdStart, to: holdEnd });

  const events = input.events ?? [];
  if (!Array.isArray(events)) fail('events', 'must be an array');
  const eventDeltas = events.map((event, index) => {
    const value = finite(event, `events[${index}]`);
    const nearestFrame = Math.min(frames - 1, Math.max(0, Math.round(value)));
    return { event: value, nearestFrame, frames: Math.abs(value - nearestFrame) };
  });

  return {
    positions,
    velocities,
    maxSpeed,
    minSpeed,
    maxSpeedFrames,
    minSpeedFrames,
    outOfBoundsFrames,
    holds,
    eventDeltas,
  };
}
