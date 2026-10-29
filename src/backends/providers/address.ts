/**
 * The ONE address classifier every provider download guard uses: whether a
 * resolved host address is loopback / private / link-local / multicast /
 * reserved, and therefore must not be fetched from.
 *
 * The video-task downloader, fal and Runway adapters all classify the
 * same DNS answers, so a mapped-IPv6 or multicast address cannot be judged
 * differently between lanes. IPv4-mapped (`::ffff:0:0/96`) and IPv4-compatible
 * (`::/96`) IPv6 is normalized to its IPv4 address first so the IPv4 rules
 * (including multicast `>= 224`) apply. Every textual form is handled — dotted
 * (`::ffff:224.0.0.1`), compressed hex (`::ffff:e000:1`, which is what
 * `new URL()` produces) and fully expanded (`0:0:0:0:0:ffff:224.0.0.1`) — in any
 * letter case. IPv6 multicast (`ff00::/8`), unique-local (`fc00::/7`) and
 * link-local (`fe80::/10`) are refused.
 *
 * This is a best-effort preflight, NOT a pinned-IP network sandbox: DNS can
 * change between the check and the fetch. Callers keep their own per-hop
 * redirect checks, scheme rules and the explicit local-service / `testOnly`
 * boundary.
 */
import { isIP } from 'node:net';
import { stripBrackets } from './lane.js';

function privateIpv4(a: number, b: number): boolean {
  return (
    a === 0 || // "this network"
    a === 10 || // RFC 1918
    a === 127 || // loopback
    a >= 224 || // multicast (224/4) and reserved/broadcast (240/4)
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 168) || // RFC 1918
    (a === 100 && b >= 64 && b <= 127) // CGNAT (100.64.0.0/10)
  );
}

const HEXTET = /^[0-9a-f]{1,4}$/;

/**
 * Expand an IPv6 textual address to its 8 numeric hextets, folding a trailing
 * embedded IPv4 dotted-quad (`::ffff:192.168.1.1`) into the last two. Returns
 * undefined for anything that is not well-formed IPv6. `value` must be lowercase.
 */
function expandIpv6(value: string): number[] | undefined {
  let text = value;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const octets = dotted[2].split('.').map(Number);
    if (octets.some(o => o > 255)) return undefined;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${dotted[1]}${hi}:${lo}`;
  }
  const parse = (part: string): number[] | undefined => {
    if (part === '') return [];
    const out: number[] = [];
    for (const item of part.split(':')) {
      if (!HEXTET.test(item)) return undefined;
      out.push(parseInt(item, 16));
    }
    return out;
  };
  const halves = text.split('::');
  if (halves.length === 1) {
    const all = parse(text);
    return all && all.length === 8 ? all : undefined;
  }
  if (halves.length > 2) return undefined;
  const head = parse(halves[0]);
  const tail = parse(halves[1]);
  if (!head || !tail) return undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined; // `::` must stand for at least one hextet
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * The IPv4 dotted-quad an IPv4-mapped (`::ffff:0:0/96`) or IPv4-compatible
 * (`::/96`) IPv6 address carries, in either the dotted or the hex form.
 * `new URL()` rewrites these hosts to hex (`::ffff:127.0.0.1` becomes
 * `::ffff:7f00:1`, `::127.0.0.1` becomes `::7f00:1`), so both textual forms
 * must be recognized. `::` and `::1` fall out as `0.0.0.0` / `0.0.0.1` and stay
 * refused by the IPv4 `a === 0` rule.
 */
function mappedIpv4(value: string): string | undefined {
  if (!value.includes(':')) return undefined;
  const hextets = expandIpv6(value);
  if (!hextets) return undefined;
  const mapped = hextets.slice(0, 5).every(h => h === 0) && hextets[5] === 0xffff;
  const compatible = hextets.slice(0, 6).every(h => h === 0);
  if (!mapped && !compatible) return undefined;
  const [hi, lo] = hextets.slice(6);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** True when `address` is a loopback / private / link-local / multicast / reserved / unparseable host. */
export function isPrivateAddress(address: string): boolean {
  const value = stripBrackets(address).toLowerCase();
  const candidate = mappedIpv4(value) ?? value;
  const kind = isIP(candidate);
  if (kind === 4) {
    const [a, b] = candidate.split('.').map(Number);
    return privateIpv4(a, b);
  }
  if (kind === 0) return true; // unknown form: treat as unsafe rather than public
  return (
    candidate === '::' ||
    candidate === '::1' ||
    candidate.startsWith('fc') || // unique-local fc00::/7
    candidate.startsWith('fd') ||
    /^fe[89ab]/.test(candidate) || // link-local fe80::/10
    candidate.startsWith('ff') // multicast ff00::/8
  );
}
