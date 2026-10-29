/**
 * Pure World sampling state.
 *
 * A `World` is optional, persistent shared-space state:
 * entities that reference Project assets, optional trajectories, cameras, and a
 * fixed frame clock. It is *not* a second renderer and *not* a second asset
 * registry — it only supplies the deterministic spatial truth a renderer samples.
 *
 * This module owns the pure, framework-free half of that contract:
 *
 * - {@link sampleWorld} is a pure function turning `(World, cameraId, frame)` into
 *   a serializable {@link WorldFrame} snapshot: the sampled entity transforms and
 *   the resolved camera at exactly one global World frame. It performs no I/O and
 *   no drawing, so the same world+frame always yields the same snapshot and the
 *   sampled entities never depend on which camera was selected.
 *
 * Because the whole module is pure and imports only *types* from `schema.ts`, its
 * emitted JavaScript has no imports at all: it is safe to load in a browser
 * context (an author page realizing a World) as well as in Node. The
 * browser-backed realization of a `world` source lives in `world.ts`, which
 * builds on this sampler without pulling Node-only dependencies into here.
 *
 * Time: the World clock is the integer frame grid of `world.frames` and
 * `world.fps`. A caller maps its local clip frame `f` to the global World frame
 * `startFrame + f`; the source interval must stay inside the World clock and its
 * output fps must match the World fps, so no frame is re-quantized.
 */
import type { Fps, Vector3, World } from './schema.js';

/** An entity's authored transform (position, rotation in radians, positive scale). */
export type WorldTransform = World['entities'][number]['transform'];

/** One entity resolved at a World frame: sampled transform plus its opaque state. */
export interface WorldEntitySample {
  id: string;
  asset: string;
  transform: WorldTransform;
  state: Record<string, unknown>;
}

/** A camera resolved at a World frame, in World space (follow already applied). */
export interface WorldCameraSample {
  id: string;
  position: Vector3;
  target: Vector3;
  fov: number;
  follow?: string;
}

/**
 * A fully sampled snapshot of one World frame.
 *
 * Identity and clock fields (`id`, `revision`, `frame`, `fps`, `units`,
 * `coordinates`) come straight from the World so a consumer can prove which
 * spatial revision a rendered frame belongs to. `entities` is independent of the
 * selected camera; `camera` is the requested camera after follow resolution.
 */
export interface WorldFrame {
  id: string;
  revision: number;
  frame: number;
  fps: Fps;
  units: 'meters';
  coordinates: 'right-handed-y-up';
  entities: WorldEntitySample[];
  camera: WorldCameraSample;
}

type Keyframe = World['trajectories'][number]['keyframes'][number];
type WorldCamera = World['cameras'][number];
type WorldEntity = World['entities'][number];
type WorldTrajectory = World['trajectories'][number];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function add(a: Vector3, b: Vector3): Vector3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/**
 * Rotate a vector by Euler angles (radians), using the Three.js default `XYZ`
 * order R = Rx·Ry·Rz for a right-handed, y-up frame. Camera follow offsets are
 * expressed in the followed entity's local frame, so this keeps a trailing camera
 * behind a turning entity; renderers that use `THREE.Euler`'s default order agree
 * with this convention.
 */
function rotateEuler(rotation: Vector3, v: Vector3): Vector3 {
  const [x, y, z] = rotation;
  const cx = Math.cos(x);
  const sx = Math.sin(x);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cz = Math.cos(z);
  const sz = Math.sin(z);
  const [vx, vy, vz] = v;
  return [
    cy * cz * vx - cy * sz * vy + sy * vz,
    (cx * sz + sx * sy * cz) * vx + (cx * cz - sx * sy * sz) * vy - sx * cy * vz,
    (sx * sz - cx * sy * cz) * vx + (sx * cz + cx * sy * sz) * vy + cx * cy * vz,
  ];
}

/**
 * Pick the 2*PI representative of `angle` nearest to `reference`, so a yaw track
 * that crosses the +-PI seam stays continuous instead of jumping by a full turn.
 */
