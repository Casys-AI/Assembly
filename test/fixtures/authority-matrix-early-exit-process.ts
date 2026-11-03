/** Stand-in for a projection child that cannot start (module graph or permission
 * error, bad flag, killed at startup): it reports on stderr and exits without
 * ever reading its input. */
console.error("FATAL: module graph failed to load (simulated import error)");
Deno.exit(3);
