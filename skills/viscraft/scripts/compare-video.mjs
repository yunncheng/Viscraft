#!/usr/bin/env node
// Local derived evidence only: no Project mutation, provider call or fidelity score.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const LIMIT_BYTES = 512 * 1024 * 1024;
async function run(program, args, cwd) {
  return exec(program, args, {
    cwd,
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
}
const finite = n => typeof n === 'number' && Number.isFinite(n);
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function keys(object, allowed, name) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`${name} must be an object`);
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new Error(`Unknown ${name}.${key}`);
}

async function readClip(input, baseDir) {
  keys(input, ['path', 'label', 'in', 'out'], 'clip');
  if (typeof input.path !== 'string' || !input.path) throw new Error('clip.path is required');
  if (typeof input.label !== 'string' || !/^[A-Za-z0-9 _.-]{1,28}$/.test(input.label)) {
    throw new Error('clip.label must be 1-28 ASCII letters, digits, spaces, underscores, dots or hyphens');
  }
  const file = await fs.realpath(path.resolve(baseDir, input.path));
  const sha256 = await hashFile(file);
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=avg_frame_rate,time_base:frame=best_effort_timestamp,duration,pkt_duration',
    '-of',
    'json',
    file,
  ]);
  const probe = JSON.parse(stdout);
  const frames = probe.frames ?? [];
  const timeBase = probe.streams?.[0]?.time_base;
  const [timeNum, timeDen] = (timeBase ?? '').split('/').map(Number);
  if (!(timeNum > 0 && timeDen > 0)) throw new Error('Invalid stream time base');
  const pts = frames.map(frame => {
    const tick = Number(frame.best_effort_timestamp);
    return Number.isSafeInteger(tick) ? (tick * timeNum) / timeDen : NaN;
  });
  if (!pts.length || pts.some((t, i) => !finite(t) || (i > 0 && t <= pts[i - 1]))) {
    throw new Error('Video needs finite, strictly increasing decoded frame PTS');
  }
  let lastDuration = Number(frames.at(-1).duration ?? frames.at(-1).pkt_duration);
  lastDuration = (lastDuration * timeNum) / timeDen;
  let endMethod = 'last decoded frame duration';
  if (!(lastDuration > 0)) {
    const [num, den] = (probe.streams?.[0]?.avg_frame_rate ?? '').split('/').map(Number);
    lastDuration = den / num;
    endMethod = 'average frame rate fallback for last frame';
  }
  if (!finite(lastDuration) || lastDuration <= 0) throw new Error('Cannot establish the last frame end');
  const duration = pts.at(-1) - pts[0] + lastDuration;
  if (!finite(input.in) || !finite(input.out) || input.in < 0 || input.out <= input.in || input.out > duration + 1e-6) {
    throw new Error(`Invalid selected interval [${input.in}, ${input.out}); decoded duration is ${duration}`);
  }
  return { ...input, path: file, sha256, pts, duration, endMethod, timeBase };
}

// All input times are seconds from the first decoded frame; sourcePTS remains raw.
export function makeTimeline(left, right, alignment, fps) {
  keys(alignment, ['mode', 'leftEvent', 'rightEvent'], 'alignment');
  const mode = alignment.mode;
  if (!['elapsed', 'event', 'normalized'].includes(mode))
    throw new Error('alignment.mode must be elapsed, event or normalized');
  if (mode !== 'event' && ('leftEvent' in alignment || 'rightEvent' in alignment))
    throw new Error('Event anchors require event mode');
  const clips = [left, right];
  const durations = clips.map(clip => clip.out - clip.in);
  const anchors = mode === 'event' ? [alignment.leftEvent, alignment.rightEvent] : clips.map(clip => clip.in);
  if (anchors.some((anchor, i) => !finite(anchor) || anchor < clips[i].in || anchor >= clips[i].out)) {
    throw new Error('Each event anchor must lie inside its selected interval');
  }
  const start = mode === 'event' ? Math.min(...clips.map((clip, i) => clip.in - anchors[i])) : 0;
  const end = mode === 'event' ? Math.max(...clips.map((clip, i) => clip.out - anchors[i])) : Math.max(...durations);
  const count = Math.ceil((end - start) * fps - 1e-9);
  const rows = Array.from({ length: count }, (_, index) => {
    const time = start + index / fps;
    return {
      index,
      comparisonTime: time,
      sides: clips.map((clip, side) => {
        const targetTime = mode === 'normalized' ? clip.in + (time / end) * durations[side] : anchors[side] + time;
        if (targetTime < clip.in - 1e-8 || targetTime >= clip.out - 1e-8) return null;
        const rawTarget = clip.pts[0] + targetTime;
        let lo = 0,
          hi = clip.pts.length;
        while (lo + 1 < hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (clip.pts[mid] <= rawTarget + 1e-8) lo = mid;
          else hi = mid;
        }
        const sourcePTS = clip.pts[lo];
        return {
          frame: lo,
          targetTime,
          sourcePTS,
          editTime: sourcePTS - clip.pts[0] - clip.in,
        };
      }),
    };
  });
  return {
    mode,
    start,
    end,
    fps,
    frames: rows,
    note:
      mode === 'normalized'
        ? 'RETIMED progress overview - not timing evidence'
        : mode === 'event'
          ? 'Manual event offset only - no speed change'
          : 'Equal elapsed time - no speed change',
  };
}