function unwrapNear(angle: number, reference: number): number {
  const twoPi = Math.PI * 2;
  return angle + twoPi * Math.round((reference - angle) / twoPi);
}

type CrPoint = { position: Vector3; tangent: Vector3 };

function samePoint(a: Vector3, b: Vector3): boolean {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(a[2] - b[2]) < 1e-9;
}

/**
 * Evaluate a Catmull-Rom segment in authored frame time. Each interior key has
 * one shared velocity, (next position - previous position) / (next frame -
 * previous frame). Scaling that velocity by the current segment duration gives
 * its Hermite tangent. Unequal keyframe intervals therefore retain C1 position
 * continuity in time, rather than only in an artificial control-point index.
 * Open endpoint neighbours repeat position with mirrored time intervals. Closed
 * paths repeat the first position at the final key and wrap neighbour times by
 * the loop duration. The returned tangent is position change per World frame.
 */
function catmullRom(keys: Keyframe[], closed: boolean, u: number): CrPoint {
  const last = keys.length - 1;
  if (last === 0) return { position: keys[0].position, tangent: [0, 0, 0] };
  if (closed && (last < 2 || !samePoint(keys[0].position, keys[last].position))) {
    throw new Error(
      'sampleWorld: a closed spline needs at least three keys and a repeated first position at the final key',
    );
  }
  const clamped = Math.min(Math.max(u, 0), last);
  const i = Math.min(Math.floor(clamped), last - 1);
  const t = clamped - i;
  const duration = keys[i + 1].frame - keys[i].frame;
  const period = keys[last].frame - keys[0].frame;
  const at = (index: number): Keyframe => {
    if (index >= 0 && index <= last) return keys[index];
    if (closed) {
      const key = index < 0 ? keys[last - 1] : keys[1];
      return { ...key, frame: key.frame + (index < 0 ? -period : period) };
    }
    return index < 0
      ? { ...keys[0], frame: 2 * keys[0].frame - keys[1].frame }
      : { ...keys[last], frame: 2 * keys[last].frame - keys[last - 1].frame };
  };
  const k0 = at(i - 1),
    k1 = at(i),
    k2 = at(i + 1),
    k3 = at(i + 2);
  const position: Vector3 = [0, 0, 0];
  const tangent: Vector3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const p = k1.position[c],
      q = k2.position[c];
    const m = ((q - k0.position[c]) / (k2.frame - k0.frame)) * duration;
    const n = ((k3.position[c] - p) / (k3.frame - k1.frame)) * duration;
    position[c] =
      (2 * t ** 3 - 3 * t ** 2 + 1) * p +
      (t ** 3 - 2 * t ** 2 + t) * m +
      (-2 * t ** 3 + 3 * t ** 2) * q +
      (t ** 3 - t ** 2) * n;
    tangent[c] =
      ((6 * t ** 2 - 6 * t) * p + (3 * t ** 2 - 4 * t + 1) * m + (-6 * t ** 2 + 6 * t) * q + (3 * t ** 2 - 2 * t) * n) /
      duration;
  }
  return { position, tangent };
}

/**
 * Map a dense keyframe parameter `u` back to the frame-space time mapping.
 *
 * The time mapping is piecewise-linear: `u = i + (frame - f_i)/(f_{i+1} - f_i)`.
 * That keeps the source local frame clock authoritative while the *space* path
 * is smooth.
 */
function frameToPathParam(keys: Keyframe[], frame: number): number {
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (frame <= first.frame) return 0;
  if (frame >= last.frame) return keys.length - 1;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (frame >= a.frame && frame <= b.frame) {
      return i + (frame - a.frame) / (b.frame - a.frame);
    }
  }
  return keys.length - 1;
}

/**
 * The unwrapped yaw track at each keyframe, derived from the *path tangent*.
 *
 * Sequential `unwrapNear` makes the track continuous across the +-PI seam and
 * across a loop closure, so interpolating it never introduces a full-turn jump.
 */
