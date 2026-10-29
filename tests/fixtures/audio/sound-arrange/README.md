# sound-arrange test kit

**Test-only.** This is not a creative reference, product example or recommended
starting point. It supplies the sampler and eight real recordings used by
`tests/sound-kit-digests.test.ts` and `tests/fixtures/authoring/contact-study/`.

Contents: `sound-arrange.mjs` (sampler/arrangement/renderer, unchanged bytes),
`provenance.mjs` (rights drafts), `samples/` (eight pinned CC0 recordings plus
the per-file repository/commit/size/SHA-256 table), `LICENSES.md` (MIT + CC0).

The byte hashes in `SAMPLE_PACK` (`sound-arrange.mjs`) and in both licence
records describe these files; `tests/sound-kit-digests.test.ts` checks them.
The contact-study fixture exercises the authoring and Build closure using these
recordings, measured event timing, sound capture and selective rebuilding. The
fixture's particular section names, orchestration and event counts are not
Runtime contracts.
