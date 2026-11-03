import { characterCount } from "../../primitives/character-count.ts";
import type {
  NetworkScope,
  SystemConfiguration,
} from "../records/system-configuration.ts";

export const MAX_NETWORK_HOSTS = 32;
export const MAX_NETWORK_HOST_ADDITIONS = 8;
export const LEGACY_NETWORK_HOSTS: readonly string[] = Object.freeze([
  "example.org",
  "docs.deno.com",
  "doc.mbse-syson.org",
]);

const PRIVATE_SUFFIXES = new Set([
  "localhost",
  "local",
  "internal",
  "invalid",
  "test",
  "lan",
  "home",
  "corp",
  "onion",
  "arpa",
]);

/** Pure DNS-name validation, not a claim about live DNS resolution or ownership. */
export function normalizeNetworkHost(value: unknown): string {
  if (typeof value !== "string") throw new Error("Hôte réseau invalide.");
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (characterCount(host) > 253 || !/^[a-z0-9.-]+$/.test(host)) {
    throw new Error("Un hôte DNS exact est requis, sans URL ni port.");
  }
  const labels = host.split(".");
  const suffix = labels.at(-1)!;
  if (
    labels.length < 2 || PRIVATE_SUFFIXES.has(suffix) ||
    !/[a-z]/.test(suffix) || suffix.length < 2 ||
    labels.some((label) =>
      label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ) ||
    // Reject common country-code public suffixes, which confer no exact site.
    (labels.length === 2 && suffix.length === 2 &&
      /^(?:ac|co|com|edu|gov|gob|go|gr|lg|mil|ne|net|nom|or|org|sch)$/.test(
        labels[0]!,
      ))
  ) throw new Error("L’hôte doit être un nom DNS public exact.");
  return host;
}

/** Stored authority must already be canonical; no silent widening or deduplication. */
export function validateNetworkScope(value: unknown): NetworkScope {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 1 || !("allowedHosts" in value) ||
    !Array.isArray(value.allowedHosts) ||
    value.allowedHosts.length > MAX_NETWORK_HOSTS
  ) throw new Error("Périmètre réseau invalide ou trop large.");
  const hosts: string[] = [];
  for (const host of value.allowedHosts) {
    if (normalizeNetworkHost(host) !== host || hosts.includes(host)) {
      throw new Error("Les hôtes doivent être uniques et canoniques.");
    }
    hosts.push(host);
  }
  return { allowedHosts: hosts };
}

/** Compatibility grants exactly the former baseline, never an arbitrary host. */
export function networkScopeFor(
  configuration?: Pick<SystemConfiguration, "network">,
): NetworkScope {
  return configuration?.network === undefined
    ? { allowedHosts: [...LEGACY_NETWORK_HOSTS] }
    : validateNetworkScope(configuration.network);
}
