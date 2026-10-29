/*
 * sound-arrange — provenance shared by the sound-arrange and contact-study
 * recipes.
 *
 * This file is declarative: it holds the rights of the arrangement module and
 * the licence destination for the eight recordings. It never pins file sizes or
 * digests — `sound-arrange.mjs` (`SAMPLE_PACK`) is the single authority for the
 * sample order, bytes, repositories, commits, paths and SHA-256 values.
 *
 * Both consumers copy real bytes from `samples/` (one copy, in this directory)
 * into their own Project and declare the digest here to `authorProject` as
 * `expectedSha256`; the Runtime verifies it before writing.
 */

/** Rights of the adapted MIT module, recorded on every Asset copied from it. */
export const SOUND_ARRANGE_RIGHTS = Object.freeze({
  origin:
    'adapted from lemo-opuscar core/audio/{sampler,pluck,sfx}.py, styles/living-screencast/demo/sound.py, ' +
    'styles/pictogram-motion/demo/music/music.py@e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab, MIT) and ' +
    'huashu-art-motion scripts/audio/synth_艺术史速通.py@f178bd7754a71d6d399473af1501634548efa6cb (alchaincyf, MIT)',
  license: 'MIT',
  redistributable: true,
  modifications:
    'Rewritten as dependency-free JavaScript for window.viscraftSound: no Python/NumPy/soxr, no upstream instruments, ' +
    'TTS, mux or second timeline; a new score, section plan and gains; a seeded PRNG; the recordings are the eight CC0 files.',
});

/** The kit's provenance text, copied into a Project under a descriptive name. */
export const SOUND_KIT_LICENSE = Object.freeze({
  source: 'samples/LICENSE.md',
  path: 'SOUND-KIT-LICENSE.md',
});

/**
 * Rights of one `SAMPLE_PACK` entry, built from the entry's own upstream facts.
 *
 * @param {{ repo: string, commit: string, path: string }} entry
 */
export function sampleRights(entry) {
  return {
    origin: `${entry.repo} ${entry.path}@${entry.commit}`,
    license: 'CC0-1.0',
    redistributable: true,
    sourceUrl: `https://github.com/${entry.repo}/blob/${entry.commit}/${entry.path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`,
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    attributionRequired: false,
  };
}
