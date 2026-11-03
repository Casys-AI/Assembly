import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
} from "node:assert/strict";
import type { VNode } from "preact";
import { renderToString } from "preact-render-to-string";
import {
  initialBoard,
  watchBoard,
} from "../../../test/support/board-fixture.ts";
import { probeRoot } from "../../../test/support/hook-probe.ts";
import { layoutTeam } from "../../../lib/system/team/layout.ts";
import { teamOf } from "../../../lib/system/team/projection.ts";
import { TeamNetwork } from "./TeamNetwork.tsx";

const team = teamOf(watchBoard());
const [first, second] = team.agents.map((agent) => agent.id);

/**
 * The network's own hooks, run for real: the page is called as the function it
 * is inside a probe, whose hooks it then uses, and the markup it returns is
 * kept to be read. (The app has no DOM to mount a page into, and the precompiled
 * JSX of a page is only drawn by the server renderer.)
 */
function mount() {
  const widths: number[] = [];
  let shown: VNode | undefined;
  const simulate: typeof layoutTeam = (nodes, edges, width) => {
    widths.push(width ?? -1);
    return layoutTeam(nodes, edges, width);
  };
  function Probe(
    props: { team: typeof team; selected: string; hrefOf(id: string): string },
  ) {
    shown = TeamNetwork({ ...props, layout: simulate });
    return null;
  }
  return {
    widths,
    Probe,
    html: () => renderToString(shown!),
  };
}

const links = (version: string) => (id: string) =>
  `/system?select=${id}&version=${version}`;

Deno.test("choosing another agent draws the network again, with other links, and does not run the simulation again", async () => {
  const probe = probeRoot();
  const network = mount();
  try {
    await probe.show(network.Probe, {
      team,
      selected: first,
      hrefOf: links("a"),
    });
    deepStrictEqual(network.widths, [1056]);
    const before = network.html();
    match(before, new RegExp(`is-picked[^>]*data-agent="${first}"`));
    doesNotMatch(before, new RegExp(`is-picked[^>]*data-agent="${second}"`));

    // Another agent is chosen: the page draws again with a new function for its links.
    await probe.show(network.Probe, {
      team,
      selected: second,
      hrefOf: links("b"),
    });
    await probe.show(network.Probe, {
      team,
      selected: first,
      hrefOf: links("c"),
    });
    await probe.show(network.Probe, {
      team,
      selected: second,
      hrefOf: links("d"),
    });
    equal(
      network.widths.length,
      1,
      "selecting never runs the simulation again",
    );
    const after = network.html();
    match(after, new RegExp(`is-picked[^>]*data-agent="${second}"`));
    match(after, /version=d/);
    // Every node is where it was: the markup differs only in the choice and the links.
    const places = (html: string) =>
      [...html.matchAll(/transform:translate\([^)]*\)/g)].map(([place]) =>
        place
      );
    deepStrictEqual(places(after), places(before));
    equal(places(before).length > 3, true);
  } finally {
    await probe.restore();
  }
});

Deno.test("another team is another layout, and a team built again from the same board is not", async () => {
  const probe = probeRoot();
  const network = mount();
  try {
    await probe.show(network.Probe, {
      team,
      selected: first,
      hrefOf: links("a"),
    });
    // The page drew its team again from the same board (the roster moved).
    const again = teamOf(watchBoard());
    await probe.show(network.Probe, {
      team: again,
      selected: first,
      hrefOf: links("a"),
    });
    equal(network.widths.length, 1);
    // A team that is another one.
    const other = teamOf(initialBoard());
    await probe.show(network.Probe, {
      team: other,
      selected: other.agents[0].id,
      hrefOf: links("a"),
    });
    equal(network.widths.length, 2);
    doesNotMatch(network.html(), new RegExp(`data-agent="${first}"`));
    match(network.html(), new RegExp(`data-agent="${other.agents[0].id}"`));
  } finally {
    await probe.restore();
  }
});
