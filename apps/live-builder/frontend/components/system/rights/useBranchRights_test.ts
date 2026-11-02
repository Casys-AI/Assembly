import { deepEqual, equal } from "node:assert/strict";
import { act } from "preact/test-utils";
import { probeRoot } from "../../../test/support/hook-probe.ts";
import { ownerModeled } from "../../../test/support/matrix-fixture.ts";
import type { AuthorityMatrix } from "../../../lib/system/rights/api.ts";
import type { SystemPage } from "../../../lib/workbench/desk.ts";
import {
  type BranchMatrix,
  type BranchMatrixReader,
  type BranchVersion,
  useBranchRights,
} from "./useBranchRights.ts";

/** A reader whose reads the test settles one by one, in the order asked. */
function heldReader() {
  const asked: string[] = [];
  const pending: Array<{
    resolve(matrix: AuthorityMatrix): void;
    reject(error: Error): void;
  }> = [];
  const reader: BranchMatrixReader = {
    read(caseId, version, signal) {
      asked.push(`${caseId}@${version}`);
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    },
  };
  return { reader, asked, pending };
}

interface Props {
  page: SystemPage;
  branches: readonly BranchVersion[];
  reader: BranchMatrixReader;
  timeoutMs?: number;
  seen: { held?: ReadonlyMap<string, BranchMatrix> };
}

function Probe(props: Props) {
  props.seen.held = useBranchRights(
    props.page,
    props.branches,
    props.reader,
    props.timeoutMs,
  );
  return null;
}

/** Settles one held read, then lets the hook draw what it read. */
const settle = (step: () => void) =>
  act(async () => {
    step();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const show = (probe: ReturnType<typeof probeRoot>, props: Props) =>
  probe.show(Probe, props);

const statuses = (seen: Props["seen"]) =>
  [...(seen.held ?? new Map()).entries()].map(([id, value]) =>
    `${id}:${value.status}`
  );

const at = (caseId: string, version?: string): BranchVersion => ({
  caseId,
  version,
});

Deno.test("Rights reads the open Cases' matrices one after another, each shown as soon as it is read", async () => {
  const probe = probeRoot();
  try {
    const { reader, asked, pending } = heldReader();
    const seen: Props["seen"] = {};
    await show(probe, {
      page: "rights",
      branches: [at("a", "v1"), at("b", "v1"), at("c", "v1")],
      reader,
      seen,
    });
    // One read at a time: the projection worker has a single lane.
    deepEqual(asked, ["a@v1"]);
    deepEqual(statuses(seen), ["a:reading", "b:reading", "c:reading"]);
    await settle(() => pending[0].resolve(ownerModeled()));
    deepEqual(asked, ["a@v1", "b@v1"]);
    deepEqual(statuses(seen), ["a:read", "b:reading", "c:reading"]);
    // A failed Case does not stop the ones after it.
    await settle(() => pending[1].reject(new Error("queue full")));
    deepEqual(asked, ["a@v1", "b@v1", "c@v1"]);
    deepEqual(statuses(seen), ["a:read", "b:failed", "c:reading"]);
    await settle(() => pending[2].resolve(ownerModeled()));
    deepEqual(statuses(seen), ["a:read", "b:failed", "c:read"]);
  } finally {
    await probe.restore();
  }
});

Deno.test("a read that does not answer in time fails and lets the next Case be read", async () => {
  const probe = probeRoot();
  try {
    const { reader, asked, pending } = heldReader();
    const seen: Props["seen"] = {};
    await show(probe, {
      page: "rights",
      branches: [at("a", "v1"), at("b", "v1")],
      reader,
      timeoutMs: 40,
      seen,
    });
    // "a" never answers: past its 40 ms it fails and "b" is asked.
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    deepEqual(asked, ["a@v1", "b@v1"]);
    equal(seen.held?.get("a")?.status, "failed");
    await settle(() => pending[1].resolve(ownerModeled()));
    equal(seen.held?.get("b")?.status, "read");
  } finally {
    await probe.restore();
  }
});

Deno.test("a Case that runs a new version is read again, keeping its line meanwhile; an unchanged one is not", async () => {
  const probe = probeRoot();
  try {
    const { reader, asked, pending } = heldReader();
    const seen: Props["seen"] = {};
    const props = (branches: readonly BranchVersion[]): Props => ({
      page: "rights",
      branches,
      reader,
      seen,
    });
    await show(probe, props([at("a", "v1"), at("b", "v1")]));
    await settle(() => pending[0].resolve(ownerModeled()));
    await settle(() => pending[1].resolve(ownerModeled()));
    deepEqual(asked, ["a@v1", "b@v1"]);
    // Its scope is read again after an adoption: the line keeps what it shows.
    await show(probe, props([at("a"), at("b", "v1")]));
    deepEqual(asked, ["a@v1", "b@v1"]);
    equal(seen.held?.get("a")?.status, "read");
    // A new version is read again, the old matrix shown until it answers.
    await show(probe, props([at("a", "v2"), at("b", "v1")]));
    deepEqual(asked, ["a@v1", "b@v1", "a@v2"]);
    equal(seen.held?.get("a")?.status, "read");
    equal(seen.held?.get("a")?.version, "v1");
    await settle(() => pending[2].resolve(ownerModeled()));
    equal(seen.held?.get("a")?.version, "v2");
  } finally {
    await probe.restore();
  }
});

Deno.test("leaving Rights stops the remaining reads", async () => {
  const probe = probeRoot();
  try {
    const { reader, asked, pending } = heldReader();
    const seen: Props["seen"] = {};
    await show(probe, {
      page: "rights",
      branches: [at("a", "v1"), at("b", "v1")],
      reader,
      seen,
    });
    await show(probe, {
      page: "team",
      branches: [at("a", "v1"), at("b", "v1")],
      reader,
      seen,
    });
    await settle(() => pending[0].resolve(ownerModeled()));
    deepEqual(asked, ["a@v1"]);
    deepEqual(statuses(seen), ["a:reading", "b:reading"]);
  } finally {
    await probe.restore();
  }
});
