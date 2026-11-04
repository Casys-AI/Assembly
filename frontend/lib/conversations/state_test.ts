import { deepStrictEqual, equal, match, throws } from "node:assert/strict";
import { signal } from "@preact/signals";
import { RequestSourceApiError } from "../model/sources/request-revisions.ts";
import type {
  AgentConversation,
  AgentMessageCommand,
  ConversationsSnapshot,
} from "../../../src/application/work/operators/conversation-types.ts";
import {
  createAgentConversations,
  parseConversationsSnapshot,
  takesHumanMessage,
} from "./state.ts";

function agent(id: string, canSend = true): AgentConversation {
  return {
    agentId: id,
    nativeId: `native:${id}`,
    name: id,
    responsibility: `Rôle de ${id}`,
    primary: id === "contact",
    canSend,
    revision: 7,
    busy: false,
    phase: "Prêt",
    messages: [{
      id: `message:${id}`,
      role: "assistant",
      text: `Message de ${id}`,
      at: "2026-10-21T10:00:00Z",
    }],
    modelDigest: "admitted-model",
  };
}
function source(systemId = "system"): ConversationsSnapshot {
  return {
    systemId,
    defaultAgentId: "contact",
    version: "read-1",
    conversations: [
      agent("contact"),
      agent("worker"),
      agent("reviewer", false),
    ],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}

Deno.test("proposal adjustment stays addressed to its owner and preserves both chat drafts", async () => {
  const draft = signal("Brouillon principal");
  const commands: AgentMessageCommand[] = [];
  const gate = deferred<{ accepted: boolean }>();
  const state = createAgentConversations({
    draft,
    canWrite: () => true,
    port: {
      read: () => Promise.resolve(source()),
      send: (command) => {
        commands.push(command);
        return gate.promise;
      },
    },
  });
  state.accept(source());
  state.select("worker");
  draft.value = "Brouillon spécialiste";
  const sending = state.sendTo("worker", "Ajuster la proposition exacte");
  state.select("contact");
  gate.resolve({ accepted: true });
  equal(await sending, true);
  deepStrictEqual(commands, [{
    agentId: "worker",
    text: "Ajuster la proposition exacte",
    expectedRevision: 7,
  }]);
  equal(draft.value, "Brouillon principal");
  state.select("worker");
  equal(draft.value, "Brouillon spécialiste");
  equal(
    await state.sendTo("reviewer", "Ne pas accorder une entrée absente"),
    false,
  );
});

Deno.test("conversation identities select exact records and retain independent drafts without source mutation", () => {
  const draft = signal("Brouillon avant chargement");
  const state = createAgentConversations({ draft, canWrite: () => true });
  const incoming = source(), before = structuredClone(incoming);
  state.accept(incoming);
  equal(state.selected.value?.agentId, "contact");
  equal(draft.value, "Brouillon avant chargement");
  deepStrictEqual(state.pinnedAgentIds.value, ["contact"]);
  state.select("worker");
  equal(draft.value, "");
  draft.value = "Brouillon du spécialiste";
  state.select("reviewer");
  equal(draft.value, "");
  equal(state.canSend.value, false);
  state.select("worker");
  equal(draft.value, "Brouillon du spécialiste");
  state.select("contact");
  equal(draft.value, "Brouillon avant chargement");
  state.select("unknown");
  equal(state.selected.value?.agentId, "contact");
  deepStrictEqual(incoming, before);
});

Deno.test("pinning a recorded audit conversation changes only local preference", async () => {
  let writes = 0;
  const state = createAgentConversations({
    draft: signal(""),
    canWrite: () => true,
    port: {
      read: () => Promise.resolve(source()),
      send: () => {
        writes++;
        return Promise.resolve({ accepted: true });
      },
    },
  });
  state.accept(source());
  state.select("reviewer");
  state.togglePin("reviewer");
  state.restorePins(["reviewer", "reviewer", "unknown"]);
  deepStrictEqual(state.pinnedAgentIds.value, ["reviewer"]);
  equal(await state.send("Une consigne"), false);
  equal(writes, 0);
  equal(state.selected.value?.canSend, false);
});

Deno.test("source removal or changed native identity cannot redirect another agent's draft", () => {
  const draft = signal("");
  const state = createAgentConversations({ draft, canWrite: () => true });
  state.accept(source());
  state.select("worker");
  draft.value = "Pour le premier opérateur";
  const changed = source();
  changed.conversations[1].nativeId = "native:replacement";
  state.accept(changed);
  equal(draft.value, "");
  state.accept(source());
  equal(draft.value, "Pour le premier opérateur");
  const removed = source();
  removed.conversations.splice(1, 1);
  state.accept(removed);
  equal(state.selected.value?.agentId, "contact");
  equal(draft.value, "");
  state.accept(source("another-system"));
  state.select("worker");
  equal(draft.value, "");
});

Deno.test("acknowledgement clears only its own unchanged draft when the user switches agents", async () => {
  const acknowledgement = deferred<{ accepted: boolean }>();
  const commands: AgentMessageCommand[] = [];
  const draft = signal("Premier message");
  const state = createAgentConversations({
    draft,
    canWrite: () => true,
    port: {
      read: () => Promise.resolve(source()),
      send: (command) => {
        commands.push(command);
        return acknowledgement.promise;
      },
    },
  });
  state.accept(source());
  const sending = state.send();
  equal(await state.send(), false);
  state.select("worker");
  draft.value = "Autre brouillon";
  acknowledgement.resolve({ accepted: true });
  equal(await sending, true);
  equal(draft.value, "Autre brouillon");
  state.select("contact");
  equal(draft.value, "");
  deepStrictEqual(commands, [{
    agentId: "contact",
    text: "Premier message",
    expectedRevision: 7,
  }]);
});

Deno.test("uncertain writes retain their draft without blocking or leaking errors to another conversation", async () => {
  let writes = 0;
  const draft = signal("À conserver");
  const state = createAgentConversations({
    draft,
    canWrite: () => true,
    port: {
      read: () => Promise.resolve(source()),
      send: () => {
        writes++;
        return Promise.reject(new Error("Admission de commande non confirmée"));
      },
    },
  });
  state.accept(source());
  equal(await state.send(), false);
  equal(draft.value, "À conserver");
  equal(state.error.value, "Admission de commande non confirmée");
  equal(state.canSend.value, true);
  state.select("worker");
  equal(state.error.value, "");
  equal(state.canSend.value, true);
  await state.refresh();
  equal(writes, 1);
  state.select("contact");
  equal(draft.value, "À conserver");
});

Deno.test("a stale conversation is reread and retried once with the fresh revision", async () => {
  for (const outcome of ["success", "second-stale", "read-fails"] as const) {
    const draft = signal("Keep this message");
    const events: Array<AgentMessageCommand | "read"> = [];
    let writes = 0;
    const refreshed = source();
    refreshed.conversations[0].revision = 8;
    const state = createAgentConversations({
      draft,
      canWrite: () => true,
      port: {
        read: () => {
          events.push("read");
          return outcome === "read-fails"
            ? Promise.reject(new Error("Conversation read refused"))
            : Promise.resolve(refreshed);
        },
        send: (command) => {
          events.push(command);
          writes++;
          if (writes === 1 || outcome === "second-stale") {
            return Promise.reject(
              new RequestSourceApiError(
                "Conversation changed",
                409,
                "STALE_CONVERSATION",
              ),
            );
          }
          return Promise.resolve({ accepted: true });
        },
      },
    });
    state.accept(source());
    equal(await state.send(), outcome === "success");
    deepStrictEqual(events.slice(0, 2), [
      { agentId: "contact", text: "Keep this message", expectedRevision: 7 },
      "read",
    ]);
    if (outcome !== "read-fails") {
      deepStrictEqual(events[2], {
        agentId: "contact",
        text: "Keep this message",
        expectedRevision: 8,
      });
    }
    equal(
      events.filter((event) => event !== "read").length,
      outcome === "read-fails" ? 1 : 2,
    );
    if (outcome !== "success") {
      equal(draft.value, "Keep this message");
      match(state.error.value, /STALE_CONVERSATION/);
      if (outcome === "read-fails") {
        match(state.error.value, /Conversation read refused/);
      }
    } else {
      equal(draft.value, "");
    }
  }
});

Deno.test("a newer conversation event wins over an older in-flight read and dispose ignores late results", async () => {
  const old = deferred<ConversationsSnapshot>();
  const state = createAgentConversations({
    draft: signal(""),
    canWrite: () => true,
    port: {
      read: () => old.promise,
      send: () => Promise.resolve({ accepted: true }),
    },
  });
  const reading = state.refresh();
  const fresh = source();
  fresh.version = "read-2";
  fresh.conversations[1].revision = 9;
  state.accept(fresh);
  old.resolve(source());
  await reading;
  equal(state.snapshot.value?.version, "read-2");
  equal(state.snapshot.value?.conversations[1].revision, 9);
  const late = deferred<ConversationsSnapshot>();
  const second = createAgentConversations({
    draft: signal(""),
    canWrite: () => true,
    port: {
      read: () => late.promise,
      send: () => Promise.resolve({ accepted: true }),
    },
  });
  const pending = second.refresh();
  second.dispose();
  late.resolve(source());
  await pending;
  equal(second.snapshot.value, null);
});

Deno.test("global read-only state and each selected agent's own busy state gate composing independently", () => {
  const frozen = signal(false);
  const state = createAgentConversations({
    draft: signal(""),
    canWrite: () => !frozen.value,
  });
  const incoming = source();
  incoming.conversations[0].busy = true;
  state.accept(incoming);
  equal(state.canSend.value, false);
  state.select("worker");
  equal(state.canSend.value, true);
  frozen.value = true;
  equal(state.canSend.value, false);
});

Deno.test("ambiguous identities, invalid default targets and malformed message collections are rejected", () => {
  const duplicateAgent = source();
  duplicateAgent.conversations[1].agentId = "contact";
  const duplicateNative = source();
  duplicateNative.conversations[1].nativeId =
    duplicateNative.conversations[0].nativeId;
  const duplicateMessage = source();
  duplicateMessage.conversations[0].messages.push(
    duplicateMessage.conversations[0].messages[0],
  );
  for (
    const value of [duplicateAgent, duplicateNative, duplicateMessage, {
      ...source(),
      defaultAgentId: "missing",
    }, { ...source(), version: [] }]
  ) {
    throws(
      () => parseConversationsSnapshot(value),
      /conversations received are unreadable/,
    );
  }
});

Deno.test("a conversation event cannot grant contact until the current system identity matches", async () => {
  const systemId = signal<string | null>(null);
  let writes = 0;
  const state = createAgentConversations({
    draft: signal("Brouillon de l’ancienne instance"),
    canWrite: () => true,
    currentSystemId: () => systemId.value,
    port: {
      read: () => Promise.resolve(source()),
      send: () => {
        writes++;
        return Promise.resolve({ accepted: true });
      },
    },
  });
  state.accept(source());
  equal(state.canSend.value, false);
  equal(await state.send("Message"), false);
  equal(writes, 0);
  systemId.value = "another-system";
  equal(state.canSend.value, false);
  systemId.value = "system";
  equal(state.canSend.value, true);
});

Deno.test("an operator without a human entry takes a message only inside a Request it owns", async () => {
  const commands: AgentMessageCommand[] = [];
  const state = createAgentConversations({
    draft: signal(""),
    canWrite: () => true,
    port: {
      read: () => Promise.resolve(source()),
      send: (command) => {
        commands.push(command);
        return Promise.resolve({ accepted: true });
      },
    },
  });
  const operator = { ...agent("operator", false), runtimeOwned: true };
  const audit = agent("audit", false);
  state.accept({
    ...source(),
    conversations: [agent("contact"), operator, audit],
  });
  equal(takesHumanMessage(operator), false);
  equal(takesHumanMessage(operator, "case-1"), true);
  equal(takesHumanMessage(operator, null), false);
  equal(takesHumanMessage(audit, "case-1"), false);
  equal(state.canSendTo("operator"), false);
  equal(state.canSendTo("operator", "case-1"), true);
  equal(state.canSendTo("audit", "case-1"), false);
  equal(await state.sendTo("operator", "Fewer hosts"), false);
  equal(await state.sendTo("audit", "Fewer hosts", false, "case-1"), false);
  equal(await state.sendTo("operator", "Fewer hosts", false, "case-1"), true);
  deepStrictEqual(commands, [{
    agentId: "operator",
    text: "Fewer hosts",
    expectedRevision: 7,
    caseId: "case-1",
  }]);
});

Deno.test("Request team read metadata preserves exact modeled identities and rejects malformed scope", () => {
  const value = source();
  const team = {
    parentOperatorId: "native:parent",
    requestOwnerId: "native:contact",
    requestId: "request:1",
    creationPolicyId: "policy:team",
  };
  value.conversations[1].operatorTeam = team;
  deepStrictEqual(
    parseConversationsSnapshot(value).conversations[1].operatorTeam,
    team,
  );
  equal(
    parseConversationsSnapshot(source()).conversations[1].operatorTeam,
    undefined,
  );
  for (
    const malformed of [
      null,
      [],
      {},
      { ...team, requestId: "" },
      { ...team, requestOwnerId: 2 },
      { ...team, parentOperatorId: [] },
      { ...team, creationPolicyId: false },
    ]
  ) {
    const broken = source();
    (broken.conversations[1] as unknown as Record<string, unknown>)
      .operatorTeam = malformed;
    throws(
      () => parseConversationsSnapshot(broken),
      /conversations received are unreadable/,
    );
  }
});

Deno.test("conversation parser accepts only the static initial refusal value without interpreting native diagnostics", () => {
  const value = source();
  value.conversations[0].initialExecutionOutcome = "refused";
  equal(
    parseConversationsSnapshot(value).conversations[0].initialExecutionOutcome,
    "refused",
  );
  for (const invalid of ["failed", { message: "PRIVATE" }, 1]) {
    const input = source();
    Object.assign(input.conversations[0], { initialExecutionOutcome: invalid });
    throws(() => parseConversationsSnapshot(input));
  }
});
