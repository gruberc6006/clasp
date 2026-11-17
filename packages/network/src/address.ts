import { ClaspError } from "@clasp/core";

/** Grants for network hosts use resource ids of the form `network:<origin>`, e.g. `network:wss://chat.example.org`. */
export const NETWORK_RESOURCE_PREFIX = "network:";

export interface SocketAddress {
  /** The address to connect to, normalized. */
  url: string;
  /** Scheme, host and port: what a permission covers. */
  origin: string;
  /** Host name with a port when it is not the default one. */
  host: string;
  /** True for this computer (localhost, 127.x, ::1). */
  local: boolean;
  /** True for wss:// (encrypted). */
  secure: boolean;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLocal(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/**
 * Validates a socket address. Only ws:// and wss:// are accepted, and an
 * address may not carry a user name or password.
 */
export function parseSocketAddress(input: unknown): SocketAddress {
  if (typeof input !== "string" || input.trim() === "") throw new ClaspError("VALIDATION_FAILED", "A server address is required, like wss://example.org/chat.");
  const text = input.trim();
  if (text.length > 2048) throw new ClaspError("VALIDATION_FAILED", "That server address is too long.");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new ClaspError("VALIDATION_FAILED", `“${text}” is not a valid address. Use ws:// or wss://, like wss://example.org/chat.`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new ClaspError("VALIDATION_FAILED", `Sockets connect to ws:// or wss:// addresses, not ${parsed.protocol}//.`);
  }
  if (parsed.username || parsed.password) {
    throw new ClaspError("VALIDATION_FAILED", "Server addresses may not contain a user name or password.");
  }
  if (!parsed.hostname) throw new ClaspError("VALIDATION_FAILED", "The address has no host.");
  parsed.hash = "";
  return {
    url: parsed.toString(),
    origin: `${parsed.protocol}//${parsed.host}`,
    host: parsed.host,
    local: isLocal(parsed.hostname),
    secure: parsed.protocol === "wss:",
  };
}

/** The permission resource id for an origin. */
export function networkResource(origin: string): string {
  return `${NETWORK_RESOURCE_PREFIX}${origin}`;
}

/** Reads a `network:` permission resource id back, for display. Undefined for any other id. */
export function describeNetworkResource(resource: string): SocketAddress | undefined {
  if (!resource.startsWith(NETWORK_RESOURCE_PREFIX)) return undefined;
  try {
    return parseSocketAddress(resource.slice(NETWORK_RESOURCE_PREFIX.length));
  } catch {
    return undefined;
  }
}
