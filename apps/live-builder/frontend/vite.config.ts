import { readAssemblyEnv } from "../src/infrastructure/environment.ts";
import { fresh } from "@fresh/plugin-vite";
import type { IncomingMessage } from "node:http";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig, type HttpProxy, searchForWorkspaceRoot } from "vite";

export default defineConfig(({ command }) => {
  const backendPaths = /^\/(api\/|health(?:\?|$)|favicon\.ico(?:\?|$))/;
  let backendProxy: HttpProxy.ProxyServer | undefined;
  const backend = new URL(
    readAssemblyEnv("ASSEMBLY_BACKEND_URL") ??
      "http://127.0.0.1:4311",
  );
  const require = createRequire(import.meta.url);
  const frontendRoot = fileURLToPath(new URL(".", import.meta.url));
  const elkEntries = new Set([
    require.resolve("elkjs/lib/elk-api.js"),
    require.resolve("elkjs/lib/elk-worker.min.js"),
  ]);

  return {
    // Keep frontend builds independent of the backend's provider environment.
    envDir: import.meta.dirname,
    cacheDir: "node_modules/.vite",
    plugins: [
      {
        name: "atelier:dev-api",
        apply: "serve",
        enforce: "pre",
        configureServer(server) {
          // Fresh 1.1.2 handles even unknown routes before Vite's proxy middleware.
          // Use Vite's configured streaming proxy ahead of Fresh instead.
          server.middlewares.use((request: IncomingMessage, response, next) => {
            if (!backendPaths.test(request.url ?? "")) return next();
            if (!backendProxy) {
              return next(new Error("Backend proxy not ready"));
            }
            // This hook precedes Vite's normal middleware, including its Host
            // guard. Validate the listening authority before proxy Host routing.
            const address = server.httpServer?.address();
            const port = typeof address === "object" && address
              ? address.port
              : 0;
            if (
              !port ||
              ![`127.0.0.1:${port}`, `localhost:${port}`].includes(
                request.headers.host ?? "",
              )
            ) {
              response.statusCode = 403;
              response.end("Local development host refused.");
              return;
            }
            backendProxy.web(request, response);
          });
        },
      },
      {
        name: "atelier:elk-browserify",
        enforce: "pre",
        transform(code, id) {
          if (!elkEntries.has(id.split("?")[0])) return;
          // These two pinned browser entries already contain their own module
          // loader. Fresh's generic CJS bridge otherwise mistakes Browserify's
          // internal require('./elk-api.js') for a dependency on this same file.
          // A static ESM wrapper preserves the vendor loader and tells Fresh
          // not to rewrite it. No browser eval or Node fallback is involved.
          return {
            code:
              `const module = { exports: {} }; const exports = module.exports;\n${code}\nexport default module.exports;`,
            map: null,
          };
        },
      },
      fresh(),
    ],
    // Honor the pinned CJS entry in dev: the package's ESM entry has incompatible
    // Hogan interop. Match exactly to keep diff2html/css intact.
    resolve: {
      alias: [
        ...(command === "serve"
          ? [{
            find: /^diff2html$/,
            replacement: require.resolve("diff2html"),
          }]
          : []),
        // Pin the browser entries handled by atelier:elk-browserify in both
        // development and production before Fresh's generic CJS transform.
        {
          find: /^elkjs\/lib\/elk-api\.js$/,
          replacement: require.resolve("elkjs/lib/elk-api.js"),
        },
        {
          find: /^elkjs\/lib\/elk-worker\.min\.js$/,
          replacement: require.resolve("elkjs/lib/elk-worker.min.js"),
        },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      fs: {
        strict: true,
        // A checkout can reuse an installed dependency tree through a symlink.
        // Allow that resolved tree without opening the surrounding worktrees.
        allow: [
          searchForWorkspaceRoot(frontendRoot),
          realpathSync(new URL("./node_modules", import.meta.url)),
        ],
        deny: [
          ".env",
          ".env.*",
          "*.{crt,pem}",
          "**/.git/**",
          "**/.data/**",
          "**/vite.config.ts",
        ],
      },
      proxy: {
        [backendPaths.source]: {
          target: backend.origin,
          // Preserve the browser's Host and Origin. The backend alone applies
          // its runtime development/production policy.
          changeOrigin: false,
          configure(proxy) {
            backendProxy = proxy;
          },
        },
      },
    },
  };
});
