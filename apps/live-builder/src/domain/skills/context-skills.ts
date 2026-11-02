import { isSha256Hex, sha256 } from "../primitives/execution-digest.ts";
import { characterCount } from "../primitives/character-count.ts";
import type { BehaviorModelVersion } from "../shared-kernel/behavior-model-version.ts";
import type { SkillMetadata, SkillRecord } from "./entities/skill.ts";
import type { SkillOperation } from "./records/catalog.ts";

/** A skill is local, immutable instruction text. Its content grants no rights. */
export type SkillPermission = "install" | "list" | "load" | "unload";
export type SkillModelVersion = BehaviorModelVersion;
export interface SkillPolicy {
  id: string;
  ownerId: string;
  allowedHosts: string[];
  maxSkillBytes: number;
  maxInstalledSkills: number;
  maxLoadedSkills: number;
  maxLoadedCharacters: number;
}
export interface SkillAuthority {
  callerId: string;
  policy: SkillPolicy;
  modelVersion: SkillModelVersion;
  behaviorId: string;
  invocationId: string;
  permissions: SkillPermission[];
}
export interface SkillReceipt {
  skill: SkillMetadata;
  catalogRevision: number;
  replayed: boolean;
  operation: SkillOperation;
}
export type SkillErrorCode =
  | "invalid"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "limit"
  | "integrity";
export class SkillError extends Error {
  constructor(readonly code: SkillErrorCode, message: string) {
    super(`Context skills: ${message}`);
    this.name = "SkillError";
  }
}
export function requireSkill(
  condition: unknown,
  code: SkillErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new SkillError(code, message);
}
export function skillIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value.trim() === value && !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
}
export function skillDigest(value: unknown): value is string {
  return isSha256Hex(value);
}
export async function skillContentDigest(content: string): Promise<string> {
  return await sha256(content);
}
export function skillMetadata(record: SkillRecord): SkillMetadata {
  const { content: _content, ...metadata } = record;
  return structuredClone(metadata);
}
export function validateSkillPolicy(policy: SkillPolicy): void {
  requireSkill(
    !!policy && skillIdentity(policy.id) && skillIdentity(policy.ownerId),
    "invalid",
    "policy must identify its owner",
  );
  const bounds: Array<[number, number, number]> = [
    [policy.maxSkillBytes, 256, 1_048_576],
    [policy.maxInstalledSkills, 1, 128],
    [policy.maxLoadedSkills, 1, 128],
    [policy.maxLoadedCharacters, 256, 1_048_576],
  ];
  requireSkill(
    bounds.every(([value, min, max]) =>
      Number.isSafeInteger(value) && value >= min && value <= max
    ) && policy.maxLoadedSkills <= policy.maxInstalledSkills,
    "invalid",
    "policy limits must be explicit positive bounded integers",
  );
  requireSkill(
    Array.isArray(policy.allowedHosts) && policy.allowedHosts.length <= 32 &&
      new Set(policy.allowedHosts).size === policy.allowedHosts.length &&
      policy.allowedHosts.every((host) =>
        typeof host === "string" && host === host.toLowerCase() &&
        characterCount(host) <= 253 &&
        /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/
          .test(host) &&
        !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)
      ),
    "invalid",
    "skill download hosts must be exact public DNS names",
  );
}
export function requireSkillAuthority(
  authority: SkillAuthority,
  permission: SkillPermission,
): void {
  validateSkillPolicy(authority?.policy);
  requireSkill(
    skillIdentity(authority.callerId) &&
      authority.callerId === authority.policy.ownerId &&
      skillIdentity(authority.modelVersion?.digest) &&
      skillIdentity(authority.modelVersion?.repositoryVersion) &&
      skillIdentity(authority.behaviorId) &&
      skillIdentity(authority.invocationId),
    "forbidden",
    "authority must identify this local owner and admitted model",
  );
  requireSkill(
    Array.isArray(authority.permissions) &&
      authority.permissions.includes(permission),
    "forbidden",
    `native ${permission} access is not admitted`,
  );
}
export function requireSkillUrl(value: string, policy: SkillPolicy): URL {
  validateSkillPolicy(policy);
  requireSkill(
    typeof value === "string" && value.length <= 8192,
    "invalid",
    "skill URL must be a bounded string",
  );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SkillError("invalid", "expected an absolute HTTPS skill URL");
  }
  requireSkill(
    url.protocol === "https:" && !url.username && !url.password &&
      !url.href.includes("#") && url.href.length <= 8192 &&
      (!url.port || url.port === "443") &&
      policy.allowedHosts.includes(url.hostname) &&
      /(?:^|\/)SKILL\.md$/.test(url.pathname),
    "forbidden",
    "skill URL must name SKILL.md on an explicitly allowed HTTPS host",
  );
  return url;
}
export function requireSkillContent(
  content: unknown,
  maxBytes: number,
): number {
  requireSkill(
    typeof content === "string" && content.trim().length > 0 &&
      !content.includes("\u0000") &&
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(
          new TextEncoder().encode(content),
        ) === content,
    "invalid",
    "skill must contain nonempty UTF-8 instruction text",
  );
  const bytes = new TextEncoder().encode(content).length;
  requireSkill(bytes <= maxBytes, "limit", "skill exceeds the byte limit");
  return bytes;
}
/** Optional frontmatter is display data only, never configuration or authority. */
export function skillDisplay(content: string, id: string): {
  name: string;
  description: string;
} {
  const frontmatter = /^---\r?\n([\s\S]{0,8192}?)\r?\n---(?:\r?\n|$)/.exec(
    content,
  );
  const value = (field: string) => {
    const match = frontmatter?.[1]?.match(
      new RegExp(`^${field}:\\s*(.{1,1000})$`, "m"),
    );
    return match?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
  };
  return {
    name: (value("name") ?? /^#\s+(.+)$/m.exec(content)?.[1] ?? id).slice(
      0,
      200,
    ),
    description: (value("description") ?? "").slice(0, 1000),
  };
}
