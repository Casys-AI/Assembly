import type { ModelPort } from "../runtime/ports.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { SystemConfiguration } from "../../../domain/governance/records/system-configuration.ts";
import type { ModelIdentity } from "../../../domain/shared-kernel/model-identity.ts";
import {
  exactSourceVersion,
  type OpeningBase,
  type OpeningRecord,
  RequestSpaceError,
  type VerifiedRequestTeam,
} from "../../../domain/work/request-spaces.ts";
import { creationReceiptVerifies } from "../../../domain/governance/policies/operator-creation-policy.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { assertRequestChange } from "../../../domain/governance/records/request-change.ts";

/** Immutable creation images from the verified Request adoption journal.
 * Current execution models remain separately bound to their own admitted pins. */
export type RequestTeamCreationModelReader = (
  record: OpeningRecord,
  operatorIds: readonly string[],
) => Promise<ReadonlyMap<string, ExecutableModel>>;

export function requestTeamCreationReceiptVerifies(
  models: readonly ExecutableModel[],
  child: ExecutableModel,
  scope: Parameters<typeof creationReceiptVerifies>[2],
  parentChanges: Parameters<typeof creationReceiptVerifies>[3],
  births: ReadonlyMap<string, ExecutableModel>,
): boolean {
  const born = births.get(child.identity.builderId);
  if (!born) {
    return creationReceiptVerifies(models, child, scope, parentChanges);
  }
  if (
    canonical(born.identity) !== canonical(child.identity) ||
    canonical(born.operatorTeam) !== canonical(child.operatorTeam)
  ) return false;
  // Only the child is historical. The existing verifier anchors its parent's
  // recorded grant to the published policy slot, even after grant withdrawal.
  return creationReceiptVerifies(
    models.map((model) => model === child ? born : model),
    born,
    scope,
    parentChanges,
  );
}

/** Exact in-memory execution view, supplied only after readModels(base).
 * Source qualification and current execution authority remain separate gates.
 * Native source identities are never rewritten to operational Case/space IDs.
 */
export class RequestSpaceModel implements ModelPort {
  readonly #model: ExecutableModel;
  readonly requestChangeScope?: ModelPort["requestChangeScope"];
  readonly #networkChangePreview?: ModelPort["previewApprovedChange"];

