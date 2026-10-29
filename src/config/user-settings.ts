/** User-owned configuration input. Never return secret values to diagnostics. */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { configHome } from './home.js';

const EndpointNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,31}$/)
  .refine(name => !['constructor', 'prototype'].includes(name));

export const ConnectionSettingsSchema = z
  .object({
    endpoint: EndpointNameSchema,
    service: z
      .string()
      .trim()
      .min(1)
      .transform(value => value.toLowerCase()),
    model: z
      .string()
      .trim()
      .min(1)
      .transform(value => value.toLowerCase()),
    url: z.string().trim().optional(),
    deploymentModel: z.string().trim().min(1).max(1000).optional(),
    apiKey: z
      .string()
      .trim()
      .regex(/^[\x21-\x7e]*$/)
      .optional(),
  })
  .strict();

export const UserSettingsSchema = z
  .object({
    video: z.array(ConnectionSettingsSchema).default([]),
    image: z.array(ConnectionSettingsSchema).default([]),
  })
  .strict();

export type ConnectionSettings = z.infer<typeof ConnectionSettingsSchema>;
export type Medium = 'video' | 'image';
export interface UserConnection extends Omit<ConnectionSettings, 'apiKey'> {
  credentialName: string;
  credentialSource: 'environment' | 'configuration' | 'missing';
  hasApiKey: boolean;
  /** Only populated at the authentication boundary, never by the normal reader. */
  apiKey?: string;
}

export function userEndpointsFile(): string {
  return path.join(configHome(), 'endpoints.json');
}
const DEFAULT_ENDPOINT = 'default';
const ENV_FIELDS = {
  SERVICE: 'service',
  MODEL: 'model',
  URL: 'url',
  DEPLOYMENT_MODEL: 'deploymentModel',
  API_KEY: 'apiKey',
} as const;

export function connectionEnvPrefix(medium: Medium, name: string): string {
  return `VISCRAFT_${medium.toUpperCase()}${name === DEFAULT_ENDPOINT ? '' : `_${name.toUpperCase()}`}`;
}

export function connectionFromCredential(name: string): { medium: Medium; binding: string } | undefined {
  const match = /^VISCRAFT_(VIDEO|IMAGE)(?:_([A-Z][A-Z0-9_]{0,31}))?_API_KEY$/.exec(name);
  if (!match) return undefined;
  const medium = match[1]!.toLowerCase() as Medium;
  return { medium, binding: match[2]?.toLowerCase() ?? DEFAULT_ENDPOINT };
}

/** Nonempty environment routes replace the complete named JSON route, so a new
 * destination cannot inherit the previous route's file key. A key-only override
 * keeps the existing route. No network query or stored-credential mutation. */
