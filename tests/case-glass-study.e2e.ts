/**
 * E2E: the `glass-study` example — author a DIFFERENT product out of the reusable
 * `glass-product` Look, with real photography evidence.
 *
 * Proves, with the REAL browser capture path:
 *  - the study's own plan is pure and correct: the case is re-proportioned, the
 *    module's beats are read per frame, the detail shot sits entirely inside the
 *    module's `explode` beat and straddles its snap/ignition, and the hero shot
 *    sits inside `hero`;
 *  - `create.mjs` vendors the reusable module (its `.mjs` AND its own entry page)
 *    plus the pinned `three@0.186.1` closure BYTE-FOR-BYTE, registers every file
 *    as a `code` Asset with real sha256 and MIT rights, authors TWO picture
 *    Sources over one entry, writes no absolute host path and submits no provider
 *    request;
 *  - a real `buildProject` produces real, non-blank frames whose per-frame beats
 *    and adjacent motion match the plan; the study's detail shot differs from the
 *    UNMODIFIED module at the same module time (measured per-pixel), and its hero
 *    shot shows the re-proportioned case + amber guide;
 *  - editing ONE authored proportion (`caseRz`) re-renders exactly that Source,
 *    REUSES the untouched Source's Take and the unchanged sound mix, and the new
 *    frames are measurably different.
 *
 * Deterministic (fixed seeds/frames, no wall clock/network). The build runs at a
 * small size and a handful of frames to stay fast; the example itself defaults to
 * 640×360 / 24 frames per shot.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { openCodeScene } from '../src/backends/browser/capture.js';
import { buildProject } from '../src/build/build.js';
import { loadProject, saveProject } from '../src/project/project.js';
import { authorRecipe, type AuthorSummary } from './authoring-helpers.js';

// The fixture owns its study files; the module and pin table live in the glass-product study.
const EX_DIR = resolve('tests/fixtures/authoring/glass-study');
const MODULE_DIR = resolve('skills/viscraft/assets/studies/code-visuals/glass-product');
const SKILL_MODULE_DIR = MODULE_DIR;
const ENTRY = 'glass-study-scene.html';
const SCENE_MJS = 'glass-study.mjs';
const MODULE_MJS = 'glass-product.mjs';
const MODULE_HTML = 'glass-product-scene.html';
// Read the pinned closure from the SAME declaration the fixture uses.
const { THREE_GLASS_PRODUCT } = (await import(pathToFileURL(join(MODULE_DIR, 'three-files.mjs')).href)) as {
  THREE_GLASS_PRODUCT: Array<{ source: string; dest: string; sha256: string }>;
};
const THREE_PINS: Record<string, string> = Object.fromEntries(
  THREE_GLASS_PRODUCT.filter(
    pin =>
      pin.dest === 'vendor/three.module.js' || pin.dest === 'vendor/three.core.js' || pin.dest === 'vendor/LICENSE',
  ).map(pin => [pin.dest, pin.sha256]),
);

const WIDTH = 160;
const HEIGHT = 90;
const FRAMES = 8;
const FPS = 24;
const FRAME_BYTES = WIDTH * HEIGHT * 3;

interface BaseModule {
  CASE: { rx: number; rz: number; hb: number; hl: number };
  BUD_CRADLES: Array<{ x: number; y: number; z: number }>;
  BUD_PARTS: unknown[];
  FLOOR_Y: number;
}

interface Study {
  product: string;
  shot: string;
  duration: number;
  accentA: string;
  accentB: string;
  caseRx: number;
  caseRz: number;
  caseHl: number;
  exposureFrom: number;
  exposureTo: number;
  bloom: number;
  pulse: number;
  explode: number;
}

interface Plan {
  study: Study;
  progress: number;
  x: number;
  exposure: number;
  moduleFrame: number;
  beat: string;
  params: Record<string, unknown>;
}

interface StudyModule {
  PRODUCT: string;
  CASE_VARIANT: { rx: number; rz: number; hb: number; hl: number };
  IGNITION_X: number;
  MODULE_CLOCK: number;
  SHOTS: Record<'detail' | 'hero', { baseFrom: number; baseTo: number }>;
  normalizeStudy(raw?: unknown): Study;
  variantKey(study: Study): string;
  studyProgress(study: Study, frame: number, fps: number): number;
  planFrame(raw: Record<string, unknown>, frame: number, fps: number): Plan;
  applyVariant(study: Study): void;
}

let staged: { study: StudyModule; base: BaseModule } | undefined;

/**
 * The example imports the vendored module as a sibling; stage the two files the way
 * `create.mjs` vendors them into a Project, then import BOTH from the same directory so
 * they share one module instance (the study mutates the module's exported config).
 */
