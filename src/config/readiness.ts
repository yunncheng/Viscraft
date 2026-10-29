import { endpointCredentialName, normalizeProductionBase } from '../backends/providers/lane.js';
import { credentialSource, storedCredentialNames, type CredentialSource } from './credentials.js';
import { loadUserEndpointsReport, userEndpointsFile } from './endpoints.js';
import { configHome } from './home.js';
import { supportedConnections } from './services.js';

export interface EndpointReadiness {
  endpoint: string;
  protocol: string;
  model: string | null;
  baseUrl: string | null;
  credential: string | null;
  /**
   * Where the credential comes from; no value is returned to the caller.
   * `unknown` means a private deployment declares no key; only the actual
   * service contract can establish whether unauthenticated requests work.
   */
  credentialSource: CredentialSource | 'unknown';
  /** Why the declared configuration cannot be used as-is, or null when it can. */
  problem: string | null;
  ready: boolean;
}

export interface CapabilityReadiness {
  ready: boolean;
  endpoints: EndpointReadiness[];
  note?: string;
}

export interface ProviderReadiness {
  configHome: string;
  endpointsFile: string;
  capabilities: { provider: CapabilityReadiness; 'image-generation': CapabilityReadiness };
  summary: string;
  storedCredentials: string[];
  error?: string;
  scope: string;
  supported: ReturnType<typeof supportedConnections>;
}

function describe(
  name: string,
  endpoint: { protocol: string; baseUrl: string; model?: string | undefined; credential?: string | undefined },
): EndpointReadiness {
  const credential = endpointCredentialName(endpoint) ?? null;
  // The SAME URL rule the lanes enforce before a request. `ready` therefore
  // means "the declared protocol, address and credential name are usable", not
  // that anything was reached.
  let problem: string | null = null;
  try {
    normalizeProductionBase(endpoint.baseUrl, `endpoint "${name}"`);
  } catch (cause) {
    problem = cause instanceof Error ? cause.message : String(cause);
  }
  const source: EndpointReadiness['credentialSource'] = credential !== null ? credentialSource(credential) : 'unknown';
  return {
    endpoint: name,
    protocol: endpoint.protocol,
    model: ('sourceModel' in endpoint ? (endpoint.sourceModel as string) : endpoint.model) ?? null,
    baseUrl: endpoint.baseUrl,
    credential,
    credentialSource: source,
    problem,
    ready: problem === null && source !== 'missing',
  };
}

/**
 * Which generation capabilities this user has configured, by capability: the
 * per-user Endpoints and whether each named credential is present (environment
 * or stored). Reads configuration only — no network query or secret output — so
 * `ready` means "configured", never "verified to generate".
 */
export function providerReadiness(): ProviderReadiness {
  const base = {
    configHome: configHome(),
    endpointsFile: userEndpointsFile(),
    supported: supportedConnections(),
    scope:
      'Configuration only: no service was contacted and no credential value is returned. Ready means the declared URL, protocol and named credential are configured — not that the account, model or output was verified, and not that an Endpoint naming no credential needs none.',
  };
  let error: string | undefined;
  let video: EndpointReadiness[] = [];
  let image: EndpointReadiness[] = [];
  try {
    // Parse per Endpoint: one malformed entry is reported (via `error`) but does
    // NOT discard every other configured Endpoint.
    const { endpoints, errors } = loadUserEndpointsReport();
    const describeEntries = (entries: typeof endpoints.video | typeof endpoints.image) =>
      Object.entries(entries).flatMap(([name, endpoint]) => {
        try {
          return [describe(name, endpoint)];
        } catch (cause) {
          errors.push(`${name}: ${(cause as Error).message}`);
          return [];
        }
      });
    video = describeEntries(endpoints.video);
    image = describeEntries(endpoints.image);
    if (errors.length) error = `${userEndpointsFile()}: ${errors.join('; ')}`;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const capabilities = {
    provider: { ready: video.some(entry => entry.ready), endpoints: video },
    'image-generation': {
      ready: image.some(entry => entry.ready),
      endpoints: image,
      note: 'A vllm-omni-image Endpoint serves both generation and editing (/v1/images/edits) when the deployed model supports it.',
    },
  };
  const readyCount = Object.values(capabilities).filter(capability => capability.ready).length;
  return {
    ...base,
    capabilities,
    summary: `${readyCount} of 2 generation capabilities configured; code, media and Blender work need none.`,
    storedCredentials: storedCredentialNames(),
    ...(error !== undefined ? { error } : {}),
  };
}
