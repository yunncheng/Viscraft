/**
 * The ONE place a `provider` request's effective Endpoint resolution is
 * resolved: which protocol, which base URL, whether it is a loopback fixture,
 * which wire model id, which named credential and whether it is actually
 * present (environment or stored), and which reference Assets the lane will TRANSMIT (for the
 * per-Asset upload-consent gate).
 *
 * Plan and Produce both go through here, so a request the preflight accepts is
 * accepted by the adapter's own endpoint/credential gate (and vice versa): a
 * plaintext remote HTTP base URL, a malformed URL, an unknown protocol or a
 * vendor credential that is resolved from a different place than the author
 * assumed is reported BEFORE any submission.
 *
 * This module performs NO network call, NO upload, NO job/lock write and reads
 * no media: it is pure configuration resolution.
 */
import { credentialSource } from '../../config/credentials.js';

/** The minimal Source shape the lane resolver reads (a full
 * `ProviderSource` satisfies it structurally). */
export interface VideoLaneSource {
  model: string;
  endpoint: string;
  references?: readonly { asset: string; category: string; role: string }[];
}

/** The protocol identifiers the generic transport and the vendor lanes serve. */
export const VIDEO_SERVICE_PROTOCOLS = [
  'vllm-omni-video',
  'minimax-video-v2',
  'ark-video-v3',
  'runway-v1',
  'fal-queue',
] as const;
export type VideoServiceProtocol = (typeof VIDEO_SERVICE_PROTOCOLS)[number];

/** Protocols served by the vendor adapters (runway.ts / fal.ts) rather than the generic transport. */
export const VENDOR_PROTOCOLS = ['runway-v1', 'fal-queue'] as const;
export type VendorProtocol = (typeof VENDOR_PROTOCOLS)[number];

/** Every protocol the dispatcher can route. */
const KNOWN_PROTOCOLS = new Set<string>(VIDEO_SERVICE_PROTOCOLS);

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** The vendor's conventional credential name when the Endpoint names none. */
const DEFAULT_CREDENTIAL: Record<VendorProtocol, string> = {
  'runway-v1': 'RUNWAYML_API_SECRET',
  'fal-queue': 'FAL_KEY',
};

/** The credential an Endpoint resolves: its own `credential`, else the vendor's conventional name. */
export function endpointCredentialName(endpoint: { protocol?: string; credential?: string }): string | undefined {
  if (endpoint.credential) return endpoint.credential;
  if (endpoint.protocol === 'minimax-video-v2') return 'MINIMAX_API_KEY';
  return isVendorProtocol(endpoint.protocol as VideoServiceProtocol)
    ? DEFAULT_CREDENTIAL[endpoint.protocol as VendorProtocol]
    : undefined;
}

/**
 * Whether a protocol's SERVICE always authenticates with a bearer credential,
 * even when the Endpoint names none — so readiness must not report it as
 * `not-required`. The generic `vllm-omni-video` transport is deployment-defined (a
 * loopback deployment may need no credential at all), the vendor lanes resolve a
 * conventional default name, and Ark v3 always authenticates.
 */
export function protocolRequiresCredential(protocol: string | undefined): boolean {
  return protocol === 'ark-video-v3' || protocol === 'minimax-video-v2';
}

export function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isLoopbackIp(hostname: string): boolean {
  return LOOPBACK_IPS.has(stripBrackets(hostname).toLowerCase());
}

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(stripBrackets(hostname).toLowerCase());
}

export function isVendorProtocol(protocol: VideoServiceProtocol): protocol is VendorProtocol {
  return (VENDOR_PROTOCOLS as readonly string[]).includes(protocol);
}

/** The Endpoint's declared protocol, defaulting to the generic `vllm-omni-video` transport. */
export function videoServiceProtocol(options: { endpoint?: { protocol?: string } }): VideoServiceProtocol {
  return (options.endpoint?.protocol as VideoServiceProtocol | undefined) ?? 'vllm-omni-video';
}

/**
 * The protocol a PRODUCTION request must name explicitly. There is no implicit
 * vendor lane and no guess from the URL: a request that does not say which
 * protocol it speaks cannot be routed. The identity helper
 * {@link videoServiceProtocol} stays total because a missing Endpoint is a
 * configuration gap to REPORT, not an exception to throw while identifying a
 * Source.
 */
