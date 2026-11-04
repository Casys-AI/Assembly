import type { SpaceSecretPort } from "../application/work/request-spaces/control-ports.ts";
export class CryptographicSpaceSecrets implements SpaceSecretPort {
  randomSecret(): string {
    return [...crypto.getRandomValues(new Uint8Array(32))].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  }
}