function assTime(seconds) {
  // ASS uses centiseconds. Floor boundaries so the next label is active at
  // its actual preview frame, even at rates such as 12 or 24 FPS.
  const cs = Math.floor(seconds * 100 + 1e-8);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}
function subtitles(timeline, clips, width, height) {
  const lines = [
    `[Script Info]`,
    `PlayResX: ${width * 2}`,
    `PlayResY: ${height + 84}`,
    `[V4+ Styles]`,
    `Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BorderStyle, Outline, Alignment, MarginL, MarginR, MarginV`,
    `Style: Default,DejaVu Sans,12,&H00FFFFFF,&H00000000,1,1,7,0,0,0`,
    `[Events]`,
    `Format: Layer, Start, End, Style, Text`,
  ];
  const add = (row, text, x, y) =>
    lines.push(
      `Dialogue: 0,${assTime(row.index / timeline.fps)},${assTime((row.index + 1) / timeline.fps)},Default,{\\pos(${x},${y})}${text}`,
    );
  for (const row of timeline.frames) {
    add(row, `${timeline.mode} | ${timeline.note}`, 8, 4);
    add(row, `compare t=${row.comparisonTime.toFixed(3)}s`, 8, 24);
    row.sides.forEach((side, i) => {
      add(row, clips[i].label, i * width + 8, height + 46);
      add(
        row,
        side
          ? `PTS ${side.sourcePTS.toFixed(3)}s | edit ${side.editTime.toFixed(3)}s | f${side.frame}`
          : 'OUTSIDE SELECTED INTERVAL',
        i * width + 8,
        height + 64,
      );
    });
  }
  return lines.join('\n') + '\n';
}

