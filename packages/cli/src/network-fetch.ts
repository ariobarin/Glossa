import { lookup as dnsLookup } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const IPV4_PREFERRED_HOSTS = new Set([
  "mcp.glossa.sh",
  "registry.npmjs.org",
  "github.com",
]);

export const ipv4PreferredLookup: LookupFunction = (
  hostname,
  options,
  callback,
) => {
  dnsLookup(hostname, { ...options, family: 4 }, callback);
};

const ipv4Dispatcher = new Agent({
  connect: {
    lookup: ipv4PreferredLookup,
  },
});

function requestHostname(input: Parameters<typeof fetch>[0]): string | undefined {
  try {
    const value = typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function prefersIpv4Dns(input: Parameters<typeof fetch>[0]): boolean {
  const hostname = requestHostname(input);
  return hostname !== undefined && IPV4_PREFERRED_HOSTS.has(hostname);
}

export const networkFetch: typeof fetch = async (input, init) => {
  if (!prefersIpv4Dns(input)) return await fetch(input, init);

  return await undiciFetch(
    input as unknown as Parameters<typeof undiciFetch>[0],
    {
      ...(init ?? {}),
      dispatcher: ipv4Dispatcher,
    } as Parameters<typeof undiciFetch>[1],
  ) as unknown as Response;
};
