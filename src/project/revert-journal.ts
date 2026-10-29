/** Revert progress records and the shared boundary for readers that produce work. */
import { readFile, readdir } from 'node:fs/promises';
import { z } from 'zod';
import { resolveProjectPath } from '../shared/fs.js';

const SHA = z.string().regex(/^[a-f0-9]{64}$/);
const RevertRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^revert-[a-zA-Z0-9_-]+$/),
    target: z.string(),
    checkpoint: z.string(),
    files: z.array(z.object({ path: z.string(), sha256: SHA, existed: z.boolean(), applied: z.boolean() }).strict()),
    project: z.object({ sha256: SHA, applied: z.boolean() }).strict(),
    status: z.enum(['applying', 'complete', 'rolled-back', 'aborted']),
  })
  .strict();
export type RevertRecord = z.infer<typeof RevertRecordSchema>;
export const REVERT_DIR = '.viscraft/revert';

export async function readRevertRecords(root: string): Promise<RevertRecord[]> {
  let names: string[];
  try {
    names = await readdir(await resolveProjectPath(root, REVERT_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: RevertRecord[] = [];
  for (const name of names.filter(n => /^revert-[a-zA-Z0-9_-]+\.json$/.test(n)))
    records.push(
      RevertRecordSchema.parse(
        JSON.parse(await readFile(await resolveProjectPath(root, `${REVERT_DIR}/${name}`), 'utf8')),
      ),
    );
  return records;
}

/** The unfinished revert, if any (interrupted while applying). */
export async function incompleteRevert(root: string): Promise<{ id: string; target: string } | null> {
  const open = (await readRevertRecords(root)).find(record => record.status === 'applying');
  return open ? { id: open.id, target: open.target } : null;
}

/** Refuse production while interrupted application leaves mixed author state. */
export async function assertNoIncompleteRevert(root: string): Promise<void> {
  const open = await incompleteRevert(root);
  if (open)
    throw new Error(
      `Revert ${open.id} is incomplete; run \`viscraft revert <project> --resume\` or \`--abort\` before any other write`,
    );
}
