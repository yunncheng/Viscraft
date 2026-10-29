import os from 'node:os';
import path from 'node:path';

/**
 * The per-user Viscraft configuration directory. It lives outside every
 * Project, so provider endpoints and stored credentials are configured once per
 * user and never travel with a work, an archive or a delivery bundle.
 *
 * `VISCRAFT_CONFIG_HOME` overrides it; otherwise `%APPDATA%\viscraft` on Windows
 * and `$XDG_CONFIG_HOME/viscraft` (default `~/.config/viscraft`) elsewhere.
 */
export function configHome(): string {
  const explicit = process.env.VISCRAFT_CONFIG_HOME;
  if (explicit) return path.resolve(explicit);
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'viscraft');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'viscraft');
}