export function requireVideoServiceProtocol(
  options: { endpoint?: { protocol?: string } },
  source: { endpoint: string },
  label: string,
): VideoServiceProtocol {
  // A binding that is absent entirely is not "a wrong protocol": say what is
  // missing so the user knows to configure the Endpoint, not to correct it.
  if (options.endpoint === undefined)
    throw new Error(
      `${label}: endpoint '${source.endpoint}' is not configured; supply its protocol and baseUrl explicitly (vllm-omni-video, minimax-video-v2, ark-video-v3, runway-v1 or fal-queue) — no lane is inferred`,
    );
  const protocol = options.endpoint.protocol;
  if (protocol === undefined)
    throw new Error(
      `${label}: endpoint '${source.endpoint}' declares no protocol; name it explicitly (vllm-omni-video, minimax-video-v2, ark-video-v3, runway-v1 or fal-queue) — no lane is inferred`,
    );
  if (!KNOWN_PROTOCOLS.has(protocol))
    throw new Error(
      `${label}: endpoint '${source.endpoint}' declares unknown protocol '${protocol}'; supported protocols are vllm-omni-video, minimax-video-v2, ark-video-v3, runway-v1 and fal-queue`,
    );
  return protocol as VideoServiceProtocol;
}

/**
 * Validate and normalize a PRODUCTION base URL: an absolute URL with no
 * credentials/query/fragment, HTTPS, or plain HTTP only for an explicit loopback
 * IP. Returns the URL with any trailing slash removed. Shared by every lane's
 * production `resolveBase` and by the preflight, so the rule cannot drift.
 */
export function normalizeProductionBase(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label}: endpoint baseUrl must be an absolute URL`);
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error(`${label}: endpoint must not contain credentials, query or fragment`);
  if (url.protocol === 'http:') {
    if (!isLoopbackIp(url.hostname))
      throw new Error(`${label}: plain HTTP is limited to explicit loopback IPs; remote endpoints require HTTPS`);
  } else if (url.protocol !== 'https:') {
    throw new Error(`${label}: endpoint requires HTTPS or loopback HTTP`);
  }
  return url.toString().replace(/\/+$/, '');
}

/** Validate and normalize a test-only loopback origin (plain HTTP only). */
export function normalizeLoopbackOrigin(raw: string, label: string, allowHostname: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label}: testOnly.baseUrl must be a valid absolute URL`);
  }
  if (url.protocol !== 'http:') throw new Error(`${label}: testOnly.baseUrl must use plain http on a loopback host`);
  if (!(allowHostname ? isLoopbackHost(url.hostname) : isLoopbackIp(url.hostname))) {
    throw new Error(
      `${label}: testOnly.baseUrl must be loopback (127.0.0.1, [::1]${allowHostname ? ' or localhost' : ''}); non-local overrides are refused`,
    );
  }
  if (url.username || url.password) throw new Error(`${label}: testOnly.baseUrl must not contain credentials`);
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error(`${label}: testOnly.baseUrl must not contain a path, query or fragment`);
  return url.origin;
}

export interface VideoLaneResolution {
  protocol: VideoServiceProtocol;
  /** Normalized base URL the lane would call. Vendor lanes: an origin. The
   * generic test transport appends the Endpoint's pathname prefix. */
  baseUrl: string;
  testOnly: boolean;
  wireModel: string;
  /** The named credential the lane resolves, when any (see config/credentials). */
  credentialName?: string;
  /** Whether that credential is present NOW (environment or stored), without reading it. */
  credentialPresent: boolean;
  /** Reference Assets the lane will transmit on the wire (upload-consent scope). */
  uploadAssetIds: string[];
}

export interface VideoLaneOptions {
  endpoint?: { protocol?: string; baseUrl?: string; model?: string; credential?: string } | undefined;
  testOnly?: { baseUrl: string } | undefined;
}

/** A declared reference, reduced to the fields the transport-support rule reads. */
export interface TransmittableReference {
  asset: string;
  category: string;
  role: string;
}

