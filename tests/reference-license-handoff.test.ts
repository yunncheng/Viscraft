/**
 * Creative references must carry the COMPLETE licence, not a claim
 * that a licence exists.
 *
 * Each reference is adapted from MIT-licensed upstream code AND contains
 * Viscraft-original work. A Project authored from it therefore has to carry:
 *   - the upstream grant (a local verbatim text and/or the Runtime notice), and
 *   - the Viscraft Apache-2.0 grant with its copyright statement.
 *
 * This test authors every reference through the real CLI, reads the handed-off
 * bytes (not the declaration), exports the Project, and re-reads the exported
 * copy. It also checks that adapted modules record their real upstream origin
 * instead of claiming to be solely Viscraft.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { exportProject } from '../src/operations/delivery/portable.js';
import { loadProject } from '../src/project/project.js';
import type { Project } from '../src/core/schema.js';
import { authorRecipe } from './authoring-helpers.js';

const CODE_VISUALS = resolve('skills/viscraft/assets/studies/code-visuals');
const STUDY_ROOT = resolve('skills/viscraft/assets/studies');

const VISCRAFT_COPYRIGHT = 'Copyright (c) 2026 The Viscraft Authors';
const APACHE_BODY = 'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION';

interface StudyCase {
  name: string;
  /** Upstream holder whose grant must remain visible. */
  upstreamHolder: string;
  /** Local upstream licence text, when the study ships one. */
  localUpstream?: string;
  area?: 'audio' | 'code-visuals';
}

const STUDIES: StudyCase[] = [
  { name: 'cel-watercolor', upstreamHolder: 'LemoLab' },
  { name: 'paint-material', upstreamHolder: 'alchaincyf' },
  { name: 'glass-product', upstreamHolder: 'LemoLab' },
  { name: 'ink-wash', upstreamHolder: 'LemoLab', localUpstream: 'LICENSE-Lemo-Opuscar-MIT.txt' },
  { name: 'pictogram-characters', upstreamHolder: 'LemoLab', localUpstream: 'LICENSE-Lemo-Opuscar-MIT.txt' },
  { name: 'pixel-art', upstreamHolder: 'LemoLab', localUpstream: 'LICENSE-LemoLab-MIT.txt' },
  { name: 'crayon-book', upstreamHolder: 'LemoLab', localUpstream: 'LICENSE-LemoLab-MIT.txt' },
  { name: 'rubber-hose', upstreamHolder: 'LemoLab', localUpstream: 'LICENSE-LemoLab-MIT.txt' },
  { name: 'kinetic-type', upstreamHolder: 'LemoLab' },
  { name: 'risograph', upstreamHolder: 'LemoLab' },
  { name: 'cartoon-jazz', upstreamHolder: 'LemoLab', area: 'audio' },
  { name: 'plucked-breath', upstreamHolder: 'LemoLab', area: 'audio' },
  { name: 'storybook-score', upstreamHolder: 'LemoLab', area: 'audio' },
];

function licenceHandoff(project: Project, path: string): boolean {
  return (project.handoff ?? []).some(file => file.role === 'license' && file.path === path);
}

