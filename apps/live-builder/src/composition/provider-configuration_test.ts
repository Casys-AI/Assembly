import { deepEqual, ok } from "node:assert/strict";
import { MuseAgents } from "../adapters/out/llm-providers/agents.ts";
import { LangChainAgents } from "../adapters/out/llm-providers/langchain-agents.ts";
import {
  createProviderAgents,
  resolveProviderConfiguration,
} from "./provider-configuration.ts";

Deno.test("provider configuration defaults to Claude with its previous model and effort", () => {
  deepEqual(resolveProviderConfiguration(() => undefined), {
    provider: "claude",
    agentModel: "claude-sonnet-5-5",
    agentEffort: "high",
    decisionMaxTokens: undefined,
  });
});

Deno.test("provider configuration selects Muse's model without reading Anthropic settings", () => {
  const values: Record<string, string> = {
    AGENT_PROVIDER: "muse",
    MUSE_MODEL: "muse-model",
  };
  deepEqual(
    resolveProviderConfiguration((key) => {
      if (key.startsWith("ANTHROPIC_") || key === "CLAUDE_MODEL") {
        throw new Error(`Unexpected provider setting: ${key}`);
      }
      return values[key];
    }),
    {
      provider: "muse",
      agentModel: "muse-model",
      agentEffort: "medium",
      decisionMaxTokens: undefined,
    },
  );
});

Deno.test("provider configuration leaves Muse's CLI default for an absent or empty model", () => {
  for (const model of [undefined, ""]) {
    const values: Record<string, string | undefined> = {
      AGENT_PROVIDER: "muse",
      MUSE_MODEL: model,
      CLAUDE_MODEL: "wrong-model",
      ANTHROPIC_MODEL: "wrong-model",
      ANTHROPIC_EFFORT: "max",
      ANTHROPIC_DECISION_MAX_TOKENS: "2048",
    };
    deepEqual(resolveProviderConfiguration((key) => values[key]), {
      provider: "muse",
      agentModel: undefined,
      agentEffort: "medium",
      decisionMaxTokens: undefined,
    });
  }
});

Deno.test("provider configuration preserves Anthropic model, effort and numeric token cap", () => {
  const values: Record<string, string> = {
    AGENT_PROVIDER: "claude",
    ANTHROPIC_MODEL: "claude-model",
    ANTHROPIC_EFFORT: "max",
    ANTHROPIC_DECISION_MAX_TOKENS: "2048",
    MUSE_MODEL: "wrong-model",
    CLAUDE_MODEL: "wrong-model",
  };
  deepEqual(resolveProviderConfiguration((key) => values[key]), {
    provider: "claude",
    agentModel: "claude-model",
    agentEffort: "max",
    decisionMaxTokens: 2048,
  });
});

Deno.test("provider configuration applies Anthropic overrides with the default provider", () => {
  const values: Record<string, string> = {
    ANTHROPIC_MODEL: "claude-model",
    ANTHROPIC_EFFORT: "low",
  };
  deepEqual(resolveProviderConfiguration((key) => values[key]), {
    provider: "claude",
    agentModel: "claude-model",
    agentEffort: "low",
    decisionMaxTokens: undefined,
  });
});

Deno.test("provider configuration preserves the Anthropic branch for other provider strings", () => {
  for (const provider of ["", "Muse", "custom"]) {
    const values: Record<string, string> = {
      AGENT_PROVIDER: provider,
      MUSE_MODEL: "wrong-model",
    };
    deepEqual(resolveProviderConfiguration((key) => values[key]), {
      provider,
      agentModel: "claude-sonnet-5-5",
      agentEffort: "high",
      decisionMaxTokens: undefined,
    });
  }
});

Deno.test("provider configuration preserves defined empty Anthropic values for downstream validation", () => {
  const values: Record<string, string> = {
    ANTHROPIC_MODEL: "",
    ANTHROPIC_EFFORT: "",
    ANTHROPIC_DECISION_MAX_TOKENS: "",
  };
  deepEqual(resolveProviderConfiguration((key) => values[key]), {
    provider: "claude",
    agentModel: "",
    agentEffort: "",
    decisionMaxTokens: 0,
  });
});

Deno.test("provider configuration preserves historical numeric conversion without adding validation", () => {
  for (
    const [raw, expected] of [
      ["malformed", NaN],
      ["1.5", 1.5],
      ["-1", -1],
    ] as const
  ) {
    const configuration = resolveProviderConfiguration((key) =>
      key === "ANTHROPIC_DECISION_MAX_TOKENS" ? raw : undefined
    );
    deepEqual(configuration.decisionMaxTokens, expected);
  }
});

Deno.test("resolved default and non-Muse providers construct the real Claude adapter", () => {
  for (const provider of [undefined, "claude", "Muse", "custom", ""]) {
    const read = (key: string) => {
      if (key === "AGENT_PROVIDER") return provider;
      if (key === "ANTHROPIC_API_KEY") return "test-only-key";
      if (key === "MUSE_BIN") throw new Error("Unexpected Muse configuration");
      return undefined;
    };
    const agents = createProviderAgents(
      resolveProviderConfiguration(read),
      read,
    );
    ok(agents instanceof LangChainAgents);
    deepEqual(agents.label, "Claude API");
  }
});

Deno.test("resolved Muse settings construct the real Muse adapter without Anthropic credentials", () => {
  for (const model of [undefined, "", "muse-model"]) {
    const read = (key: string) => {
      if (key.startsWith("ANTHROPIC_")) {
        throw new Error("Unexpected Anthropic configuration");
      }
      if (key === "AGENT_PROVIDER") return "muse";
      if (key === "MUSE_MODEL") return model;
      return undefined;
    };
    const agents = createProviderAgents(
      resolveProviderConfiguration(read),
      read,
    );
    ok(agents instanceof MuseAgents);
    deepEqual(agents.label, "Muse");
  }
});
