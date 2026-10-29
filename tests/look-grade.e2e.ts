import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { LookGradeSchema, type Project } from '../src/core/schema.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const PAGE =
  '<!doctype html><body style="margin:0"><canvas id="c"></canvas><script>window.viscraft={render(ctx){const c=document.getElementById("c");c.width=ctx.width;c.height=ctx.height;const g=c.getContext("2d");g.fillStyle="#286eb0";g.fillRect(0,0,c.width,c.height);g.fillStyle="#ffffff";g.fillRect(ctx.frame*2,4,4,4);}};</script>';

test('named Look grades Code and kept-audio media pictures, edits selectively and survives portable reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-look-grade-'));
  const exported = root + '-export';
  try {
    await writeFile(join(root, 'scene.html'), PAGE);
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-filter_threads',
      '1',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x2874b4:s=64x48:r=30:d=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:sample_rate=48000:duration=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-threads',
      '2',
      '-shortest',
      join(root, 'input.mp4'),
    ]);
    const initial: Project = {
      schemaVersion: 1,
      id: 'look-work',
      revision: 1,
      title: 'Two methods, explicit Look',
      soundTargets: [],
      direction: {
        intent: 'Both methods share a named monochrome grade without changing source pixels or sound',
        looks: [
          { id: 'mono', description: 'Explicit monochrome finishing', grade: { saturation: 0 } },
          { id: 'untouched', description: 'Ungraded identity' },
        ],
        transitions: [],
      },
      assets: [
        {
          id: 'film',
          revision: 1,
          path: 'input.mp4',
          sha256: await hashFile(join(root, 'input.mp4')),
          type: 'video',
          rights: { origin: 'Original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
          simulated: false,
        },
      ],
      bindings: {},
      sources: [
        {
          id: 'graphic',
          kind: 'browser',
          output: 'picture',
          entry: 'scene.html',
          resources: [],
          bindings: [],
          params: {},
          seed: 0,
          frames: 12,
        },
      ],
      composition: {
        output: { width: 64, height: 48, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: 'Two real methods' }],
        shots: [
          { id: 'a', scene: 'scene', look: 'mono', intent: 'Code', targetFrames: 8 },
          {
            id: 'b',
            scene: 'scene',
            look: 'mono',
            intent: 'Flat with kept source sound and slow motion',
            targetFrames: 8,
          },
        ],
        placements: [
          { id: 'a', shot: 'a', source: 'graphic', inFrame: 2, outFrame: 10, startFrame: 0, audio: 'mute' },
          {
            id: 'b',
            shot: 'b',
            asset: 'film',
            inFrame: 2,
            outFrame: 6,
            durationFrames: 8,
            startFrame: 8,
            audio: 'keep',
          },
        ],
        transitions: [],
        audio: [],
      },
      imageDocuments: [],
      imageTargets: [],
    };
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(initial)));
    const first = await buildProject(root);
    assert.equal(first.operations.filter(operation => operation.kind === 'grade-picture').length, 2);
    const graded = first.operations
      .filter(operation => operation.kind === 'grade-picture')
      .map(operation => first.artifacts.find(artifact => artifact.id === operation.artifact)!);
    assert(graded.every(artifact => artifact.media!.frames === 8 && !artifact.media!.audio));
    const raw = join(root, 'frames.rgb');
    const decode = async (build: typeof first) => {
      const movie = build.artifacts.find(artifact => artifact.id === build.result!.artifact)!;
      await runCommand('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-threads',
        '2',
        '-i',
        join(root, movie.path),
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        raw,
      ]);
      return readFile(raw);
    };
    const pixel = (bytes: Buffer, frame: number) => [
      ...bytes.subarray((frame * 64 * 48 + 24 * 64 + 32) * 3, (frame * 64 * 48 + 24 * 64 + 32) * 3 + 3),
    ];
    for (const frame of [3, 11]) {
      const rgb = pixel(await decode(first), frame);
      assert(
        Math.max(...rgb) - Math.min(...rgb) < 8,
        'saturation zero must produce real monochrome pixels across methods',
      );
    }
    assert(first.artifacts.find(artifact => artifact.id === first.result!.artifact)!.media!.audio);
    const edit = await loadProject(root);
    edit.composition!.shots[0].look = 'untouched';
    await saveProject(root, edit, edit.revision);
    const second = await buildProject(root);
    assert(
      second.operations
        .filter(operation =>
          ['browser', 'media', 'retime-clip', 'grade-picture', 'source-audio-trim', 'mix-audio'].includes(
            operation.kind,
          ),
        )
        .every(operation => operation.reused),
    );
    const color = pixel(await decode(second), 3);
    assert(Math.max(...color) - Math.min(...color) > 40, 'ungraded shot retains its color');
    const mono = pixel(await decode(second), 11);
    assert(Math.max(...mono) - Math.min(...mono) < 8, 'other shot still uses the scoped Look');
    const gradeEdit = await loadProject(root);
    gradeEdit.direction.looks[0].grade = { brightness: 0.1, contrast: 1.1, saturation: 0, gamma: 1 };
    await saveProject(root, gradeEdit, gradeEdit.revision);
    const third = await buildProject(root);
    assert.equal(
      third.operations.filter(operation => operation.kind === 'grade-picture' && !operation.reused).length,
      1,
    );
    assert(third.operations.find(operation => operation.kind === 'mix-audio')!.reused);
    assert.deepEqual(
      third.takes.map(take => take.id),
      first.takes.map(take => take.id),
    );
    const accepted = await loadProject(root);
    accepted.composition!.placements = accepted.composition!.placements.map((placement, index) => {
      const { source: _source, asset: _asset, framing: _framing, ...rest } = placement;
      return { ...rest, take: third.takes[index].id };
    });
    await saveProject(root, accepted, accepted.revision);
    await buildProject(root);
    await exportProject(root, exported);
    assert((await buildProject(exported)).operations.every(operation => operation.reused));
    assert.deepEqual(LookGradeSchema.parse({}), {});
    assert.throws(() => LookGradeSchema.parse({ gamma: 0 }));
    assert.throws(() => LookGradeSchema.parse({ brightness: Infinity }));
    assert.throws(() => LookGradeSchema.parse({ lut: 'unknown.cube' }));
    const active = await readFile(join(exported, '.viscraft/result.json'), 'utf8');
    const broken = await loadProject(exported);
    broken.composition!.placements[0].outFrame = 999;
    await saveProject(exported, broken, broken.revision);
    // `outFrame = 999` extends the first placement past the second, so the edit
    // now has an unauthorized overlap; the structural pre-check reports that
    // (before any Take work) in place of the later per-Take bounds message. Either
    // way the Build must fail and leave the active result byte-identical.
    await assert.rejects(buildProject(exported), /handles unavailable|reads beyond|overlap/i);
    assert.equal(await readFile(join(exported, '.viscraft/result.json'), 'utf8'), active);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(exported, { recursive: true, force: true });
  }
});