async function text(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

test('every creative reference hands off Apache-2.0 and retains upstream grants through export', async () => {
  for (const study of STUDIES) {
    const workdir = await mkdtemp(join(tmpdir(), `viscraft-licence-${study.name}-`));
    const projectRoot = join(workdir, 'project');
    const exportRoot = join(workdir, 'export');
    try {
      await authorRecipe({
        recipe: join(STUDY_ROOT, study.area ?? 'code-visuals', study.name, 'create.mjs'),
        root: projectRoot,
        cwd: workdir,
      });
      const project = await loadProject(projectRoot);

      // The declaration is real: the licence is a copied AuthorFile and a
      // `license` handoff, alongside the Runtime notice.
      assert.ok(
        project.handoff?.some(file => file.role === 'license' && file.path === 'THIRD_PARTY_NOTICES.md'),
        `${study.name}: the Runtime notice stays a license handoff`,
      );
      assert.ok(licenceHandoff(project, 'LICENSES.md'), `${study.name}: LICENSES.md is declared as a license handoff`);
      if (study.localUpstream)
        assert.ok(licenceHandoff(project, study.localUpstream), `${study.name}: the upstream text is handed off`);

      // Read the actual bytes, not the declaration.
      const licence = await text(join(projectRoot, 'LICENSES.md'));
      assert.match(licence, new RegExp(APACHE_BODY), `${study.name}: full Apache-2.0 body`);
      assert.ok(licence.includes(VISCRAFT_COPYRIGHT), `${study.name}: Viscraft copyright line`);
      assert.ok(licence.includes(study.upstreamHolder), `${study.name}: upstream holder is credited`);
      assert.match(licence, /Viscraft.*(?:owned|original|contributions|implementation)/i);

      // The Runtime notice is the ONLY upstream grant cel-watercolor,
      // paint-material and glass-product carry, so its bytes are read here too
      // rather than trusting the handoff declaration alone.
      const notice = await text(join(projectRoot, 'THIRD_PARTY_NOTICES.md'));
      assert.ok(
        notice.includes('Permission is hereby granted, free of charge'),
        `${study.name}: the Runtime notice carries the upstream MIT grant`,
      );
      assert.ok(notice.includes(study.upstreamHolder), `${study.name}: the Runtime notice credits the upstream holder`);

      // Adapted code Assets keep their real upstream origin — never a sole
      // Viscraft claim.
      const codeAssets = project.assets.filter(asset => asset.type === 'code');
      assert.ok(codeAssets.length > 0, `${study.name}: code Assets exist`);
      for (const asset of codeAssets) {
        if (asset.path.startsWith('vendor/')) {
          assert.equal(asset.rights.license, 'MIT', `${study.name}/${asset.id}: unchanged third-party code`);
        } else {
          assert.ok(
            ['Apache-2.0', 'Apache-2.0 AND MIT'].includes(asset.rights.license),
            `${study.name}/${asset.id}: Viscraft grant and any upstream obligations`,
          );
        }
        assert.ok(asset.rights.origin.length > 0, `${study.name}/${asset.id}: origin is stated`);
      }
      assert.ok(
        codeAssets.some(asset => asset.rights.origin.includes(study.upstreamHolder)),
        `${study.name}: an adapted Asset records the upstream holder in its origin`,
      );

      // The licence survives an actual Portable export byte-for-byte.
      await exportProject(projectRoot, exportRoot);
      const exported = await loadProject(exportRoot);
      assert.ok(licenceHandoff(exported, 'LICENSES.md'), `${study.name}: export carries the license handoff`);
      assert.equal(
        await text(join(exportRoot, 'LICENSES.md')),
        licence,
        `${study.name}: the exported licence is the full authored text`,
      );
      assert.equal(
        await text(join(exportRoot, 'THIRD_PARTY_NOTICES.md')),
        notice,
        `${study.name}: the exported Runtime notice is the authored text`,
      );
      if (study.localUpstream)
        assert.equal(
          await text(join(exportRoot, study.localUpstream)),
          await text(join(CODE_VISUALS, study.name, study.localUpstream)),
          `${study.name}: the upstream text stays byte-identical`,
        );
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }
});

test('every study carries the complete Apache-2.0 text, not a one-line claim', async () => {
  const apache = (await text(resolve('LICENSE'))).trim();
  for (const study of STUDIES) {
    const licence = await text(join(STUDY_ROOT, study.area ?? 'code-visuals', study.name, 'LICENSES.md'));
    assert.ok(licence.includes(apache), `${study.name}: complete Apache-2.0 text`);
    assert.ok(licence.includes(VISCRAFT_COPYRIGHT), `${study.name}: Viscraft copyright`);
  }
});

test('complete cases carry Apache-2.0 for owned media while preserving third-party font rights', async () => {
  for (const name of ['five-more-minutes', 'beyond-the-frame', 'quiet-new-dimension']) {
    const root = resolve('skills/viscraft/assets/projects', name, 'project');
    const project = await loadProject(root);
    const destination = await mkdtemp(join(tmpdir(), 'viscraft-case-licence-'));
    const exported = join(destination, 'project');
    try {
      await exportProject(root, exported);
      const copy = await loadProject(exported);
      assert.deepEqual(
        copy.assets.map(asset => asset.rights),
        project.assets.map(asset => asset.rights),
      );
      for (const asset of copy.assets) {
        if (asset.path.includes('fonts/')) assert.match(asset.rights.license, /OFL|Open Font License/);
        else assert.equal(asset.rights.license, 'Apache-2.0');
      }
      assert.match(await text(join(exported, 'LICENSES.md')), /Apache License, Version 2\.0/);
      const licenceFiles = copy.handoff?.filter(file => file.role === 'license') ?? [];
      assert.ok(licenceFiles.some(file => /LICENSE-.*2\.0\.txt$/.test(file.path)));
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  }
});
