import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  seedance25Model,
  wan30Model,
  runwayGen45Model,
  gen4TurboModel,
  Seedance25ParametersSchema,
} from '../src/index.js';
import { seedance25ArkMapping } from '../src/backends/providers/mappings/seedance-ark.js';
import type { GenerationModel } from '../src/backends/providers/extension.js';
import type { ProviderSource } from '../src/core/schema.js';

/**
 * generation DURATION, CANVAS, RATIO and OUTPUT are four different
 * quantities and must stay distinct:
 *
 *  1. the Source `size` is a real raster canvas `WIDTH:HEIGHT` (never a symbolic
 *     ratio fabricated into `16x9` pixels);
 *  2. a model's own `ratio`/`resolution` parameter is the model-side selector
 *     (symbolic `16:9` for fal Wan/Seedance; dimension-shaped `1280:720` for
 *     Runway, whose ratio string IS its generation resolution);
 *  3. `durationSeconds` is the model-side WIRE request length; `requestedFrames
 *     / fps` is the author's expected take length — a request shorter than the
 *     expected take cannot fill the shot and is refused, while a longer request
 *     is the ordinary margin a cut later trims;
 *  4. the decoded Take and the Composition's normalized output are verified
 *     separately by `fal.e2e.ts` (a real 12-frame provider take normalized onto
 *     the 30 fps output clock with the probe's true duration recorded).
 */

function videoSource(overrides: Partial<ProviderSource> & { model: string }): ProviderSource {
  return {
    id: 'src',
    kind: 'provider',
    output: 'picture',
    endpoint: 'e',
    prompt: 'p',
    mode: 'reference',
    references: [{ asset: 'a', category: 'image', role: 'identity' }],
    requestedFrames: 96,
    fps: 24,
    size: '1280:720',
    attempt: 'a1',
    ...overrides,
  };
}

/** Validate a model against a source and explicit parameters (no deployment settings). */
const check = (model: GenerationModel, source: ProviderSource, parameters: Record<string, unknown>): void => {
  model.validate(source, parameters, {});
};

test('Wan 3.0: the raster canvas is checked against the SYMBOLIC ratio by aspect, not equality', () => {
  const params = { durationSeconds: 5, resolution: '720p', ratio: '16:9', audio: true };
  const firstFrame = { asset: 'a', category: 'image' as const, role: 'first-frame' as const };
  // A real 16:9 canvas and the 16:9 symbolic ratio agree.
  assert.doesNotThrow(() =>
    check(
      wan30Model,
      videoSource({
        model: 'alibaba/wan-3.0/image-to-video',
        mode: 'first-last-frame',
        references: [firstFrame],
        size: '1280:720',
      }),
      params,
    ),
  );
  // A portrait canvas with a landscape ratio is a real conflict, surfaced not dropped.
  assert.throws(
    () =>
      check(
        wan30Model,
        videoSource({
          model: 'alibaba/wan-3.0/image-to-video',
          mode: 'first-last-frame',
          references: [firstFrame],
          size: '720:1280',
        }),
        params,
      ),
    /does not match the requested aspect ratio/,
  );
});

test('Seedance: an ADAPTIVE ratio leaves the canvas unconstrained; a symbolic ratio must match it', () => {
  const params = (ratio: string) => ({ durationSeconds: 4, resolution: '720p', ratio, generateAudio: true });
  // adaptive: the model derives aspect from the input, so any canvas is accepted.
  assert.doesNotThrow(() =>
    check(seedance25Model, videoSource({ model: 'Seedance-2.5', size: '1000:999' }), params('adaptive')),
  );
  // a fixed symbolic ratio and a mismatched canvas is a conflict.
  assert.throws(
    () => check(seedance25Model, videoSource({ model: 'Seedance-2.5', size: '1280:720' }), params('21:9')),
    /does not match the requested ratio/,
  );
});

test('duration: a generation request shorter than the expected take cannot fill the shot', () => {
  const params = { durationSeconds: 4, resolution: '720p', ratio: 'adaptive', generateAudio: true };
  // requestedFrames 240 at 24 fps is a 10 s expected take; a 4 s request is too short.
  assert.throws(
    () => check(seedance25Model, videoSource({ model: 'Seedance-2.5', requestedFrames: 240 }), params),
    /shorter than the expected take length/,
  );
  // A margin request (generation >= expected) is accepted and trimmed by the cut.
  assert.doesNotThrow(() =>
    check(seedance25Model, videoSource({ model: 'Seedance-2.5', requestedFrames: 24 }), params),
  );
});

test('an ADAPTIVE request reaches the wire with ratio "adaptive" and the model-chosen length', () => {
  // The mapping is the service-translation half; call it directly to check the
  // REAL request fields an adaptive Seedance request would send.
  const parameters = Seedance25ParametersSchema.parse({
    durationSeconds: -1,
    resolution: '720p',
    ratio: 'adaptive',
    generateAudio: true,
    task: 'edit',
  });
  const body = seedance25ArkMapping.videoBody!(
    videoSource({ model: 'Seedance-2.5', mode: 'reference', size: '1000:999' }),
    parameters,
    'doubao-seedance-2-5-260628',
    [],
  ) as Record<string, unknown>;
  assert.equal(body.ratio, 'adaptive', 'the model derives the aspect, so no fixed ratio is sent');
  assert.equal(body.duration, -1, 'the model chooses the decoded length');
  assert.equal(body.resolution, '720p');
  assert.equal(body.generate_audio, true);
});

test('Runway: the ratio string IS the generation resolution, so an equal raster is required', () => {
  const params = { durationSeconds: 4, ratio: '1280:720' };
  // Runway gen4.5 text-to-video: ratio 1280:720 means the 1280x720 output.
  assert.doesNotThrow(() =>
    check(runwayGen45Model, videoSource({ model: 'gen4.5', mode: 'text', references: [], size: '1280:720' }), params),
  );
  // A differing raster would be silently discarded by the vendor, so it is refused.
  assert.throws(
    () =>
      check(
        runwayGen45Model,
        videoSource({ model: 'gen4.5', mode: 'text', references: [], size: '1920:1080' }),
        params,
      ),
    /requires source.size to equal the requested ratio/,
  );
  // A request shorter than the expected take is refused here too.
  assert.throws(
    () =>
      check(
        gen4TurboModel,
        videoSource({
          model: 'gen4_turbo',
          mode: 'first-last-frame',
          references: [{ asset: 'a', category: 'image', role: 'first-frame' }],
          size: '1280:720',
          requestedFrames: 240,
        }),
        params,
      ),
    /shorter than the expected take length/,
  );
});
