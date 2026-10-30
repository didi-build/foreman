import { describe, expect, it } from "vitest";

import { isBlockedAddress } from "./addresses.ts";

describe("isBlockedAddress (unit: egress proxy address check, ADR 0106 section 2)", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.1", "private 10/8"],
    ["172.16.0.1", "private 172.16/12"],
    ["172.31.255.255", "private 172.16/12, top"],
    ["192.168.1.1", "private 192.168/16"],
    ["169.254.169.254", "metadata service"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "CGNAT"],
    ["100.127.255.255", "CGNAT, top"],
    ["0.0.0.0", "this network"],
    ["0.1.2.3", "this network"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["192.0.2.10", "documentation"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fc00::1", "unique-local"],
    ["fd00:ec2::254", "unique-local metadata address"],
    ["fe80::1", "IPv6 link-local"],
    ["fe80::1%eth0", "IPv6 link-local with a zone id"],
    ["ff02::1", "IPv6 multicast"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["::ffff:8.8.8.8", "IPv4-mapped public, still refused"],
    ["64:ff9b::a00:1", "NAT64"],
    ["2002:a00:1::1", "6to4"],
    ["2001::1", "Teredo"],
    ["2001:db8::1", "IPv6 documentation"],
    ["not-an-address", "not an address"],
    ["", "empty"],
    ["10.0.0.1.", "malformed"],
  ])("blocks %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    "140.82.112.3",
    "104.18.0.1",
    "8.8.8.8",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "169.253.255.255",
    "2606:4700::6810:84e5",
    "2a00:1450:4001:80b::200e",
  ])("allows public address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});
