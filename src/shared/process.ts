import { spawn, type ChildProcess } from 'node:child_process';
import { resolvedCredentialValues } from '../config/credentials.js';

export interface RunCommandOptions {
  timeoutMs?: number;
  /**
   * Finite grace, in ms, between SIGTERM and SIGKILL when a child we started
   * has to be terminated (timeout or stdout overflow). Tests override this to
   * keep fixtures fast; production uses the environment default.
   */
  killGraceMs?: number;
}

const DEFAULT_KILL_GRACE_MS = 5_000;

/** Finite grace between SIGTERM and SIGKILL for a child we must terminate. */
export function commandKillGraceMs(explicit?: number): number {
  const value = explicit ?? Number(process.env.VISCRAFT_COMMAND_KILL_GRACE_MS ?? DEFAULT_KILL_GRACE_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_KILL_GRACE_MS;
}

/**
 * Terminate a child process we spawned, and *guarantee it ends*. Many tools we
 * drive (ffmpeg, generators) can ignore SIGTERM; a timeout or overflow that only
 * sends SIGTERM can leave the promise never-settled. This sends SIGTERM first
 * (so the child can flush and exit cleanly), then SIGKILL after a finite grace,
 * closes its stdio, and — if a lingering grandchild keeps the pipes open past
 * SIGKILL — invokes `onForceSettle` a further grace later so the caller can
 * never wait forever. Only *this* child is signalled: no process group, daemon
 * or system-wide kill.
 *
 * Returns a cancel function to call once the child reports `close`, so a child
 * that exits on its own never leaves a stray escalation timer behind.
 */
export function terminateChild(child: ChildProcess, graceMs: number, onForceSettle: () => void): () => void {
  let closed = false;
  let forceTimer: NodeJS.Timeout | undefined;
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    child.kill('SIGKILL');
    child.stdout?.destroy();
    child.stderr?.destroy();
    // SIGKILL is not catchable, but a grandchild can inherit the stdio pipes and
    // keep them open, so `close` may never fire; settle the caller anyway.
    forceTimer = setTimeout(() => {
      if (!closed) onForceSettle();
    }, graceMs);
  }, graceMs);
  return () => {
    closed = true;
    clearTimeout(killTimer);
    if (forceTimer) clearTimeout(forceTimer);
  };
}

export function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '',
      stderr = '';
    const timeoutMs = options.timeoutMs ?? Number(process.env.VISCRAFT_COMMAND_TIMEOUT_MS ?? 600_000);
    const graceMs = commandKillGraceMs(options.killGraceMs);
    let timedOut = false,
      overflowed = false,
      settled = false,
      cancelTermination: (() => void) | undefined;
    let timer: NodeJS.Timeout;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelTermination?.();
      callback();
    };
    const terminate = (): void => {
      if (cancelTermination) return;
      cancelTermination = terminateChild(child, graceMs, () =>
        settle(() =>
          reject(new Error(`${command} did not exit after SIGKILL (timed out or stdout overflow): ${redact(stderr)}`)),
        ),
      );
    };
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.stdout.on('data', data => {
      stdout += String(data);
      if (stdout.length > 16_000_000 && !overflowed) {
        overflowed = true;
        terminate();
      }
    });
    child.stderr.on('data', data => {
      stderr = (stderr + String(data)).slice(-16_000);
    });
    child.on('error', error => settle(() => reject(error)));
    child.on('close', code => {
      settle(() => {
        // A timeout or overflow is a failure even if the child later exits 0:
        // never report a killed/timed-out command as a success.
        if (timedOut) reject(new Error(`${command} timed out after ${timeoutMs}ms: ${redact(stderr)}`));
        else if (overflowed)
          reject(new Error(`${command} produced more than 16000000 bytes of stdout: ${redact(stderr)}`));
        else if (code === 0) resolve(stdout);
        else reject(new Error(`${command} exited ${code}: ${redact(stderr)}`));
      });
    });
  });
}
/** Mask credential values without classifying ordinary public URLs as secrets. */
export function redactCredentials(text: string): string {
  for (const value of resolvedCredentialValues()) text = text.split(value).join('[REDACTED]');
  return text
    .replace(/(bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:token|api[_-]?key|secret|password|signature)\s*[=:]\s*)[^\s&"',}]+/gi, '$1[REDACTED]');
}

export function redact(text: string): string {
  return redactCredentials(text).replace(/https?:\/\/[^\s"']+/g, '[remote URL redacted]');
}
