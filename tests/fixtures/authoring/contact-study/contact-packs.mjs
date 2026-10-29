/*
 * contact-study — the one declaration of which `SAMPLE_PACK` packs this study
 * sounds: the marimba bar that is struck and the cello pizzicato that gives the
 * impact body.
 *
 * Both the authoring recipe and the browser sound scene read this file, so the
 * selected closure cannot drift between what is copied into the Project and
 * what the scene validates. `SAMPLE_PACK` in `sound-arrange.mjs` remains the
 * authority for each file's bytes, digest and upstream path.
 */

export const CONTACT_PACKS = Object.freeze(['celloPizz', 'marimba']);
