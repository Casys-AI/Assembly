/** Exercise the built Fresh handler through the same dispatcher as main.ts.
 * No listener, model, database or provider is opened by this verification. */
import { loadFreshFrontend } from "../src/infrastructure/http/frontend.ts";

const dispatch = await loadFreshFrontend();
const origin = "http://fresh-build.invalid";
const assets = new Set<string>();
const visited = new Set<string>();
function collectAssets(source: string, parent: string) {
  const pattern =
    /["']((?:\/assets\/|\.\/)[^"'\s?#]+\.(?:js|css))(?:\?[^"']*)?["']/g;
  for (const match of source.matchAll(pattern)) {
    const url = new URL(match[1]!, parent);
    if (url.origin === origin) assets.add(url.href);
  }
}

// Vite's manifest lists every emitted entry and lazy chunk. Inspect those
// actual files rather than guessing dependencies from strings in JavaScript:
// Browserify bundles such as ELK retain internal './elk-api.js' module names.
const manifest = JSON.parse(
  await Deno.readTextFile(
    new URL("../frontend/_fresh/client/.vite/manifest.json", import.meta.url),
  ),
) as Record<string, { file: string; css?: string[]; assets?: string[] }>;
for (const entry of Object.values(manifest)) {
  for (
    const file of [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]
  ) {
    if (/\.(js|css)$/.test(file)) assets.add(new URL(file, `${origin}/`).href);
  }
}

// System is /system and opens on Team (Explore is ?page=explore, Flows
// ?page=flows with the flow it reads as ?flow=, Requirements
// ?page=requirements, Parts and Allocations are in its More menu, an element a
// page opens in place is ?select=), Model is /model with /revisions as an
// address of its own, an old graph link (?revision=) lands on Model, and To
// decide is /decide.
const routes = [
  ["/", "chat"],
  ["/tools", "tools"],
  ["/system", "system"],
  ["/system?select=unit-1", "system"],
  ["/system?page=explore", "system"],
  ["/system?page=explore&select=unit-1&version=commit%3Asample", "system"],
  ["/system?page=flows", "system"],
  [
    "/system?page=flows&flow=flow-1&select=flow-1%23step-1&version=commit%3Asample",
    "system",
  ],
  ["/system?page=requirements", "system"],
  ["/system?page=parts&select=unit-1&version=commit%3Asample", "system"],
  ["/system?page=allocations", "system"],
  ["/model", "model"],
  ["/model?page=sysml", "model"],
  ["/model?page=graph", "model"],
  [
    "/model?page=sysml&view=structure%3Asample&version=commit%3Asample",
    "model",
  ],
  ["/model?revision=7", "model"],
  ["/model?commit=commit%3Asample&from=empty", "model"],
  ["/model?page=graph&revision=7", "model"],
  ["/model?page=files&file=lib%2Fa.sysml&line=3", "model"],
  ["/revisions", "model"],
  ["/revisions?commit=commit%3Asample&from=empty", "model"],
  ["/revisions?proposal=p1", "model"],
  ["/decide", "decide"],
  ["/system?select=unit-1&fresh-partial=true", "system"],
  ["/system?page=explore&select=unit-1&fresh-partial=true", "system"],
  ["/system?page=parts&select=unit-1&fresh-partial=true", "system"],
  ["/system?page=flows&flow=flow-1&fresh-partial=true", "system"],
  ["/model?revision=7&fresh-partial=true", "model"],
  ["/model?page=sysml&fresh-partial=true", "model"],
] as const;
for (const [path, view] of routes) {
  const url = new URL(path, origin);
  const response = await dispatch(new Request(url));
  if (response?.status !== 200) throw new Error(`Fresh route failed: ${path}`);
  const html = await response.text();
  if (
    !html.includes(`data-view="${view}"`) ||
    !html.includes("frsh:partial:workbench") || html.includes("<iframe")
  ) throw new Error(`Fresh workspace response is invalid: ${path}`);
  collectAssets(html, url.href);
}

if (assets.size < 3) throw new Error("Fresh emitted no complete client entry.");
for (const url of assets) {
  if (visited.has(url)) continue;
  visited.add(url);
  const response = await dispatch(new Request(url));
  if (
    response?.status !== 200 ||
    response.headers.get("content-type")?.includes("text/html")
  ) throw new Error(`Fresh asset is not served by the application: ${url}`);
  const source = await response.text();
  if (!source) throw new Error(`Empty Fresh asset: ${url}`);
  if (
    source.includes("node:module") || source.includes("__vite-browser-external")
  ) {
    throw new Error(`A browser asset contains a Node-only dependency: ${url}`);
  }
}
console.log(
  `Fresh integration verified: ${routes.length} routes, ${visited.size} client assets.`,
);