function tangentYawTrack(keys: Keyframe[], closed: boolean): number[] {
  const track: number[] = [];
  for (let i = 0; i < keys.length; i++) {
    const { tangent } = catmullRom(keys, closed, i);
    const raw = Math.atan2(tangent[0], tangent[2]);
    track.push(i === 0 ? raw : unwrapNear(raw, track[i - 1]));
  }
  return track;
}

/**
 * Sample one entity's transform at `frame`.
 *
 * Position is linearly interpolated between the bracketing keyframes and held
 * outside the keyframe range. Rotation is optional per keyframe: a keyframe
 * without an explicit rotation falls back to the entity's base rotation, and the
 * effective rotations of the bracketing keyframes are interpolated component-wise
 * (the values are radians, treated as a linear vector). Scale always comes from
 * the entity's base transform.
 *
 * When
 * `trajectory.heading === 'tangent'` (optionally with `path: 'catmull-rom'`),
 * position comes from the path and yaw comes from the path tangent, with roll
 * and pitch still interpolated from the effective keyframe rotations. With the
 * fields absent the path is piecewise linear with authored Euler rotation.
 */
function sampleTrajectory(
  entity: WorldEntity,
  trajectory: WorldTrajectory,
  frame: number,
): { position: Vector3; rotation: Vector3 } {
  const baseRotation = entity.transform.rotation;
  const keys = trajectory.keyframes;
  const first = keys[0];
  const last = keys[keys.length - 1];
  const effectiveRotation = (key: Keyframe): Vector3 => key.rotation ?? baseRotation;
  const tangentHeading = trajectory.heading === 'tangent' && keys.length >= 2;
  const splinePath = trajectory.path === 'catmull-rom' && keys.length >= 2;

  if (!tangentHeading && !splinePath) {
    if (frame <= first.frame) return { position: first.position, rotation: effectiveRotation(first) };
    if (frame >= last.frame) return { position: last.position, rotation: effectiveRotation(last) };
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i];
      const b = keys[i + 1];
      if (frame >= a.frame && frame <= b.frame) {
        const t = (frame - a.frame) / (b.frame - a.frame);
        const ra = effectiveRotation(a);
        const rb = effectiveRotation(b);
        return {
          position: [
            lerp(a.position[0], b.position[0], t),
            lerp(a.position[1], b.position[1], t),
            lerp(a.position[2], b.position[2], t),
          ],
          rotation: [lerp(ra[0], rb[0], t), lerp(ra[1], rb[1], t), lerp(ra[2], rb[2], t)],
        };
      }
    }
    return { position: last.position, rotation: effectiveRotation(last) };
  }

  const clampedFrame = Math.min(Math.max(frame, first.frame), last.frame);
  const closed = trajectory.closed === true;

  // Rotation roll/pitch follow the existing effective-rotation interpolation.
  const segment = (() => {
    if (clampedFrame <= first.frame) return { index: 0, t: 0 };
    if (clampedFrame >= last.frame) return { index: keys.length - 2, t: 1 };
    for (let i = 0; i < keys.length - 1; i++) {
      if (clampedFrame >= keys[i].frame && clampedFrame <= keys[i + 1].frame) {
        return { index: i, t: (clampedFrame - keys[i].frame) / (keys[i + 1].frame - keys[i].frame) };
      }
    }
    return { index: keys.length - 2, t: 1 };
  })();
  const ra = effectiveRotation(keys[segment.index]);
  const rb = effectiveRotation(keys[segment.index + 1]);
  const roll = lerp(ra[0], rb[0], segment.t);
  const pitch = lerp(ra[2], rb[2], segment.t);

  let position: Vector3;
  let yaw: number;
  if (tangentHeading) {
    const u = frameToPathParam(keys, clampedFrame);
    if (splinePath) {
      const point = catmullRom(keys, closed, u);
      position = point.position;
      const rawYaw = Math.atan2(point.tangent[0], point.tangent[2]);
      const track = tangentYawTrack(keys, closed);
      const refYaw = lerp(track[segment.index], track[segment.index + 1], segment.t);
      yaw = unwrapNear(rawYaw, refYaw);
    } else {
      // Tangent heading on a piecewise-linear path: the tangent is the current
      // segment direction; corners deliberately retain a heading discontinuity.
      position = [
        lerp(keys[segment.index].position[0], keys[segment.index + 1].position[0], segment.t),
        lerp(keys[segment.index].position[1], keys[segment.index + 1].position[1], segment.t),
        lerp(keys[segment.index].position[2], keys[segment.index + 1].position[2], segment.t),
      ];
      const a = keys[segment.index].position;
      const b = keys[segment.index + 1].position;
      const dx = b[0] - a[0];
      const dz = b[2] - a[2];
      yaw = dx * dx + dz * dz > 1e-18 ? Math.atan2(dx, dz) : effectiveRotation(keys[segment.index])[1];
    }
  } else {
    // Spline position without tangent heading: keep the authored yaw channel.
    position = catmullRom(keys, closed, frameToPathParam(keys, clampedFrame)).position;
    yaw = lerp(ra[1], rb[1], segment.t);
  }

  return { position, rotation: [roll, yaw, pitch] };
}

