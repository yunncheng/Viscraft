/**
 * The exported `VISCRAFT.md` describes the actual target and its dependencies.
 * An image-only receiver needs the image build command and browser, without
 * film-only composition commands or an unnecessary FFmpeg requirement.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderFactPage } from '../src/operations/delivery/handoff.js';
import type { BuildRecord } from '../src/core/schema.js';
import { validateProject } from '../src/project/project.js';

const BASE = {
  schemaVersion: 1,
  id: 'fact-page',
  revision: 1,
  title: 'Fact page',
  direction: { intent: 'one still', looks: [{ id: 'plain', description: 'plain' }], transitions: [] },
  assets: [],
  bindings: {},
  sources: [],
};

const IMAGE_ONLY = validateProject({
  ...BASE,
  imageDocuments: [{ id: 'poster', path: 'poster.html', resources: ['poster.css'], revision: 1 }],
  imageTargets: [
    { id: 'print', document: 'poster', width: 1200, height: 1500, scale: 2, format: 'png', background: 'opaque' },
  ],
});

const FILM = validateProject({
  ...BASE,
  sources: [
    {
      id: 'scene',
      kind: 'browser',
      output: 'picture',
      entry: 'scene.html',
      resources: [],
      bindings: [],
      params: {},
      seed: 1,
      frames: 4,
    },
  ],
  composition: {
    output: { width: 320, height: 180, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
    scenes: [{ id: 'scene_main', description: 'one scene' }],
    shots: [{ id: 'shot_a', scene: 'scene_main', look: 'plain', intent: 'a shot', targetFrames: 4 }],
    placements: [
      { id: 'pl_a', shot: 'shot_a', source: 'scene', inFrame: 0, outFrame: 4, startFrame: 0, audio: 'mute' },
    ],
    transitions: [],
    audio: [],
  },
});

function page(project: ReturnType<typeof validateProject>): Promise<string> {
  return renderFactPage({ project, builds: [], activeBuild: null, handoff: [], attribution: false });
}

test('an image-only handoff names the still commands and the real targets', async () => {
  const text = await page(IMAGE_ONLY);
  assert.match(text, /No rendered output is packaged/);
  assert.match(text, /viscraft image \. --target <target>/);
  assert.doesNotMatch(text, /viscraft build \./, 'build would refuse an image-only Project');
  assert.doesNotMatch(text, /- FFmpeg/, 'a still capture needs a Browser, not FFmpeg');
  assert.match(text, /## Image targets/);
  assert.match(text, /\| `print` \| 2400×3000 \| `poster` \|/);
});

test('a film handoff still names plan/build and FFmpeg', async () => {
  const text = await page(FILM);
  assert.match(text, /No current result is packaged/);
  assert.match(text, /viscraft build \./);
  assert.match(text, /- FFmpeg/);
  assert.doesNotMatch(text, /## Image targets/);
  assert.doesNotMatch(text, /viscraft image \./, 'a film with no still targets has no still route');
});

test('a Project holding both a film and stills hands over both routes', async () => {
  // An image-only handoff has this shape; printing only plan/build
  // hid the three still targets the receiver had just been given.
  const hybrid = validateProject({
    ...FILM,
    imageDocuments: [
      { id: 'poster', path: 'poster.html', resources: ['poster.css'], revision: 1 },
      { id: 'social', path: 'social.html', resources: ['social.css'], revision: 2 },
    ],
    imageTargets: [
      { id: 'print', document: 'poster', width: 1200, height: 1500, scale: 2, format: 'png', background: 'opaque' },
      { id: 'social', document: 'social', width: 1080, height: 1080, scale: 1, format: 'png', background: 'opaque' },
    ],
  });
  const text = await page(hybrid);
  assert.match(text, /viscraft build \./);
  assert.match(text, /viscraft image \. --target <target>/);
  assert.match(
    text,
    /viscraft workbench \. --document <document> --target <target>/,
    'two documents cannot be opened without naming one',
  );
  assert.match(text, /- FFmpeg/);
  assert.match(text, /- Browser \(Chrome\/Chromium for still capture\)/);
  assert.match(text, /\| `print` \| 2400×3000 \| `poster` \|/);
});

test('a Project with one document opens the workbench by target alone', async () => {
  const text = await page(IMAGE_ONLY);
  assert.match(text, /viscraft workbench \. --target <target>/);
  assert.doesNotMatch(text, /--document <document>/);
});

test('the fact page labels retained still bytes as packaged, not necessarily current', async () => {
  const build = (id: string, startedAt: string): BuildRecord => ({
    schemaVersion: 1,
    id,
    medium: 'picture',
    run: { id: `run-${id}`, goal: 'render a still' },
    plan: { operations: ['render-image'] },
    revision: 1,
    snapshotHash: 'a'.repeat(64),
    status: 'succeeded',
    startedAt,
    operations: [],
    takes: [],
    target: 'print',
    artifacts: [
      {
        id: `artifact-${id}`,
        path: `.viscraft/artifacts/${id}.png`,
        sha256: 'b'.repeat(64),
        kind: 'image',
        simulated: false,
        operation: 'render-image',
        backend: 'browser',
        inputs: ['poster.html'],
        image: { width: 2400, height: 3000, format: 'png', background: 'opaque' },
      },
    ],
    result: { artifact: `artifact-${id}`, simulated: false },
  });
  const text = await renderFactPage({
    project: IMAGE_ONLY,
    builds: [build('old', '2026-10-17T01:00:00Z'), build('new', '2026-10-17T02:00:00Z')],
    activeBuild: null,
    handoff: [],
    attribution: false,
  });
  assert.match(text, /## Packaged results/);
  assert.match(text, /not necessarily the latest author state/);
  assert.match(text, /Packaged still target `print`.*`new`/);
  assert.doesNotMatch(text, /`old`/);
});