/** Fresh output directory only. Paths in the request resolve relative to baseDir. */
export async function compareVideos(request, output, baseDir = process.cwd()) {
  keys(request, ['left', 'right', 'alignment', 'fps', 'width', 'samples'], 'request');
  const fps = request.fps ?? 12,
    width = request.width ?? 480,
    samples = request.samples ?? 5;
  if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw new Error('fps must be an integer in [1,30]');
  if (!Number.isInteger(width) || width < 320 || width > 960 || width % 2)
    throw new Error('width must be even and in [320,960]');
  if (!Number.isInteger(samples) || samples < 2 || samples > 12) throw new Error('samples must be in [2,12]');
  const clips = [await readClip(request.left, baseDir), await readClip(request.right, baseDir)];
  const timeline = makeTimeline(...clips, request.alignment, fps);
  const height = Math.round((width * 9) / 32) * 2;
  const panelBytes = width * height * 3;
  const frameBytes = panelBytes * 2;
  if (frameBytes * timeline.frames.length > LIMIT_BYTES)
    throw new Error('Preview exceeds 512 MiB assembled-picture budget; shorten intervals, lower fps or width');
  // Exclusive mkdir prevents overwriting prior evidence or input media.
  await fs.mkdir(output);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-video-compare-'));
  try {
    const handles = [];
    const ordinals = [];
    try {
      for (let side = 0; side < 2; side++) {
        const indices = [
          ...new Set(timeline.frames.flatMap(row => (row.sides[side] ? [row.sides[side].frame] : []))),
        ].sort((a, b) => a - b);
        if (!indices.length) throw new Error('A selected interval has no preview samples; increase fps');
        ordinals[side] = new Map(indices.map((index, ordinal) => [index, ordinal]));
        const raw = path.join(work, `side-${side}.rgb`);
        const select = indices.map(n => `eq(n\\,${n})`).join('+');
        await run('ffmpeg', [
          '-v',
          'error',
          '-nostdin',
          '-threads',
          '1',
          '-noautorotate',
          '-i',
          clips[side].path,
          '-map',
          '0:v:0',
          '-an',
          '-vf',
          `select=${select},scale=w='trunc(min(${width},${height}*dar)/2)*2':h='trunc(min(${height},${width}/dar)/2)*2',setsar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
          '-fps_mode',
          'passthrough',
          '-pix_fmt',
          'rgb24',
          '-f',
          'rawvideo',
          '-threads',
          '1',
          raw,
        ]);
        if ((await fs.stat(raw)).size !== indices.length * panelBytes)
          throw new Error('Decoded frame count differs from source PTS selection');
        handles.push(await fs.open(raw, 'r'));
      }
      const assembled = await fs.open(path.join(work, 'comparison.rgb'), 'wx');
      try {
        for (const row of timeline.frames) {
          const panels = [Buffer.alloc(panelBytes, 20), Buffer.alloc(panelBytes, 20)];
          for (let side = 0; side < 2; side++)
            if (row.sides[side]) {
              const { bytesRead } = await handles[side].read(
                panels[side],
                0,
                panelBytes,
                ordinals[side].get(row.sides[side].frame) * panelBytes,
              );
              if (bytesRead !== panelBytes) throw new Error('Incomplete source frame read');
            }
          const pair = Buffer.alloc(frameBytes);
          for (let y = 0; y < height; y++)
            for (let side = 0; side < 2; side++) {
              panels[side].copy(pair, (y * 2 + side) * width * 3, y * width * 3, (y + 1) * width * 3);
            }
          await assembled.writeFile(pair);
        }
      } finally {
        await assembled.close();
      }
    } finally {
      await Promise.all(handles.map(handle => handle.close()));
    }
    await fs.writeFile(path.join(work, 'labels.ass'), subtitles(timeline, clips, width, height));
    await run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-f',
        'rawvideo',
        '-pixel_format',
        'rgb24',
        '-video_size',
        `${width * 2}x${height}`,
        '-framerate',
        String(fps),
        '-i',
        'comparison.rgb',
        '-vf',
        `pad=iw:ih+84:0:44:color=0x141414,ass=labels.ass`,
        '-an',
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        path.resolve(output, 'comparison.mp4'),
      ],
      work,
    );
    const sampleIndices = [
      ...new Set(
        Array.from({ length: samples }, (_, i) => Math.round((i * (timeline.frames.length - 1)) / (samples - 1))),
      ),
    ];
    await run('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-i',
      path.resolve(output, 'comparison.mp4'),
      '-vf',
      `select='${sampleIndices.map(n => `eq(n,${n})`).join('+')}',tile=1x${sampleIndices.length}`,
      '-frames:v',
      '1',
      '-threads',
      '1',
      path.resolve(output, 'contact-sheet.png'),
    ]);
    const report = {
      schema: 'viscraft-video-comparison/1',
      observation: 'Sampled decoded pictures; silent preview, no semantic or audiovisual verdict',
      sampling:
        'Last source frame at or before requested time; repetition/drop only, no interpolation. Pixel preview uses coded orientation and a letterboxed 16:9 panel.',
      clips: clips.map(({ pts, ...clip }) => ({
        ...clip,
        firstPTS: pts[0],
        decodedFrames: pts.length,
      })),
      timeline,
      sampleIndices,
      outputs: { video: 'comparison.mp4', contactSheet: 'contact-sheet.png' },
    };
    // Detect concurrent source edits rather than attach a stale hash to new pixels.
    for (const clip of clips)
      if ((await hashFile(clip.path)) !== clip.sha256) throw new Error('Input changed during comparison');
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } catch (error) {
    await fs.writeFile(path.join(output, 'FAILED.txt'), `Incomplete comparison: ${error.message}\n`);
    throw error;
  } finally {
    // Only this invocation's private scratch files; never input or prior outputs.
    await fs.rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [config, output, ...extra] = process.argv.slice(2);
  if (config === '--help') {
    console.log(
      'Usage: node compare-video.mjs request.json NEW_OUTPUT_DIRECTORY\nSee references/runtime/media-analysis.md, Compare selected video intervals.',
    );
  } else if (!config || !output || extra.length) {
    console.error('Usage: node compare-video.mjs request.json NEW_OUTPUT_DIRECTORY');
    process.exitCode = 1;
  } else {
    try {
      await compareVideos(
        JSON.parse(await fs.readFile(config, 'utf8')),
        path.resolve(output),
        path.dirname(path.resolve(config)),
      );
      console.log(path.resolve(output, 'report.json'));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
