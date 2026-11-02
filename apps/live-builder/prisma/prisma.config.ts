import { defineConfig, env } from "prisma/config";

// Schema administration uses an explicitly supplied direct connection. Runtime
// credentials are separate and are never printed or written by these tools.
export default defineConfig({
  schema: "./schema.prisma",
  migrations: { path: "./migrations" },
  datasource: { url: env("ASSEMBLY_DATABASE_DIRECT_URL") },
});
