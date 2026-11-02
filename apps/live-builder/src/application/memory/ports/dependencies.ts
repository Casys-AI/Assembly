import type { ClockPort } from "../../work/runtime/ports.ts";
import type { MemoryProvenancePort } from "./provenance.ts";
import type { MemoryStorePort } from "./store.ts";

export interface GovernedMemoryPorts extends ClockPort {
  store: MemoryStorePort;
  provenance: MemoryProvenancePort;
}
