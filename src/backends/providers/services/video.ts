import type { ProviderSource } from '../../../core/schema.js';
import type { MappingReference, MappingReferenceIdentity } from '../extension.js';

export interface VideoProtocol {
  id: string;
  tasksPath: string;
  statusPath(id: string): string;
  encode(
    source: ProviderSource,
    model: string,
    references: readonly MappingReference[],
    mapped?: Record<string, unknown>,
  ): FormData | string;
  /**
   * A canonical, transport-independent identity of the request this protocol
   * ENCODES: its routing, its scalar/JSON body fields, and every reference's
   * type, order, content hash and role. It deliberately excludes anything
   * non-deterministic or secret — a random multipart boundary, a per-run temp
   * filename, credentials, full base64 payloads or private URLs — so re-hashing
   * the same logical request is stable while a changed encoded field, frame
   * index or route changes the frozen request hash.
   */
  requestIdentity(
    source: ProviderSource,
    model: string,
    references: readonly MappingReferenceIdentity[],
    mapped?: Record<string, unknown>,
  ): unknown;
  parseCreate(value: unknown): string;
  parseStatus(
    value: unknown,
    id: string,
  ): { state: 'pending' | 'ready' | 'failed'; status: string; contentUrl?: string; inferenceSeconds?: number };
  contentPath?(id: string): string;
}
