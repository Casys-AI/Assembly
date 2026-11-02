/** Bind state-changing commands to the actual loopback listener, never DNS. */
import type { AssemblyEnvironment } from "../environment.ts";

export interface LocalHttpPolicy {
  readonly servedOrigin: string;
  readonly environment: AssemblyEnvironment;
}
export type LocalHttpOrigin = string | LocalHttpPolicy;
export function localServedOrigin(input: LocalHttpOrigin): string {
  return typeof input === "string" ? input : input.servedOrigin;
}
export function isDevelopmentOriginAllowed(request: Request): boolean {
  try {
    const value = request.headers.get("origin"),
      origin = value ? new URL(value) : null;
    return !!origin && value === origin.origin && origin.protocol === "http:" &&
      (origin.hostname === "localhost" || origin.hostname === "127.0.0.1") &&
      !origin.username && !origin.password;
  } catch {
    return false;
  }
}
export function requireDevelopmentHost(request: Request): void {
  const url = new URL(request.url);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    request.headers.get("host") !== url.host
  ) {
    throw new LocalHttpFailure(
      "HOST_REFUSED",
      403,
      "Hôte local refusé.",
      "Utilisez localhost ou 127.0.0.1.",
    );
  }
}
export class LocalHttpFailure extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly recovery: string,
  ) {
    super(message);
  }
}

export function requireLocalJsonCommand(
  request: Request,
  policy: LocalHttpOrigin,
): void {
  const served = new URL(localServedOrigin(policy));
  const url = new URL(request.url);
  const loopback = (hostname: string) =>
    hostname === "127.0.0.1" || hostname === "localhost";
  const development = typeof policy !== "string" &&
    policy.environment === "development";
  if (
    !loopback(served.hostname) || !loopback(url.hostname) ||
    url.protocol !== served.protocol ||
    (!development && url.port !== served.port) ||
    request.headers.get("host") !== url.host
  ) {
    throw new LocalHttpFailure(
      "HOST_REFUSED",
      403,
      "Hôte local refusé.",
      "Utilisez localhost ou 127.0.0.1 avec le port du serveur local.",
    );
  }
  let originAllowed = request.headers.get("origin") === url.origin;
  if (development) {
    originAllowed = isDevelopmentOriginAllowed(request);
  }
  if (
    !originAllowed ||
    (!development && request.headers.get("sec-fetch-site") === "cross-site")
  ) {
    throw new LocalHttpFailure(
      "ORIGIN_REFUSED",
      403,
      "Origine refusée.",
      "Rechargez l’interface depuis l’origine du serveur local puis réessayez.",
    );
  }
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim()
      .toLowerCase() !== "application/json"
  ) {
    throw new LocalHttpFailure(
      "JSON_REQUIRED",
      415,
      "Un objet JSON est requis.",
      "Envoyez Content-Type: application/json avec un objet JSON.",
    );
  }
}
