import { useState } from "preact/hooks";
import { useRevisionLocationRefresh } from "./location.ts";
import type { RevisionLocation } from "./api.ts";
import { probeRoot } from "../../../test/support/hook-probe.ts";
function assert(value: unknown, message = "Assertion failed"): void {
  if (!value) throw new Error(message);
}

Deno.test("revision navigation refreshes new targets once and cleans up requests", async () => {
  // The probe renders no nodes: only Preact's real hook lifecycle is exercised.
  const probe = probeRoot();
  let available = ["existing"];
  let loaded: string[] = [];
  let publish: (snapshot: string[]) => void = () => {};
  let controller: AbortController | undefined;
  const requests: AbortSignal[] = [];
  const refresh = () => {
    controller = new AbortController();
    requests.push(controller.signal);
    publish([...available]);
  };
  const cancel = () => controller?.abort();
  function Probe({ location, revisionKey }: {
    location: RevisionLocation;
    revisionKey: number;
  }) {
    const [snapshot, setSnapshot] = useState<string[]>([]);
    loaded = snapshot;
    publish = setSnapshot;
    useRevisionLocationRefresh(location, revisionKey, refresh, cancel);
    return null;
  }
  const navigate = (search: string, pathname = "/model", revisionKey = 1) =>
    probe.show(Probe, { location: { pathname, search }, revisionKey });
  try {
    await navigate("?proposal=existing");
    assert(requests.length === 1);
    assert(loaded.join() === "existing");

    available = ["existing", "created-elsewhere"];
    await navigate("?proposal=created-elsewhere");
    assert(requests.length === 2);
    assert(loaded.includes("created-elsewhere"));
    assert(requests[0].aborted);
    assert(!requests[1].aborted);

    await navigate("?proposal=created-elsewhere&from=commit%3Aolder");
    await navigate("?from=commit%3Aolder&proposal=created-elsewhere");
    assert(
      requests.length === 2,
      "comparison changes must not reload the list",
    );
    assert(!requests[1].aborted);

    await navigate("?proposal=missing");
    await navigate("?proposal=missing");
    assert(requests.length === 3, "a still-missing target must not loop");
    assert(!loaded.includes("missing"));
    assert(requests[1].aborted);

    await navigate("?commit=missing");
    assert(requests.length === 4, "target kind is part of the inspection");
    await navigate("?commit=missing", "/model", 2);
    assert(requests.length === 5, "model changes must still refresh");

    await navigate("?proposal=hidden", "/chat");
    assert(requests.length === 5, "hidden revisions must not request data");
    assert(requests[4].aborted);
    await navigate("?proposal=created-elsewhere");
    assert(requests.length === 6);
    assert(!requests[5].aborted);
    // The place's earlier address is the place: it reads its target too.
    await navigate("?proposal=created-elsewhere", "/revisions");
    assert(
      requests.length === 7,
      "/revisions is an address of the Model place",
    );
    assert(!requests[6].aborted);
    await probe.unmount();
    assert(requests.every((signal) => signal.aborted));
  } finally {
    await probe.restore();
  }
});
