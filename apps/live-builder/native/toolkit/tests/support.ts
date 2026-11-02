/**
 * Support partagé des tests de contrat Deno de l'addon.
 *
 * Chaque script se lance indépendamment :
 *   deno run -A tests/<fichier>.ts --addon ./ase-toolkit-napi.<...>.node [--out rapport.json]
 * Il imprime un résumé JSON (cas par cas) et termine en échec (code 1)
 * dès qu'un cas casse. Aucune fixture externe : modèles mémoire.
 */
import {
  type AddonModule,
  isNativeError,
  loadAddon,
  nativeErrorCode,
} from "../ts/toolkit.ts";

export type { AddonModule };
export { isNativeError, loadAddon, nativeErrorCode };
export {
  closeAll,
  parseInterchangeText,
  validateInterchange,
} from "../ts/toolkit.ts";
export type {
  ElementRefSnapshot,
  NativeLspServer,
  ResourceCounts,
  SourceText,
  ToolkitLibrary,
  ToolkitSession,
} from "../ts/toolkit.ts";

export function requiredArg(flag: string): string {
  const index = Deno.args.indexOf(flag);
  const value = index >= 0 ? Deno.args[index + 1] : undefined;
  if (!value) throw new Error(`missing required argument ${flag}`);
  return value;
}

export function optionalArg(flag: string): string | undefined {
  const index = Deno.args.indexOf(flag);
  return index >= 0 ? Deno.args[index + 1] : undefined;
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

export function assertEqual<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) {
    throw new Error(
      `ASSERT: ${what}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

export function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`ASSERT: ${what} must be present`);
  }
  return value;
}

export function expectCode(
  fn: () => unknown,
  code: string,
  what: string,
): string {
  try {
    fn();
  } catch (error) {
    assert(
      isNativeError(error, code),
      `${what}: expected error code ${code}, got ${nativeErrorCode(error)} (${
        String(error)
      })`,
    );
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(
    `ASSERT: ${what}: expected ${code} error, but call succeeded`,
  );
}

export interface CaseResult {
  name: string;
  ok: boolean;
  error?: string;
}

const cases: Array<{ name: string; run: () => void | Promise<void> }> = [];

export function test(name: string, run: () => void | Promise<void>): void {
  cases.push({ name, run });
}

/** Exécute les cas enregistrés, imprime le résumé JSON, fixe le code de sortie. */
export async function finish(file: string): Promise<void> {
  const results: CaseResult[] = [];
  for (const entry of cases) {
    try {
      await entry.run();
      results.push({ name: entry.name, ok: true });
    } catch (error) {
      results.push({
        name: entry.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const summary = {
    file,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    cases: results,
  };
  const text = JSON.stringify(summary, null, 2);
  const out = optionalArg("--out");
  if (out) await Deno.writeTextFile(out, text + "\n");
  console.log(text);
  if (summary.failed > 0) Deno.exit(1);
}

// ── Fixtures (modèles mémoire autonomes, sans stdlib) ──

export const FLASHLIGHT = `package Flashlight {
    part def Body;
    part def Battery {
        attribute voltage = 3;
    }
    part flashlight {
        part body : Body;
        part battery : Battery;
    }
}
`;

export const RIG = `package Rig {
    part def Amp;
    part rig {
        part amp : Amp;
        part spare : Amp;
    }
    view shallow { expose rig::*; }
}
`;

/** Branche `else` gardée du Toolkit corrigé (succession shorthand). */
export const FLOW = `package Flow {
    action def Router {
        attribute ok;
        action ingest;
        action fast;
        action slow;
        first start;
        then ingest;
        first ingest if ok then fast;
        else slow;
    }
}
`;
