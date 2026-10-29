import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { configHome } from './home.js';
import { connectionFromCredential, readUserSettings } from './user-settings.js';

/**
 * Provider credentials, referenced by NAME. An Endpoint names a credential
 * (e.g. `ARK_API_KEY`); the value comes from the environment variable of that
 * name, else from its private user configuration or the value stored with `viscraft auth set <name>` in the
 * per-user configuration directory. The environment wins, so CI and one-off
 * overrides need no stored file.
 *
 * Stored values are owner-private files (directory 0700, file 0600, written
 * atomically) outside every Project. They are never enumerated into output,
 * never part of request identity, job records or bundles, and a resolved value
 * is masked by `redact`. This keeps keys out of the conversation, the work and
 * version control; it is not isolation from an agent running as the same user.
 */

export const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export type CredentialSource = 'environment' | 'configuration' | 'stored' | 'missing';

const resolvedValues = new Set<string>();

/** Values resolved by this process, so `redact` can mask them anywhere. */
export function resolvedCredentialValues(): ReadonlySet<string> {
  return resolvedValues;
}

export function credentialsDir(): string {
  return path.join(configHome(), 'credentials');
}

function assertName(name: string): void {
  if (!CREDENTIAL_NAME.test(name))
    throw new Error(`Invalid credential name '${name}': use letters, digits and underscores, e.g. ARK_API_KEY`);
}

function storedPath(name: string): string {
  assertName(name);
  return path.join(credentialsDir(), name);
}

function assertPrintable(name: string, value: string): void {
  if (!/^[\x21-\x7e]+$/.test(value))
    throw new Error(`Credential ${name} must be a single line of printable ASCII without spaces`);
}

/** Owner-private check (POSIX only), like ssh's refusal of readable private keys. */
function assertPrivate(file: string, mode: number): void {
  if (process.platform !== 'win32' && (mode & 0o077) !== 0)
    throw new Error(`Credential file ${file} is readable by other users; run \`chmod 600 ${file}\``);
}

function storedState(name: string): { file: string; present: boolean } {
  const file = storedPath(name);
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error(`Credential path ${file} is not a regular file`);
    assertPrivate(file, stat.mode);
    return { file, present: stat.size > 0 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, present: false };
    throw error;
  }
}

/** Inspect credential presence/source without returning a value. JSON inspection
 * reads the private file, but only resolveCredential exposes its selected key. */
export function credentialSource(name: string): CredentialSource {
  assertName(name);
  if (process.env[name]?.trim()) return 'environment';
  const connection = connectionFromCredential(name);
  if (connection) {
    const entry = readUserSettings().connections[connection.medium][connection.binding];
    if (entry?.hasApiKey) return entry.credentialSource;
  }
  return storedState(name).present ? 'stored' : 'missing';
}

/** The credential value, or undefined when neither source provides one. */
export function resolveCredential(name: string): string | undefined {
  assertName(name);
  let value = process.env[name]?.trim();
  if (!value) {
    const connection = connectionFromCredential(name);
    if (connection) value = readUserSettings(true).connections[connection.medium][connection.binding]?.apiKey;
  }
  if (!value) {
    const { file, present } = storedState(name);
    if (!present) return undefined;
    value = readFileSync(file, 'utf8').trim();
    if (!value) return undefined;
  }
  assertPrintable(name, value);
  resolvedValues.add(value);
  return value;
}

/** Store a credential value for this user (atomic, 0600 in a 0700 directory). */
export function storeCredential(name: string, value: string): string {
  const file = storedPath(name);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Credential ${name} is empty; nothing was stored`);
  assertPrintable(name, trimmed);
  const dir = credentialsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  const temporary = path.join(dir, `.${name}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${trimmed}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // already renamed
    }
  }
  return file;
}

/** Remove a stored credential; true when one existed. */
export function removeCredential(name: string): boolean {
  try {
    unlinkSync(storedPath(name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Names (never values) of the credentials stored for this user. */
export function storedCredentialNames(): string[] {
  try {
    return readdirSync(credentialsDir())
      .filter(name => CREDENTIAL_NAME.test(name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** How the user (not the agent) supplies a missing credential. */
export function credentialSetupHint(name: string): string {
  return `set the ${name} environment variable or configure apiKey in the private user endpoints.json; alternatively have the user run \`viscraft auth set ${name}\` in their own terminal; never paste the key into the conversation`;
}
