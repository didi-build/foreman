// Which resolved addresses the egress proxy refuses to connect to (ADR 0106 section 2).
// A CONNECT target must be a public address. Everything else is blocked: loopback, private,
// link-local (which holds the cloud metadata service at 169.254.169.254), CGNAT, unique-local,
// multicast, reserved and documentation ranges. Anything that does not parse is blocked too.
import { BlockList, isIP } from "node:net";

const BLOCKED_IPV4: readonly [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including the metadata service 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // old 6to4 relays
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including broadcast 255.255.255.255
];

// IPv6 is allowed only inside global unicast (2000::/3). Blocking the rest of the space covers
// ::, ::1, IPv4-mapped (::ffff:0:0/96), NAT64 (64:ff9b::/96), unique-local (fc00::/7, which holds
// cloud metadata addresses such as fd00:ec2::254), link-local (fe80::/10) and multicast (ff00::/8).
// Inside 2000::/3, the ranges that are special or carry an IPv4 address are blocked as well.
const BLOCKED_IPV6: readonly [string, number][] = [
  ["::", 3], // 0000::/3, everything below global unicast
  ["4000::", 2], // 4000::/2
  ["8000::", 1], // 8000::/1, includes fc00::/7, fe80::/10 and ff00::/8
  ["2001::", 23], // IETF protocol assignments, including Teredo (2001::/32)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, which carries an IPv4 address
];

// Two lists, because one BlockList checks an IPv4 address against its IPv6 rules too (as
// ::ffff:a.b.c.d), and ::/3 above would then block every IPv4 address.
const blockedIpv4 = new BlockList();
for (const [network, prefix] of BLOCKED_IPV4)
  blockedIpv4.addSubnet(network, prefix, "ipv4");
const blockedIpv6 = new BlockList();
for (const [network, prefix] of BLOCKED_IPV6)
  blockedIpv6.addSubnet(network, prefix, "ipv6");

/** True when the proxy must not connect to this address. Fails closed on anything unusual. */
export function isBlockedAddress(address: string): boolean {
  // A zone id (fe80::1%eth0) names a local interface, and BlockList does not match it.
  if (address.includes("%")) return true;
  const family = isIP(address);
  if (family === 0) return true;
  try {
    return family === 4
      ? blockedIpv4.check(address, "ipv4")
      : blockedIpv6.check(address, "ipv6");
  } catch {
    return true;
  }
}
