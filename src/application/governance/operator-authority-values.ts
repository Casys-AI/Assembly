import { sha256Bytes as sha256 } from "../../domain/primitives/sha256-bytes.ts";
import { HostEditError } from "../../domain/model/editing/host-edit.ts";
import {
  parseSysmlQualifiedName,
  spellSysmlQualifiedName,
} from "../../domain/model/value-objects/sysml-qualified-name.ts";

export function requireValue(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) {
    throw new HostEditError("TOOLKIT_REFUSED", {
      opIndex: 0,
      op: "insertMember",
      target: { qualifiedName: "" },
    }, `Operator authority write refused: ${message}`);
  }
}
export function string(value: string, label: string) {
  requireValue(
    typeof value === "string" && value.trim().length > 0 &&
      value.length <= 16000,
    label,
  );
  return value;
}
export async function requestOperatorSystemName(
  systemName: string,
  changeId: string,
): Promise<string> {
  const parts = parseSysmlQualifiedName(systemName);
  requireValue(parts && parts.length >= 2, "system namespace");
  const segments = [
    ...parts.slice(0, -1),
    `operator_${
      (await sha256(string(changeId, "change identity"))).slice(0, 24)
    }`,
  ];
  const display = segments.join("::");
  return JSON.stringify(parseSysmlQualifiedName(display)) ===
      JSON.stringify(segments)
    ? display
    : spellSysmlQualifiedName(segments);
}
