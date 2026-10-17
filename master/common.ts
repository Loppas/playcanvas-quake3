import { formatIPv6, NA, parseIPv6, type NetAdr } from '../src/net/net';

/**
 * An address's public part, which dpmaster counts one asker or one server quota by
 * (`Com_SameIPv4Addr` and `Com_SameIPv6Addr`, `common.c:428` and `:463`): an IPv4 address whole,
 * and an IPv6 address's first 64 bits, the subnet one home or one host is given.
 *
 * @returns what two addresses share when dpmaster calls them the same public address
 */
export function publicAddress(adr: NetAdr): string {
  const ip6 = adr.type === NA.IP6 ? parseIPv6(adr.ip) : null;
  if (ip6 === null) return adr.ip;
  ip6.fill(0, 8);
  return `${formatIPv6(ip6)}/64`;
}