/**
 * Resolve a camera at a sampled frame.
 *
 * A plain camera is returned as authored in World space. A camera with `follow`
 * treats its authored `position` and `target` as offsets in the followed entity's
 * local frame: each offset is rotated by that entity's sampled rotation and added
 * to its sampled position. The entity's scale is not applied to camera offsets.
 */
function resolveCamera(camera: WorldCamera, entities: Map<string, WorldEntitySample>): WorldCameraSample {
  if (!camera.follow) {
    return { id: camera.id, position: camera.position, target: camera.target, fov: camera.fov };
  }
  const followed = entities.get(camera.follow);
  if (!followed) throw new Error(`sampleWorld: camera "${camera.id}" follows missing entity "${camera.follow}"`);
  const { position, rotation } = followed.transform;
  return {
    id: camera.id,
    position: add(position, rotateEuler(rotation, camera.position)),
    target: add(position, rotateEuler(rotation, camera.target)),
    fov: camera.fov,
    follow: camera.follow,
  };
}

/**
 * Sample a World at exactly one global frame for a given camera.
 *
 * Pure and deterministic: the same `(world, cameraId, frame)` always produces the
 * same snapshot, and the sampled entities are identical for every camera. Throws
 * when `frame` is not an in-bounds integer of the World clock or the camera does
 * not exist, so a bad request can never silently render the wrong frame.
 */
export function sampleWorld(world: World, cameraId: string, frame: number): WorldFrame {
  if (!Number.isInteger(frame) || frame < 0 || frame >= world.frames) {
    throw new Error(`sampleWorld: frame ${frame} is outside World "${world.id}" clock [0, ${world.frames})`);
  }
  const camera = world.cameras.find(candidate => candidate.id === cameraId);
  if (!camera) throw new Error(`sampleWorld: World "${world.id}" has no camera "${cameraId}"`);

  const trajectories = new Map(world.trajectories.map(trajectory => [trajectory.entity, trajectory]));
  const entities: WorldEntitySample[] = world.entities.map(entity => {
    const trajectory = trajectories.get(entity.id);
    const sampled = trajectory
      ? sampleTrajectory(entity, trajectory, frame)
      : { position: entity.transform.position, rotation: entity.transform.rotation };
    return {
      id: entity.id,
      asset: entity.asset,
      transform: { position: sampled.position, rotation: sampled.rotation, scale: entity.transform.scale },
      state: entity.state,
    };
  });

  const byId = new Map(entities.map(entity => [entity.id, entity]));
  return {
    id: world.id,
    revision: world.revision,
    frame,
    fps: world.fps,
    units: world.units,
    coordinates: world.coordinates,
    entities,
    camera: resolveCamera(camera, byId),
  };
}