  constructor(
    input:
      & {
        base: OpeningBase;
        networkChangePreview?: ModelPort["previewApprovedChange"];
        model: ExecutableModel;
        /** Server-verified current execution pin; the immutable base still fixes identity. */
        executionPin?: { modelDigest: string; source: { version: string } };
        /** A verified branch-team member is not in the birth manifest: its
         * admitted digest (from the space admission) at the pin's source
         * version fixes its exact model (4.8e E3/E4). */
        teamPin?: { modelDigest: string; repositoryVersion: string };
      }
      & (
        | {
          requestTeam?: undefined;
          executionSpaceId?: undefined;
        }
        | {
          /** Verified Case roster and its branch space for creation reads. */
          executionSpaceId: string;
          requestTeam: VerifiedRequestTeam;
        }
      ),
  ) {
    const { base, model } = structuredClone({
      base: input.base,
      model: input.model,
    });
    const version = input.teamPin?.repositoryVersion ??
      input.executionPin?.source.version ??
      base.manifest.source?.sourceVersion;
    const operatorId = model.identity.builderId;
    const selected = base.manifest.operators.filter((entry) =>
      entry.operatorId === operatorId
    );
    if (
      input.teamPin === undefined && (
        selected.length !== 1 ||
        base.manifest.registeredOperatorIds.filter((id) => id === operatorId)
            .length !== 1
      )
    ) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The exact base has no unique registered entry for this operator.",
      );
    }
    const entry = selected[0];
    if (
      entry && (
        entry.nativeSystemId !== undefined &&
          entry.nativeSystemId !== model.identity.systemId ||
        entry.systemQualifiedName !== undefined &&
          model.identity.systemQualifiedName !== undefined &&
          entry.systemQualifiedName !== model.identity.systemQualifiedName
      )
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "The model's native identity differs from the retained operator.",
      );
    }
    if (
      !exactSourceVersion(version) ||
      (!input.executionPin && entry && entry.repositoryVersion !== version) ||
      model.version.repositoryVersion !== version ||
      !(input.teamPin?.modelDigest ?? entry?.modelDigest) ||
      (input.teamPin?.modelDigest ?? input.executionPin?.modelDigest ??
          entry?.modelDigest) !==
        model.version.digest
    ) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The model digest or repository version differs from the exact base.",
      );
    }
    this.#model = model;
    if (input.requestTeam !== undefined) {
      this.requestChangeScope = {
        caseId: input.requestTeam.caseId,
        operatorId: model.identity.builderId,
        executionSpaceId: input.executionSpaceId,
        branchTeamSize: input.requestTeam.memberIds.length,
        memberIds: input.requestTeam.memberIds,
      };
    }
    this.#networkChangePreview = input.networkChangePreview;
  }

  #assertIdentity(identity: ModelIdentity): void {
    if (canonical(identity) !== canonical(this.#model.identity)) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "This exact model cannot serve another native identity.",
      );
    }
  }

  readExecutableModel(
    identity: ModelIdentity,
    repositoryVersion?: string,
  ): Promise<ExecutableModel> {
    try {
      this.#assertIdentity(identity);
      if (
        repositoryVersion !== undefined &&
        repositoryVersion !== this.#model.version.repositoryVersion
      ) {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "This Request retains a different exact repository version.",
        );
      }
      return Promise.resolve(structuredClone(this.#model));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  initialize(
    existing?: ModelIdentity,
    configuration?: SystemConfiguration,
  ): Promise<ModelIdentity> {
    try {
      if (existing !== undefined) this.#assertIdentity(existing);
      if (
        configuration !== undefined &&
        canonical(configuration) !== canonical(this.#model.configuration)
      ) {
        throw new RequestSpaceError(
          "FORBIDDEN",
          "An exact Request model cannot apply another configuration.",
        );
      }
      return Promise.resolve(structuredClone(this.#model.identity));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async previewApprovedChange(
    ...args: Parameters<ModelPort["previewApprovedChange"]>
  ): ReturnType<ModelPort["previewApprovedChange"]> {
    const [identity, change, expectedDigest] = structuredClone(args);
    this.#assertIdentity(identity);
    if (!this.requestChangeScope || !this.#networkChangePreview) {
      return await this.#readOnly();
    }
    assertRequestChange(change);
    if (
      change.caseId !== this.requestChangeScope.caseId ||
      change.requestedBy !== this.requestChangeScope.operatorId ||
      expectedDigest !== this.#model.version.digest ||
      change.baseModelDigest !== expectedDigest ||
      change.baseRevision !== this.#model.configuration.revision
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "The Case proposal differs from its exact executing owner",
      );
    }
    return await this.#networkChangePreview(identity, change, expectedDigest);
  }

  applyApprovedChange(
    ..._args: Parameters<ModelPort["applyApprovedChange"]>
  ): ReturnType<ModelPort["applyApprovedChange"]> {
    return this.#readOnly();
  }

  proposeEdit(
    ..._args: Parameters<ModelPort["proposeEdit"]>
  ): ReturnType<ModelPort["proposeEdit"]> {
    return this.#readOnly();
  }

  activateCandidate(
    ..._args: Parameters<ModelPort["activateCandidate"]>
  ): ReturnType<ModelPort["activateCandidate"]> {
    return this.#readOnly();
  }

  graph(_identity: ModelIdentity): Promise<unknown> {
    return Promise.reject(
      new RequestSpaceError(
        "UNAVAILABLE",
        "The retained executable model does not supply its exact source graph.",
      ),
    );
  }

  #readOnly(): Promise<never> {
    return Promise.reject(
      new RequestSpaceError("FORBIDDEN", "This Request model is read-only."),
    );
  }
}
