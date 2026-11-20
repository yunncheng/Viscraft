import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const study = resolve('skills/viscraft/assets/studies/code-visuals/risograph');

interface RenderOptions {
  sampleRate: number;
  channels: number;
  frames: number;
  params: { variant: string; duration: number };
  seed: number;
}

type Render = (options: RenderOptions) => {
  channels: Float32Array[];
  report: { peak: number; rms?: number };
};

test('risograph music and Foley report the peak of the audio they render', async () => {
  const { renderMusic } = (await import(pathToFileURL(resolve(study, 'score.mjs')).href)) as { renderMusic: Render };
  const { renderFoley } = (await import(pathToFileURL(resolve(study, 'foley.mjs')).href)) as { renderFoley: Render };
  const targetPeak = 10 ** (-3 / 20);
  for (const [variant, sampleRate] of [
    ['riverside', 48000],
    ['bakery', 44100],
  ] as const) {
    for (const render of [renderMusic, renderFoley]) {
      const frames = sampleRate * 4;
      const result = render({ sampleRate, channels: 2, frames, params: { variant, duration: 4 }, seed: 9241 });
      const label = variant + ' ' + render.name;
      assert.equal(result.channels.length, 2, label);
      let peak = 0;
      let sumOfSquares = 0;
      for (const channel of result.channels) {
        assert.equal(channel.length, frames, label);
        for (const sample of channel) {
          peak = Math.max(peak, Math.abs(sample));
          sumOfSquares += sample * sample;
        }
        assert.ok(Math.abs(channel[frames - 1]) < 1e-6, label + ' closes in silence');
      }
      assert.ok(Math.abs(peak - targetPeak) < 1e-6, label + ' peaks at -3 dBFS');
      assert.ok(Math.abs(peak - result.report.peak) < 1e-6, label + ' reports the measured peak');
      if (render === renderMusic) {
        const rms = Math.sqrt(sumOfSquares / (2 * frames));
        assert.ok(Math.abs(rms - result.report.rms!) < 1e-6, label + ' reports the measured RMS');
      }
    }
  }
});
