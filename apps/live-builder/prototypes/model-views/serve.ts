const dir = new URL("./dist/", import.meta.url).pathname;
Deno.serve({ port: 5310, hostname: "127.0.0.1" }, async (request) => {
  const name = new URL(request.url).pathname.slice(1) || "index.html";
  if (!/^[a-z0-9.-]+\.html$/.test(name)) return new Response("Not found", { status: 404 });
  try {
    return new Response(await Deno.readFile(`${dir}${name}`), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  } catch { return new Response("Not found", { status: 404 }); }
});
