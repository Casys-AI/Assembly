import { deepStrictEqual, notDeepStrictEqual } from "node:assert/strict";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { runSysmlToolkitWorker } from "../../src/adapters/out/sysml-toolkit/worker-client.ts";
import type { JsonObject } from "../../src/domain/model/records/compiled-model.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

const probe = new URL("../support/build-digest-probe.ts", import.meta.url);
const locales = ["da_DK.UTF-8", "tr_TR.UTF-8"];
const input = {
  sources: {
    "aa.sysml": "package AA;",
    "ab.sysml": "package AB;",
    "B.sysml": "package B;",
    "a_b.sysml": "package A_B;",
  },
  provider: {
    name: "sysml-toolkit",
    version: "0.10.10",
    format: "ase-toolkit-normalized-json-v1",
  },
  engineVersion: "0.10.10",
  elements: ["aa", "z", "B", "a_b"].map((id, index) => ({
    "@id": id,
    "@type": "PartUsage",
    qualifiedName: `Locale::${id}`,
    "sysx:sourceDocument":
      ["aa.sysml", "ab.sysml", "B.sysml", "a_b.sysml"][index],
    "sysx:sourceLine": index + 1,
  })),
  value: {
    zeta: 1,
    æble: 2,
    Åse: [3, { ø: 4, aa: 5 }],
    I: 6,
    i: 7,
    ı: 8,
    İ: 9,
  },
};

type ProbeResult = {
  sourcePaths: string[];
  sourceDigest: string;
  artifactDigest: string;
  executionDigest: string;
  semanticDigest: string;
  provenanceDigest: string;
  providerContent: string;
  canary: string[];
  executableDigest: string;
  proposalDigest: string;
  fixtureOrders: Record<string, string[]>;
  legacyOrders: Record<string, string[]>;
};

async function runProbe(locale: string): Promise<ProbeResult> {
  const directory = await Deno.makeTempDir();
  try {
    const file = `${directory}/input.json`;
    await Deno.writeTextFile(file, JSON.stringify(input));
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-prompt", "--allow-read", probe.pathname, file],
      env: { LC_ALL: locale },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) {
      throw new Error(
        `Digest probe failed under ${locale}: ${
          new TextDecoder().decode(output.stderr).slice(0, 500)
        }`,
      );
    }
    return JSON.parse(new TextDecoder().decode(output.stdout));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

// Always compare to an explicit legacy locale, even when the parent is Danish.
const results = new Map<string, ProbeResult>();
async function observe(locale: string): Promise<ProbeResult> {
  if (!results.has(locale)) results.set(locale, await runProbe(locale));
  return results.get(locale)!;
}

Deno.test("locale fixture exercises every executable ordering and proposal targets", async () => {
  const reference = await observe("en_US.UTF-8");
  for (const field of Object.keys(reference.fixtureOrders)) {
    deepStrictEqual(
      reference.fixtureOrders[field],
      reference.legacyOrders[field],
      field,
    );
  }
  for (const locale of locales) {
    const observed = await observe(locale);
    for (const field of Object.keys(reference.legacyOrders)) {
      notDeepStrictEqual(
        observed.legacyOrders[field],
        reference.legacyOrders[field],
        `${field} under ${locale}`,
      );
    }
  }
});

Deno.test("executable and proposal digests preserve the persisted en-US values", async () => {
  const reference = await observe("en_US.UTF-8");
  deepStrictEqual(
    reference.executableDigest,
    "c8ba8fee18fda46fc8f2213f212652ccf1a6cdcb8fd62cf3306cae9d35523fc4",
  );
  deepStrictEqual(
    reference.proposalDigest,
    "7384aa4db6d77115d7c01d4f70070e3cd95b1fbd17ab6769be3e4a1125441c7d",
  );
});

Deno.test("locale probes apply both Danish and Turkish collation", async () => {
  const reference = await observe("en_US.UTF-8");
  for (const locale of locales) {
    const observed = await observe(locale);
    notDeepStrictEqual(observed.canary, reference.canary, locale);
    notDeepStrictEqual(observed.canary, observed.canary.toSorted(), locale);
  }
});

for (
  const field of [
    "sourcePaths",
    "sourceDigest",
    "artifactDigest",
    "executionDigest",
    "semanticDigest",
    "provenanceDigest",
    "providerContent",
    "executableDigest",
    "proposalDigest",
    "fixtureOrders",
  ] as const
) {
  Deno.test(`build ${field} ignores the host locale`, async () => {
    const reference = await observe("en_US.UTF-8");
    for (const locale of locales) {
      deepStrictEqual(
        (await observe(locale))[field],
        reference[field],
        `${field} under ${locale}`,
      );
    }
  });
}

Deno.test({
  name:
    "Toolkit preserves legacy element order for mixed-case and underscore source paths",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const paths = [
      "Zeta.sysml",
      "alpha.sysml",
      "a_b.sysml",
      "a-b.sysml",
      "a1.sysml",
      "a_1.sysml",
    ];
    const sources = Object.fromEntries(paths.map((path, index) => [
      path,
      `package P${index} { part p${index}; }`,
    ]));
    const legacySources = Object.fromEntries(
      Object.entries(sources).sort(
        ([a], [b]) => a.localeCompare(b, "en-US"),
      ),
    );
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    // Bypass today's validator to reconstruct the former en-US unit order.
    const legacy = await runSysmlToolkitWorker<JsonObject[]>(packageDir, {
      operation: "compile",
      sources: legacySources,
    }, 60_000);
    const current = await new ToolkitCompiler({ packageDir }).compile(sources);
    deepStrictEqual(
      current.elements.map((e) => e["@id"]),
      legacy.map((e) => e["@id"]),
    );
    deepStrictEqual(Object.keys(current.sources), Object.keys(legacySources));
    deepStrictEqual(current.elements, legacy);
  },
});
