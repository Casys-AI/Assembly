import { assertScopedSoftwareAdmissionEvidence } from "../source-admission/scoped-software-source-admission.ts";
import { parseScopedSoftwareDossier } from "../evolution/scoped-software-dossier.ts";
import { parseScopedSoftwareWriteDossier } from "./scoped-software-write.ts";
import type { ScopedSoftwareSourcePublicationContext } from "./ports/out/scoped-software-source-publication.port.ts";

/** Own caller data before awaiting; shape/digests confer no Git proof or rights. */
export async function parseScopedSoftwareSourcePublicationContext(
  value: ScopedSoftwareSourcePublicationContext,
): Promise<ScopedSoftwareSourcePublicationContext> {
  const owned = structuredClone(value);
  const dossier = await parseScopedSoftwareWriteDossier(owned.dossier);
  const evolution = await parseScopedSoftwareDossier(owned.evolution);
  const admission = await assertScopedSoftwareAdmissionEvidence(
    owned.admission,
    dossier,
    evolution,
  );
  return { dossier, admission, evolution };
}