async function stageModules(): Promise<{ study: StudyModule; base: BaseModule }> {
  if (staged) return staged;
  const directory = await mkdtemp(join(tmpdir(), 'viscraft-glass-study-module-'));
  try {
    await copyFile(join(EX_DIR, SCENE_MJS), join(directory, SCENE_MJS));
    await copyFile(join(MODULE_DIR, MODULE_MJS), join(directory, MODULE_MJS));
    staged = {
      study: (await import(pathToFileURL(join(directory, SCENE_MJS)).href)) as StudyModule,
      base: (await import(pathToFileURL(join(directory, MODULE_MJS)).href)) as BaseModule,
    };
    return staged;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Decode a real frame / frame sequence to raw RGB via ffmpeg. */
function decode(file: string, frames?: number): Buffer {
  const args = ['-hide_banner', '-nostdin', '-i', file];
  if (frames !== undefined) args.push('-frames:v', String(frames));
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  const result = spawnSync('ffmpeg', args, { maxBuffer: 1 << 27 });
  assert.equal(result.status, 0, `ffmpeg decode failed for ${file}: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

function frameAt(pixels: Buffer, index: number): Buffer {
  return pixels.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES);
}

/** Fraction of pixels whose RGB distance exceeds `threshold` (a loud, non-compression change). */
function changedFraction(a: Buffer, b: Buffer, threshold = 60): number {
  assert.equal(a.length, b.length, 'frames being compared must have the same size');
  let changed = 0;
  for (let i = 0; i < a.length; i += 3) {
    const distance = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (distance > threshold) changed++;
  }
  return changed / (a.length / 3);
}

/** Fraction of pixels clearly off the black studio backdrop. */
function litFraction(pixels: Buffer): number {
  let lit = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    if (pixels[i] > 12 || pixels[i + 1] > 12 || pixels[i + 2] > 12) lit++;
  }
  return lit / (pixels.length / 3);
}

function brightest(pixels: Buffer): number {
  let max = 0;
  for (const value of pixels) if (value > max) max = value;
  return max;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function authorStudy(root: string, options: Record<string, unknown> = {}): Promise<AuthorSummary> {
  const result = await authorRecipe({
    recipe: join(EX_DIR, 'create.mjs'),
    root,
    cwd: resolve(root, '..'),
    options: { width: WIDTH, height: HEIGHT, frames: FRAMES, ...options },
  });
  return result.summary;
}

// ---------------------------------------------------------------------------
// The study's own plan: proportions, beats, ignition, determinism.
// ---------------------------------------------------------------------------
test('the study re-proportions the case and maps its shots onto real module beats', async () => {
  const { study: mod, base: gp } = await stageModules();

  assert.equal(mod.PRODUCT, 'AURELIS');
  assert.deepEqual(mod.CASE_VARIANT, { rx: 30, rz: 35, hb: 15, hl: 11 });
  assert.equal(mod.MODULE_CLOCK, 4, 'the study drives the module on its intrinsic 4 s beat clock');
  // The module's own snap: 0.78 into its 0.64–0.88 explode beat.
  assert.ok(Math.abs(mod.IGNITION_X - (0.64 + 0.78 * 0.24)) < 1e-9);

  // Validation is strict and loud (the params reach real geometry/materials).
  const defaults = mod.normalizeStudy({});
  assert.equal(defaults.shot, 'detail');
  assert.equal(defaults.duration, 1);
  assert.equal(defaults.explode, 0, 'the detail shot keeps the product whole');
  assert.throws(() => mod.normalizeStudy({ shot: 'macro' }), /shot must be one of/);
  assert.throws(() => mod.normalizeStudy({ accentA: 'red' }), /accentA/);
  assert.throws(() => mod.normalizeStudy({ caseRx: 2 }), /caseRx/);
  assert.throws(() => mod.normalizeStudy({ exposureTo: -1 }), /exposureTo/);
  assert.throws(() => mod.normalizeStudy(null), /study params must be an object/);
  assert.throws(() => mod.planFrame({ study: { duration: 0 } }, 0, FPS), /duration/);

  // The variant key is the rebuild trigger: proportions and palette each re-key it.
  const base = mod.normalizeStudy({ shot: 'detail', duration: FRAMES / FPS });
  assert.notEqual(mod.variantKey({ ...base, caseRz: 41 }), mod.variantKey(base));
  assert.notEqual(mod.variantKey({ ...base, accentA: '#7fd8ff' }), mod.variantKey(base));
  assert.equal(
    mod.variantKey({ ...base, exposureTo: 0.5 }),
    mod.variantKey(base),
    'lighting does not rebuild geometry',
  );

  // Keyframes: the detail shot lives inside `explode` and crosses the ignition.
  const detail = { study: { shot: 'detail', duration: FRAMES / FPS } };
  const detailPlans = Array.from({ length: FRAMES }, (_, frame) => mod.planFrame(detail, frame, FPS));
  for (const plan of detailPlans) {
    assert.equal(plan.beat, 'explode', `detail frame ${plan.progress.toFixed(3)} stays in the explode beat`);
    assert.ok(plan.x >= 0.64 && plan.x < 0.88, `detail x ${plan.x.toFixed(3)} is inside the explode beat`);
    assert.equal(plan.params.explode, 0);
    assert.equal(plan.params.duration, 4, 'the module is driven on its own 4 s clock');
  }
  for (let i = 1; i < detailPlans.length; i++) {
    assert.ok(detailPlans[i].x > detailPlans[i - 1].x, 'the detail shot advances monotonically');
    assert.ok(detailPlans[i].exposure > detailPlans[i - 1].exposure, 'the key light lifts across the shot');
  }
  assert.ok(detailPlans[0].x < mod.IGNITION_X, 'the shot starts before the module’s snap');
  assert.ok(detailPlans[FRAMES - 1].x > mod.IGNITION_X, 'the shot ends after the guide ignites');
  const afterIgnition = detailPlans.filter(plan => plan.x > mod.IGNITION_X);
  assert.ok(afterIgnition.length >= 1, 'the shot closes after the ignition (the material reveal)');
  assert.ok(afterIgnition.length < FRAMES, 'the shot still spends most of its time before the ignition');

  // The hero shot is the module's own hero beat.
  const hero = { study: { shot: 'hero', duration: FRAMES / FPS } };
  const heroPlans = Array.from({ length: FRAMES }, (_, frame) => mod.planFrame(hero, frame, FPS));
  for (const plan of heroPlans) assert.equal(plan.beat, 'hero');
  assert.ok(heroPlans[0].x >= 0.88 && heroPlans[FRAMES - 1].x < 1);

  // Progress is a pure function of frame / fps / duration.
  assert.equal(mod.studyProgress(base, 0, FPS), 0);
  assert.ok(Math.abs(mod.studyProgress(base, FRAMES - 1, FPS) - (FRAMES - 1) / FRAMES) < 1e-12);

  // The geometry the module builds is really re-proportioned when the variant is applied.
  assert.deepEqual(
    { rx: gp.CASE.rx, rz: gp.CASE.rz, hl: gp.CASE.hl },
    { rx: 33, rz: 27, hl: 17 },
    'the module’s own case defaults',
  );
  mod.applyVariant(base);
  assert.deepEqual({ rx: gp.CASE.rx, rz: gp.CASE.rz, hl: gp.CASE.hl }, { rx: 30, rz: 35, hl: 11 });
  assert.equal(gp.CASE.hb, 15, 'the base depth is unchanged so the case still sits on the module floor');
  assert.equal(gp.FLOOR_Y, -15);
  assert.deepEqual(
    gp.BUD_CRADLES.map(c => c.x),
    [-15.5, 15.5],
    'the study leaves the bud placement and internal bud geometry to the module',
  );
  assert.equal(gp.BUD_PARTS.length, 10);
});

// ---------------------------------------------------------------------------
// create.mjs: byte-for-byte vendoring, rights/hashes, two Sources, no provider.
// ---------------------------------------------------------------------------
test('create.mjs vendors the module, its own entry and the pinned three closure verbatim', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-glass-study-create-'));
  const root = join(parent, 'study');
  try {
    await authorStudy(root);
    assert.equal(existsSync(join(root, '.viscraft', 'result.json')), false, 'authoring must not build anything');

    // Owned files + the reusable module are vendored byte-for-byte.
    for (const [name, source] of [
      [ENTRY, join(EX_DIR, ENTRY)],
      [SCENE_MJS, join(EX_DIR, SCENE_MJS)],
      [MODULE_MJS, join(MODULE_DIR, MODULE_MJS)],
      [MODULE_HTML, join(SKILL_MODULE_DIR, MODULE_HTML)],
    ] as const) {
      assert.equal(
        sha256(await readFile(join(root, name))),
        sha256(await readFile(source)),
        `${name} is vendored byte-for-byte`,
      );
    }

    const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as {
      assets: Array<{
        id: string;
        path: string;
        type: string;
        sha256: string;
        rights: { origin: string; license: string; redistributable: boolean };
      }>;
      sources: Array<{
        id: string;
        kind: string;
        output: string;
        entry: string;
        resources: string[];
        params: { study: Study };
        seed: number;
      }>;
      handoff: Array<{ path: string; role: string }>;
    };

    // Every pinned engine file is vendored byte-for-byte.
    const vendor = project.assets.filter(asset => asset.path.startsWith('vendor/'));
    assert.ok(vendor.length >= 15, 'the vendored three closure carries the core build, LICENSE and addons');
    for (const [relative, pinned] of Object.entries(THREE_PINS)) {
      assert.equal(sha256(await readFile(join(root, relative))), pinned, `${relative} matches its pinned sha256`);
      assert.equal(project.assets.find(asset => asset.path === relative)?.sha256, pinned);
    }

    // Two browser picture Sources over one entry, each carrying the study's params.
    assert.equal(project.sources.length, 2);
    assert.deepEqual(
      project.sources.map(source => [source.id, source.params.study.shot, source.params.study.duration]),
      [
        ['study_detail', 'detail', FRAMES / FPS],
        ['study_hero', 'hero', FRAMES / FPS],
      ],
    );
    for (const source of project.sources) {
      assert.equal(source.kind, 'browser');
      assert.equal(source.output, 'picture');
      assert.equal(source.entry, ENTRY);
      assert.deepEqual(source.resources, [SCENE_MJS, MODULE_MJS, ...vendor.map(asset => asset.path)]);
      assert.equal(source.params.study.product, 'AURELIS');
      assert.equal(source.params.study.caseRx, 30);
      assert.equal(source.params.study.caseRz, 35);
      assert.equal(source.params.study.caseHl, 11);
      assert.equal(source.params.study.accentA, '#ffb25e');
      assert.equal(source.params.study.duration, FRAMES / FPS);
    }
    assert.ok(
      project.sources.every(source => source.kind !== 'provider'),
      'authoring submits no provider request',
    );

    // Owned assets are MIT (they compose the MIT Look); the module keeps its Lemo origin.
    const asset = (id: string) => project.assets.find(entry => entry.id === id)!;
    for (const id of ['study_scene', 'study_module']) {
      assert.equal(asset(id).type, 'code');
      assert.equal(asset(id).rights.license, 'MIT');
      assert.equal(asset(id).rights.redistributable, true);
      assert.equal(asset(id).sha256, sha256(await readFile(join(root, asset(id).path))), `${id} carries a real sha256`);
    }
    assert.equal(asset('glass_module').path, MODULE_MJS);
    assert.match(asset('glass_module').rights.origin, /lemo-opuscar/);
    assert.equal(asset('glass_module').rights.license, 'Apache-2.0 AND MIT');
    for (const entry of project.assets.filter(item => item.path.startsWith('vendor/'))) {
      assert.equal(entry.type, 'code');
      assert.equal(entry.rights.license, 'MIT');
      assert.equal(entry.rights.redistributable, true);
    }

    // Licence TEXT carried + declared; no absolute host path may leak.
    assert.deepEqual(project.handoff, [{ path: 'THIRD_PARTY_NOTICES.md', role: 'license' }]);
    assert.match(await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), /Permission is hereby granted/);
    assert.doesNotMatch(JSON.stringify(project), /\/lustre-data\/|\/root\/|\/tmp\//);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Real build, real frames, a measured modification, and one-parameter reuse.
// ---------------------------------------------------------------------------
test('the study builds real frames, differs from the unmodified module, and reuses the untouched shot', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-glass-study-e2e-'));
  const root = join(parent, 'study');
  try {
    await authorStudy(root);
    const { study: mod } = await stageModules();
    const authoring = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as {
      sources: Array<{ id: string; params: { study: Study } }>;
      assets: Array<{ path: string }>;
    };
    const vendor = authoring.assets.filter(asset => asset.path.startsWith('vendor/')).map(asset => asset.path);
    const sourceParams = (id: string) =>
      ({ study: authoring.sources.find(item => item.id === id)!.params.study }) as Record<string, unknown>;

    // ---- 1. a REAL build through the Runtime -------------------------------
    const build1 = await buildProject(root);
    assert.equal(build1.status, 'succeeded', 'the example must build with the real Runtime');
    assert.ok(build1.result, 'a succeeded build records a result');
    assert.equal(build1.takes.length, 2, 'one Take per authored Source');
    const final1 = build1.artifacts.find(artifact => artifact.id === build1.result!.artifact)!;
    assert.equal(final1.media!.frames, FRAMES * 2, 'the programme carries both shots');

    const take = (build: typeof build1, id: string) => build.takes.find(entry => entry.source === id)!;
    const artifact = (build: typeof build1, id: string) =>
      build.artifacts.find(entry => entry.id === take(build, id).artifact)!;
    const detail1 = artifact(build1, 'study_detail');
    const hero1 = artifact(build1, 'study_hero');
    assert.equal(detail1.media!.frames, FRAMES);
    assert.equal(hero1.media!.frames, FRAMES);

    const film = decode(join(root, final1.path));
    assert.equal(film.length, FRAME_BYTES * FRAMES * 2, 'every authored programme frame decodes');
    for (let frame = 0; frame < FRAMES * 2; frame++) {
      assert.ok(brightest(frameAt(film, frame)) > 24, `programme frame ${frame} is not blank`);
    }

    const detailPixels = decode(join(root, detail1.path));
    const heroPixels = decode(join(root, hero1.path));
    assert.equal(detailPixels.length, FRAME_BYTES * FRAMES);
    assert.equal(heroPixels.length, FRAME_BYTES * FRAMES);
    assert.ok(litFraction(frameAt(detailPixels, 3)) > 0.05, 'the detail shot draws real product geometry');
    assert.ok(litFraction(frameAt(heroPixels, FRAMES - 1)) > 0.1, 'the hero shot draws the case and both buds');

    // ---- 2. keyframes + adjacent motion, from the module's own beat map -----
    const detailPlans = Array.from({ length: FRAMES }, (_, frame) =>
      mod.planFrame(sourceParams('study_detail'), frame, FPS),
    );
    const heroPlans = Array.from({ length: FRAMES }, (_, frame) =>
      mod.planFrame(sourceParams('study_hero'), frame, FPS),
    );
    assert.deepEqual(
      detailPlans.map(plan => plan.beat),
      Array(FRAMES).fill('explode'),
    );
    assert.deepEqual(
      heroPlans.map(plan => plan.beat),
      Array(FRAMES).fill('hero'),
    );
    assert.ok(detailPlans.some(plan => plan.x < mod.IGNITION_X));
    assert.ok(detailPlans.some(plan => plan.x > mod.IGNITION_X));

    const detailSteps = Array.from({ length: FRAMES - 1 }, (_, frame) =>
      changedFraction(frameAt(detailPixels, frame), frameAt(detailPixels, frame + 1), 24),
    );
    const heroSteps = Array.from({ length: FRAMES - 1 }, (_, frame) =>
      changedFraction(frameAt(heroPixels, frame), frameAt(heroPixels, frame + 1), 24),
    );
    for (const [index, step] of detailSteps.entries()) {
      assert.ok(step > 0.001, `detail frames ${index}→${index + 1} advance (changed ${step.toFixed(4)})`);
    }
    for (const [index, step] of heroSteps.entries()) {
      assert.ok(step > 0.005, `hero frames ${index}→${index + 1} advance (changed ${step.toFixed(4)})`);
    }
    const ignitionStep = detailSteps[detailSteps.length - 1];
    const preIgnitionSteps = detailSteps.slice(0, -1);
    assert.ok(
      ignitionStep > 10 * Math.max(...preIgnitionSteps),
      `the ignition is a real event, not a camera step (${ignitionStep.toFixed(3)} vs max ${Math.max(...preIgnitionSteps).toFixed(3)})`,
    );

    // ---- 3. the study's detail shot differs from the UNMODIFIED module ------
    // The control is the byte-identical module's own entry page with its default params, at the
    // same module time. It is a different page, so it is the untouched product, not the study.
    const control = await openCodeScene(
      root,
      { entry: MODULE_HTML, resources: [MODULE_MJS, ...vendor] },
      { width: WIDTH, height: HEIGHT },
      { label: 'captureCode', globalName: 'viscraft' },
    );
    const controlFrame = async (plan: Plan, file: string): Promise<Buffer> => {
      const moduleFrame = plan.x * 4 * FPS;
      await control.page.evaluate(
        async payload => {
          const page = (globalThis as unknown as Record<string, { render: (args: unknown) => Promise<void> }>)[
            'viscraft'
          ];
          await page.render(payload);
        },
        {
          frame: moduleFrame,
          time: moduleFrame / FPS,
          fps: FPS,
          width: WIDTH,
          height: HEIGHT,
          seed: 1,
          params: { duration: 4 },
          bindings: control.bindings,
        },
      );
      await control.page.screenshot({ path: file, type: 'png', captureBeyondViewport: false });
      return decode(file);
    };
    let detailDiff: number[] = [];
    let heroDiff: number[] = [];
    try {
      await mkdir(join(parent, 'control'), { recursive: true });
      const controlDetail: Buffer[] = [];
      const controlHero: Buffer[] = [];
      for (let frame = 0; frame < FRAMES; frame++) {
        controlDetail.push(await controlFrame(detailPlans[frame], join(parent, 'control', `d${frame}.png`)));
        controlHero.push(await controlFrame(heroPlans[frame], join(parent, 'control', `h${frame}.png`)));
      }
      // The last detail frame is the ignition flash: report it, but measure the shot on the
      // frames that carry the camera/staging/material difference rather than the flash.
      detailDiff = detailPlans
        .slice(0, FRAMES - 1)
        .map((_, frame) => changedFraction(frameAt(detailPixels, frame), controlDetail[frame]));
      heroDiff = heroPlans.map((_, frame) => changedFraction(frameAt(heroPixels, frame), controlHero[frame]));
    } finally {
      await control.close();
    }
    assert.ok(
      mean(detailDiff) > 0.02,
      `the held single-bud detail shot differs from the module’s exploded beat (mean ${mean(detailDiff).toFixed(3)})`,
    );
    assert.ok(
      Math.min(...detailDiff) > 0.005,
      `every measured detail frame differs (min ${Math.min(...detailDiff).toFixed(3)})`,
    );
    assert.ok(
      mean(heroDiff) > 0.02,
      `the re-proportioned case + amber guide differ from the default product (mean ${mean(heroDiff).toFixed(3)})`,
    );
    assert.ok(Math.min(...heroDiff) > 0.015, `every hero frame differs (min ${Math.min(...heroDiff).toFixed(3)})`);

    // ---- 4. ONE authored proportion: one Source re-renders, the rest is reused
    const before = await loadProject(root);
    const edited = structuredClone(before);
    const heroSource = edited.sources.find(source => source.id === 'study_hero')!;
    if (heroSource.kind !== 'browser') throw new Error('expected a browser source study_hero');
    const studyParams = heroSource.params.study as Record<string, unknown>;
    heroSource.params = { ...heroSource.params, study: { ...studyParams, caseRz: 41 } };
    await saveProject(root, edited, before.revision);

    const build2 = await buildProject(root);
    assert.equal(build2.status, 'succeeded', 'the edited study still builds');
    const heroTake1 = take(build1, 'study_hero').id;
    const detailTake1 = take(build1, 'study_detail').id;
    assert.equal(take(build2, 'study_detail').id, detailTake1, 'the untouched detail Source is reused, not recaptured');
    assert.notEqual(take(build2, 'study_hero').id, heroTake1, 'the edited hero Source produces a new Take');

    const browserOps = build2.operations.filter(
      operation => build2.artifacts.find(entry => entry.id === operation.artifact)?.operation === 'browser',
    );
    assert.equal(browserOps.length, 2);
    assert.equal(browserOps.filter(operation => !operation.reused).length, 1, 'exactly the edited Source re-renders');
    assert.equal(browserOps.filter(operation => operation.reused).length, 1, 'the untouched Source is reused');
    assert.equal(
      browserOps.find(operation => !operation.reused)!.artifact,
      take(build2, 'study_hero').artifact,
      'the re-rendered Take is the hero Source',
    );
    assert.equal(
      build2.operations.find(operation => operation.kind === 'mix-audio')!.reused,
      true,
      'a picture-only edit reuses the unchanged sound mix',
    );
    assert.equal(
      browserOps.find(operation => operation.reused)!.artifact,
      take(build1, 'study_detail').artifact,
      'the reused operation is the untouched detail capture',
    );

    // The new hero frames really changed (the case got deeper), and the detail Take did not.
    const hero2 = decode(join(root, artifact(build2, 'study_hero').path));
    const editDiff = Array.from({ length: FRAMES }, (_, frame) =>
      changedFraction(frameAt(heroPixels, frame), frameAt(hero2, frame)),
    );
    assert.ok(mean(editDiff) > 0.01, `the deeper case re-renders visibly (mean ${mean(editDiff).toFixed(3)})`);
    assert.equal(
      sha256(await readFile(join(root, artifact(build2, 'study_detail').path))),
      sha256(await readFile(join(root, detail1.path))),
      'the reused Take bytes are identical',
    );

    t.diagnostic(
      `real build: ${FRAMES * 2} frames @ ${WIDTH}x${HEIGHT}; ` +
        `beats detail=${[...new Set(detailPlans.map(plan => plan.beat))].join('/')} hero=${[...new Set(heroPlans.map(plan => plan.beat))].join('/')}; ` +
        `ignition step ${ignitionStep.toFixed(3)} vs pre-ignition max ${Math.max(...preIgnitionSteps).toFixed(3)}`,
    );
    t.diagnostic(
      `modification: detail vs unmodified mean ${mean(detailDiff).toFixed(3)} (min ${Math.min(...detailDiff).toFixed(3)}), ` +
        `hero proportion+material mean ${mean(heroDiff).toFixed(3)} (min ${Math.min(...heroDiff).toFixed(3)})`,
    );
    t.diagnostic(
      `one-parameter edit: caseRz 35→41 re-rendered the hero only; detail Take reused, mix reused; ` +
        `new hero frames changed mean ${mean(editDiff).toFixed(3)}`,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
