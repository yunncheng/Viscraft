/**
 * Authored-path policy (project layer).
 *
 * Owns the project-relative path rules shared by delivery operations and the
 * Playable server: the runtime-private `.viscraft/` namespace and credential
 * filenames are never valid authored content. Kept in `project/` so backends can
 * enforce it without depending on the delivery layer.
 */
import { RelativePath } from '../core/schema.js';
import { assertNotOutputPath } from './output.js';

/** The runtime-private directory that must never be treated as authored content. */
export const RUNTIME_DIR = '.viscraft';

const CREDENTIAL_BASENAMES = new Set(['.env', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519']);

export function isCredentialFile(relative: string): boolean {
  const base = (relative.split('/').pop() ?? relative).toLowerCase();
  return CREDENTIAL_BASENAMES.has(base) || base.startsWith('.env.');
}

/** Reject authored files that try to smuggle runtime/scratch content or credentials out of the project. */
export function assertAuthoredPath(relative: string, label: string): void {
  RelativePath.parse(relative);
  const normalized = relative.toLowerCase();
  if (normalized === RUNTIME_DIR || normalized.startsWith(`${RUNTIME_DIR}/`)) {
    throw new Error(`${label} must not be stored under ${RUNTIME_DIR}/: ${relative}`);
  }
  assertNotOutputPath(relative, label);
  if (isCredentialFile(relative)) {
    throw new Error(`${label} must not package a credential file: ${relative}`);
  }
}