/**
 * Whether a protocol's TRANSPORT ADAPTER can actually carry a declared reference.
 * This is a wire fact of the implemented lane, not a model limit:
 *  - `runway-v1` transmits exactly one first-frame IMAGE and nothing else (no
 *    tail frame, no identity/second image, no video or audio reference);
 *  - `fal-queue` transmits IMAGE references (the selected queue mapping names
 *    their roles; it has no video/audio file input);
 *  - the generic `vllm-omni-video` / `ark-video-v3` transport transmits every declared
 *    reference (ordered file parts / hosted locator URLs).
 *
 * Shared by the lane's upload-consent scope AND the shared request preparation,
 * so a reference the protocol cannot carry is refused identically on Plan, the
 * ordinary Build and the direct SDK, before any upload or submission.
 */
export function protocolTransmitsReference(
  protocol: VideoServiceProtocol,
  reference: { category: string; role: string },
): boolean {
  if (protocol === 'runway-v1') return reference.category === 'image' && reference.role === 'first-frame';
  if (protocol === 'fal-queue') return reference.category === 'image';
  return true;
}

/** The declared references a protocol's transport actually transmits, in order. */
export function transmittedReferences<T extends TransmittableReference>(
  protocol: VideoServiceProtocol,
  references: readonly T[],
): T[] {
  return references.filter(reference => protocolTransmitsReference(protocol, reference));
}

/**
 * The maximum number of references a protocol's transport can carry at once, or
 * `undefined` for no limit. `runway-v1` sends exactly one prompt image, so a
 * Source declaring two first-frame images is refused in shared preparation rather
 * than silently dropping one (which would also desync the upload-consent scope).
 */
export function protocolReferenceLimit(protocol: VideoServiceProtocol): number | undefined {
  if (protocol === 'runway-v1') return 1;
  return undefined;
}

/** Reference Assets the lane transmits, for the upload-consent scope. */
function transmittedAssetIds(protocol: VideoServiceProtocol, source: VideoLaneSource): string[] {
  return transmittedReferences(protocol, source.references ?? []).map(reference => reference.asset);
}

/**
 * Resolve the effective Endpoint resolution for a `provider` request.
 * Throws only on a genuinely MALFORMED configuration (unknown protocol, missing
 * or bad URL, a test-only override); a merely ABSENT credential is reported via
 * `credentialPresent: false` so the preflight can classify it as an approval the
 * host must grant rather than a blocker.
 */
export function resolveVideoLane(
  options: VideoLaneOptions,
  source: VideoLaneSource,
  label: string,
): VideoLaneResolution {
  const testOnly = Boolean(options.testOnly);
  // A PRODUCTION request must name its protocol; only the loopback fixture keeps
  // the generic transport's own default (it never reaches a real service). A
  // vendor adapter calls this with its own protocol injected, so it is explicit too.
  const protocol = testOnly ? videoServiceProtocol(options) : requireVideoServiceProtocol(options, source, label);
  const vendor = isVendorProtocol(protocol);
  const wireModel = options.endpoint?.model ?? source.model;

  if (testOnly) {
    // A loopback fixture receives a fixed non-secret placeholder; a real key is
    // never resolved (or forwarded) in test mode.
    const origin = normalizeLoopbackOrigin(options.testOnly!.baseUrl, label, vendor);
    let baseUrl = origin;
    if (!vendor && options.endpoint?.baseUrl) {
      const path = new URL(options.endpoint.baseUrl).pathname.replace(/\/+$/, '');
      baseUrl = origin + path;
    }
    return {
      protocol,
      baseUrl,
      testOnly: true,
      wireModel,
      credentialPresent: false,
      uploadAssetIds: transmittedAssetIds(protocol, source),
    };
  }

  // Every production lane must name the service it calls. There is no implicit
  // vendor origin: a protocol with no `baseUrl` is an incomplete Endpoint, not a
  // request to a guessed production URL.
  const raw = options.endpoint?.baseUrl;
  if (raw === undefined)
    throw new Error(
      `${label}: endpoint '${source.endpoint}' declares no baseUrl; name the service explicitly (protocol '${protocol}' has no implicit production address)`,
    );
  const baseUrl = normalizeProductionBase(raw, label);

  const credentialName = endpointCredentialName({ protocol, credential: options.endpoint?.credential });
  const credentialPresent = credentialName === undefined || credentialSource(credentialName) !== 'missing';

  return {
    protocol,
    baseUrl,
    testOnly: false,
    wireModel,
    credentialName,
    credentialPresent,
    uploadAssetIds: transmittedAssetIds(protocol, source),
  };
}