export function readUserSettings(includeSecrets = false): {
  connections: Record<Medium, Record<string, UserConnection>>;
  errors: string[];
} {
  const file = userEndpointsFile();
  let raw: unknown = {};
  let mode: number | undefined;
  try {
    mode = statSync(file).mode;
    const contents = readFileSync(file, 'utf8');
    try {
      raw = JSON.parse(contents);
    } catch {
      throw new Error('expected valid JSON; input contents are not included in this error');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(
        `Cannot read user configuration ${file}: ${(error as NodeJS.ErrnoException).code ?? 'invalid JSON or unreadable file'}`,
      );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`Invalid user configuration ${file}: expected an object`);
  const top = raw as Record<string, unknown>;
  if (Object.keys(top).some(key => key !== 'video' && key !== 'image'))
    throw new Error(`Invalid user configuration ${file}: only video and image sections are allowed`);
  const connections: Record<Medium, Record<string, UserConnection>> = { video: {}, image: {} };
  const errors: string[] = [];
  for (const medium of ['video', 'image'] as const) {
    const section = top[medium];
    if (section !== undefined && !Array.isArray(section)) {
      errors.push(`${medium}: expected an array of connections, each with an endpoint field`);
      continue;
    }
    const entries = new Map<string, unknown>();
    const duplicates = new Set<string>();
    for (const [index, value] of ((section ?? []) as unknown[]).entries()) {
      const entry =
        value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
      if (
        typeof entry?.apiKey === 'string' &&
        entry.apiKey.trim() &&
        process.platform !== 'win32' &&
        mode !== undefined &&
        mode & 0o077
      )
        throw new Error(
          `User configuration ${file} contains a key and is readable by other users; run chmod 600 on that file`,
        );
      const parsedName = EndpointNameSchema.safeParse(entry?.endpoint);
      if (!parsedName.success) {
        errors.push(
          `${medium}[${index}]: endpoint must be a user-chosen name using lowercase letters, digits or underscores, starting with a letter (maximum 32; constructor and prototype are reserved)`,
        );
        continue;
      }
      const name = parsedName.data;
      if (entries.has(name) || duplicates.has(name)) {
        if (!duplicates.has(name))
          errors.push(`${medium}.${name}: duplicate endpoint; choose a unique name within ${medium}`);
        entries.delete(name);
        duplicates.add(name);
      } else entries.set(name, { ...entry, endpoint: name });
    }
    const defaultPrefix = connectionEnvPrefix(medium, DEFAULT_ENDPOINT);
    for (const field of Object.keys(ENV_FIELDS)) {
      if (process.env[`${defaultPrefix}_${field}`]?.trim())
        entries.set(DEFAULT_ENDPOINT, entries.get(DEFAULT_ENDPOINT) ?? {});
    }
    // Discover complete routes first. Compound suffixes such as DEPLOYMENT_MODEL
    // must not invent a second connection named "<name>_deployment".
    const environmentKeys = Object.keys(process.env).filter(key => process.env[key]?.trim());
    const servicePattern = new RegExp(`^VISCRAFT_${medium.toUpperCase()}_([A-Z][A-Z0-9_]{0,31})_SERVICE$`);
    for (const key of environmentKeys) {
      const match = servicePattern.exec(key);
      if (match) entries.set(match[1]!.toLowerCase(), entries.get(match[1]!.toLowerCase()) ?? {});
    }
    const keysFor = (name: string) =>
      Object.keys(ENV_FIELDS).map(field => `${connectionEnvPrefix(medium, name)}_${field}`);
    const knownKeys = new Set([...entries.keys()].flatMap(keysFor));
    const namedPattern = new RegExp(
      `^VISCRAFT_${medium.toUpperCase()}_([A-Z][A-Z0-9_]{0,31}?)_(DEPLOYMENT_MODEL|API_KEY|SERVICE|MODEL|URL)$`,
    );
    for (const key of environmentKeys) {
      if (knownKeys.has(key)) continue;
      const match = namedPattern.exec(key);
      // Keep partial configuration visible as a useful validation error.
      if (match) entries.set(match[1]!.toLowerCase(), entries.get(match[1]!.toLowerCase()) ?? {});
    }
    const ambiguous = new Set<string>();
    for (const key of environmentKeys) {
      const owners = [...entries.keys()].filter(name => keysFor(name).includes(key));
      if (owners.length > 1) {
        errors.push(`${medium}: environment variable ${key} matches multiple connection names; rename a connection`);
        owners.forEach(name => ambiguous.add(name));
      }
    }
    for (const [name, value] of entries) {
      if (ambiguous.has(name) || duplicates.has(name)) continue;
      if (!EndpointNameSchema.safeParse(name).success) {
        errors.push(
          `${medium}: connection names must be lowercase letters, digits or underscores, starting with a letter (maximum 32)`,
        );
        continue;
      }
      const prefix = connectionEnvPrefix(medium, name);
      const env = Object.fromEntries(
        Object.entries(ENV_FIELDS)
          .map(([suffix, field]) => [field, process.env[`${prefix}_${suffix}`]?.trim()])
          .filter(([, val]) => val),
      );
      const routeOverride = Object.keys(env).some(field => field !== 'apiKey');
      const fileEntry =
        value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
      const input = routeOverride
        ? { endpoint: name, ...env }
        : fileEntry
          ? { endpoint: name, ...fileEntry, ...env }
          : { endpoint: name, ...env };
      const parsed = ConnectionSettingsSchema.safeParse(input);
      if (!parsed.success) {
        // Zod enum/unknown-field errors can echo user input. Report only known paths.
        const allowed = ['endpoint', 'service', 'model', 'url', 'deploymentModel', 'apiKey'];
        const fields = [
          ...new Set(
            parsed.error.issues.map(issue =>
              allowed.includes(String(issue.path[0])) ? String(issue.path[0]) : 'connection',
            ),
          ),
        ];
        errors.push(
          `${medium}.${name}: invalid ${fields.join(', ')}; use endpoint, service, model, optional url, deploymentModel and apiKey only`,
        );
        continue;
      }
      const { apiKey, ...settings } = parsed.data;
      const hasApiKey = Boolean(apiKey);
      connections[medium][name] = {
        ...settings,
        credentialName: `${prefix}_API_KEY`,
        credentialSource: hasApiKey ? (env.apiKey ? 'environment' : 'configuration') : 'missing',
        hasApiKey,
        ...(includeSecrets && apiKey ? { apiKey } : {}),
      };
    }
  }
  return { connections, errors };
}
