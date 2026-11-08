// Outbound requests the server makes on a user's behalf (link unfurls) must
// only reach the public internet.
//
// Two checks, both needed:
//
//  1. `isBlockedAddress` on an IP literal in the URL, before fetching. Node's
//     socket layer never calls `lookup` for an IP literal, so the connect-time
//     check below would not see it.
//  2. `publicDispatcher`, an undici Agent whose `lookup` refuses any answer
//     containing a blocked address. It runs on every connection, so every
//     redirect hop is covered, and the address checked is the address
//     connected to: there is no second resolution for DNS rebinding to win.
//
// Addresses are classified with `net.BlockList`, which parses every textual
// form Node accepts (compressed, mixed `::ffff:1.2.3.4`, and so on). String
// prefix tests are what let `[::ffff:7f00:1]` through before.
//
// The desktop's copy of this check is `is_blocked_ip` in
// apps/desktop/src-tauri/src/commands.rs; the two should stay in step.

import dns from 'dns';
import net from 'net';
import { Agent } from 'undici';

// One list per family, and each address checked only against its own: a
// BlockList matches an IPv4 address against IPv6 rules as its mapped form, so
// the ::ffff:0:0/96 rule in a shared list would block every IPv4 address.
const blockedV4 = new net.BlockList();
const blockedV6 = new net.BlockList();

// IPv4: everything that is not globally routable unicast.
for (const [addr, prefix] of [
  ['0.0.0.0', 8],         // "this network"; 0.0.0.0 connects to the local host
  ['10.0.0.0', 8],        // private
  ['100.64.0.0', 10],     // carrier-grade NAT; also used for cluster networks
  ['127.0.0.0', 8],       // loopback
  ['169.254.0.0', 16],    // link-local, including cloud metadata 169.254.169.254
  ['172.16.0.0', 12],     // private
  ['192.0.0.0', 24],      // IETF protocol assignments
  ['192.0.2.0', 24],      // documentation
  ['192.88.99.0', 24],    // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16],    // private
  ['198.18.0.0', 15],     // benchmarking
  ['198.51.100.0', 24],   // documentation
  ['203.0.113.0', 24],    // documentation
  ['224.0.0.0', 4],       // multicast
  ['240.0.0.0', 4],       // reserved, including 255.255.255.255
] as const) {
  blockedV4.addSubnet(addr, prefix, 'ipv4');
}

// IPv6. The ranges that embed an IPv4 address are refused whole rather than
// unpacked: no legitimate link is written that way, and refusing them means
// the embedded address never has to be trusted.
for (const [addr, prefix] of [
  ['::', 96],             // unspecified ::, loopback ::1, IPv4-compatible (deprecated)
  ['::ffff:0:0', 96],     // IPv4-mapped: ::ffff:127.0.0.1 is 127.0.0.1
  ['64:ff9b::', 96],      // NAT64
  ['64:ff9b:1::', 48],    // local-use NAT64
  ['100::', 64],          // discard
  ['2001::', 32],         // Teredo (embeds IPv4)
  ['2001:db8::', 32],     // documentation
  ['2002::', 16],         // 6to4 (embeds IPv4)
  ['fc00::', 7],          // unique local
  ['fe80::', 10],         // link-local
  ['fec0::', 10],         // site-local (deprecated)
  ['ff00::', 8],          // multicast
] as const) {
  blockedV6.addSubnet(addr, prefix, 'ipv6');
}

/** Strip the brackets `URL.hostname` keeps around an IPv6 literal. */
function unbracket(host: string): string {
  return host.replace(/^\[|\]$/g, '');
}

/**
 * True when `ip` is an IP address outside the public unicast internet.
 * Anything that is not an IP address at all is refused too, so a caller that
 * hands this a hostname by mistake fails closed.
 */
export function isBlockedAddress(ip: string): boolean {
  const a = unbracket(ip);
  if (net.isIPv4(a)) return blockedV4.check(a, 'ipv4');
  if (net.isIPv6(a)) return blockedV6.check(a, 'ipv6');
  return true;
}

/**
 * The check made before a request, on the URL's host as written:
 * IP literals are classified, and names that only a local resolver answers
 * for are refused. Other names are left to `publicDispatcher`, which checks
 * what they resolve to at connect time.
 */
export function isBlockedHost(hostname: string): boolean {
  const h = unbracket(hostname).toLowerCase().replace(/\.$/, '');
  if (net.isIP(h)) return isBlockedAddress(h);
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
}

/** Raised from the connect-time lookup; `isBlockedAddressError` finds it in a fetch failure's causes. */
export class BlockedAddressError extends Error {
  readonly code = 'EBLOCKEDADDRESS';
  constructor(hostname: string) {
    super(`${hostname} resolves to an address that is not public`);
    this.name = 'BlockedAddressError';
  }
}

export function isBlockedAddressError(err: unknown): boolean {
  for (let e = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof BlockedAddressError) return true;
  }
  return false;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/**
 * A drop-in for `dns.lookup` as `net.connect` calls it. Resolves every
 * address and refuses the lot if any of them is blocked: a name answering
 * with one public and one private address is not one to connect to.
 */
export function publicLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
      return callback(new BlockedAddressError(hostname), '');
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

/** Pass as `dispatcher` to undici's `fetch` for any request a user can point somewhere. */
export const publicDispatcher = new Agent({ connect: { lookup: publicLookup } });
