// Register the standalone helper's behavioral suite in the normal compiled test
// run. The same suite can also run against a separately installed Skill.
await import(new URL('../../scripts/compare-video.test.mjs', import.meta.url).href);
