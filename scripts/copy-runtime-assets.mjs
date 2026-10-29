import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Static resources are Runtime source, built beside the compiled server. They
// must remain available when the host Skill is installed elsewhere or absent.
await cp(
  fileURLToPath(new URL('../src/workbench/ui/', import.meta.url)),
  fileURLToPath(new URL('../dist/src/workbench/ui/', import.meta.url)),
  {
    recursive: true,
    // Source documentation and upstream diffs stay in the source checkout.
    // Attribution remains in THIRD_PARTY_NOTICES.md and the adapted headers.
    filter: source => path.basename(source).toLowerCase() !== 'readme.md' && path.extname(source).toLowerCase() !== '.patch',
  },
);
