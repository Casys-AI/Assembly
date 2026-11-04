import {
  assertBaseForChoice,
  mainOpeningKey,
  type OpeningCommand,
  openingCommand,
  type OpeningRecord,
  type RecordedOpeningCommand,
} from "../../../domain/work/request-spaces/opening.ts";
import {
  type MainOpener,
  type SpaceControlPrincipal,
} from "../../../domain/work/request-spaces/space-control.ts";
import {
  requestSpaceDigest,
  RequestSpaceError,
} from "../../../domain/work/request-spaces/scope.ts";
import { type OpeningView, openingView } from "./opening-view.ts";
import type {
  MainOpenerAuthorityPort,
  RequestSpaceHostOptions,
} from "./ports.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import {
  mainExecutionSpace,
  sameScopedOperator,
} from "../../../domain/governance/authority.ts";
import { scopedOperator } from "../../../domain/governance/policies/delegation-scope.ts";

/** The registered Main's own authority to open (settled Q1): the
 * `open-request` act of its current admitted mandate. The space it opens
 * belongs to the system's modeled owner. */
export function mainOpenerAuthority(
  main: () => { readonly snapshot: SystemRuntimeState } | undefined,
): MainOpenerAuthorityPort {
  return {
    current(operator) {
      const model = main()?.snapshot.executionModel;
      const owner = model?.ownerAuthority;
      if (
        !model || owner?.ownerSource !== "modeled" ||
        model.mandate.mayOpenRequests !== true ||
        !sameScopedOperator(
          operator,
          scopedOperator(
            mainExecutionSpace(model.identity),
            model.identity.builderId,
          ),
        )
      ) {
        return Promise.reject(
          new RequestSpaceError(
            "FORBIDDEN",
            "The Main Operator's mandate does not cover open-request.",
            {
              context: { operatorId: operator.operatorId },
              recovery:
                "Ask the person to grant the open-request act (mayOpenRequests) in your mandate, or let them open the Request.",
            },
          ),
        );
      }
      return Promise.resolve(owner.operatorId);
    },
  };
}

/** Opening acceptance owns IDs/base/phase. Native execution remains behind the
 * runtime port and its mandatory per-effect admission guard. */
export class RequestSpaceOpenings {
  constructor(private readonly host: RequestSpaceHostOptions) {}
  async open(
    value: OpeningCommand,
    sessionSecret: string,
  ): Promise<OpeningView> {
    const command = openingCommand(value);
    const controller = await this.host.control.authenticateSession(
      sessionSecret,
    );
    return await this.#advance(
      command,
      controller,
      () => this.host.control.revalidate(controller),
    );
  }

  /** Host-internal: the registered Main opens a branch Request under the
   * `open-request` act of its own mandate (4.8d D3). No person is asked and no
   * session is created; the space belongs to the system's owner, whose current
   * control policy must admit the operator. The opening key derives from the
   * opener, so the same Main opening is the same Request. No HTTP route. */
  async openForMain(
    value: Pick<OpeningCommand, "text" | "source">,
    opener: MainOpener,
  ): Promise<OpeningView> {
    const { controller, revalidate } = await this.#mainControl(
      opener,
      () =>
        new RequestSpaceError(
          "FORBIDDEN",
          "Main Operator openings are unavailable on this host.",
          {
            context: { operatorId: opener.operator.operatorId },
            recovery: "Let the person open the Request from the Requests page.",
          },
        ),
    );
    const command: RecordedOpeningCommand = {
      ...openingCommand({
        openingKey: await mainOpeningKey(opener),
        text: value.text,
        source: value.source,
      }),
      opener: structuredClone(opener),
    };
    return await this.#advance(command, controller, revalidate);
  }

  /** Host-internal (settled Q3): the registered Main writes to the BO of an
   * open branch Request, as its own input, under the same control as an
   * opening, re-proved just before the write. */
  async writeForMain(
    caseId: string,
    written: {
      resumeId: string;
      instruction: string;
      at: string;
      operatorId?: string;
    },
    opener: MainOpener,
  ): Promise<void> {
    const unavailable = () =>
      new RequestSpaceError(
        "FORBIDDEN",
        "Main Operator messages to a Request are unavailable on this host.",
        {
          context: { caseId },
          recovery: "Ask the person to write in the Case.",
        },
      );
    if (!this.host.runtime.submitFromMain || !this.host.admissions.recorded) {
      throw unavailable();
    }
    const { controller, revalidate } = await this.#mainControl(
      opener,
      unavailable,
    );
    const record = await this.host.store.forCase(caseId);
    if (
      !record || record.ownerId !== controller.ownerId ||
      record.phase !== "dispatched"
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "This Request is not an open branch Request of this system.",
        {
          context: { caseId },
          recovery: "Use a caseId listed in requestOpening.requests.",
        },
      );
    }
    const admission = await this.host.admissions.recorded(record);
    await revalidate();
    if (
      written.operatorId &&
      written.operatorId !== record.base!.requestOwner.operatorId
    ) {
      await this.host.runtime.submitFromMain(
        record,
        written,
        admission,
        opener,
      );
    } else await this.host.runtime.submitFromMain(record, written, admission);
  }

  /** The registered Main's control of the owner's space, for an opening and
   * a write alike: the owner its `open-request` act names, a host controller
   * the owner's current policy admits, and the check re-proving both. */
  async #mainControl(
    opener: MainOpener,
    unavailable: () => RequestSpaceError,
  ): Promise<{
    controller: SpaceControlPrincipal;
    revalidate: () => Promise<void>;
  }> {
    const authority = this.host.mainOpener, control = this.host.control;
    if (!authority || !control.hostController) throw unavailable();
    const ownerId = await authority.current(opener.operator);
    const controller = await control.hostController(ownerId, opener.operator);
    return {
      controller,
      revalidate: async () => {
        await control.revalidate(controller);
        if (await authority.current(opener.operator) !== controller.ownerId) {
          throw new RequestSpaceError(
            "FORBIDDEN",
            "The Main Operator's opening authority changed.",
            {
              context: { operatorId: opener.operator.operatorId },
              recovery:
                "Retry the same call once the person restores your open-request act.",
            },
          );
        }
      },
    };
  }

  /** The one phase machine of both openers; `revalidate` re-checks the
   * opener's authority before every step. */
  async #advance(
    command: RecordedOpeningCommand,
    controller: SpaceControlPrincipal,
    revalidate: () => Promise<void>,
  ): Promise<OpeningView> {
    const commandDigest = await requestSpaceDigest({
      scope: this.host.scope,
      ownerId: controller.ownerId,
      command,
    });
    let record = await this.host.store.begin({
      ownerId: controller.ownerId,
      command,
      commandDigest,
    });
    for (let step = 0; step < 8; step++) {
      await revalidate();
      if (
        record.ownerId !== controller.ownerId ||
        record.commandDigest !== commandDigest
      ) {
        throw new RequestSpaceError(
          "OPENING_CONFLICT",
          "The opening belongs to another command or owner.",
        );
      }
      if (record.phase === "dispatched") {
        await this.host.admissions.ensure(record, controller);
        return openingView(record);
      }
      try {
        if (record.phase === "allocated") {
          const base = await this.host.source.resolve(
            record.command.source,
            controller,
          );
          assertBaseForChoice(base, record.command.source);
          await revalidate();
          record = await this.host.store.selectBase({
            id: record.id,
            ownerId: controller.ownerId,
            expectedRevision: record.revision,
            base,
            baseDigest: await requestSpaceDigest(base),
          });
          // A CAS winner can contain another concurrently resolved main version.
          // Only the recorded winner is ever verified/provisioned below.
          continue;
        }
        if (
          !record.base || !record.baseDigest ||
          await requestSpaceDigest(record.base) !== record.baseDigest
        ) {
          throw new RequestSpaceError(
            "UNAVAILABLE",
            "The recorded exact base is unavailable.",
          );
        }
        await this.host.source.verify(record.base);
        await revalidate();
        if (record.phase === "source-selected") {
          await this.host.branches.ensure(record);
          record = await this.advance(record, "branch-ready");
        } else if (record.phase === "branch-ready") {
          await this.host.branches.sourceVersion(record);
          await this.host.runtime.provision(record);
          await this.host.runtime.prepareInitialSkills(record);
          record = await this.advance(record, "runtime-ready");
        } else if (record.phase === "runtime-ready") {
          const admission = await this.host.admissions.ensure(
            record,
            controller,
          );
          record = await this.host.store.advance({
            id: record.id,
            ownerId: controller.ownerId,
            expectedRevision: record.revision,
            from: record.phase,
            to: "admitted",
            admissionId: admission.id,
          });
        } else if (record.phase === "admitted") {
          const admission = await this.host.admissions.ensure(
            record,
            controller,
          );
          if (admission.id !== record.admissionId) {
            throw new RequestSpaceError(
              "ADMISSION_REFUSED",
              "The recorded space admission differs.",
            );
          }
          await revalidate();
          await this.host.runtime.enqueue(record, admission);
          record = await this.advance(record, "dispatched");
        }
      } catch (error) {
        if (
          error instanceof RequestSpaceError &&
          ["FORBIDDEN", "OPENING_CONFLICT", "ADMISSION_REFUSED"].includes(
            error.code,
          )
        ) throw error;
        // No exception text or host path is retained. Missing assets/infrastructure
        // leave an explicit recoverable phase; same command resumes it later.
        const code = error instanceof RequestSpaceError
          ? error.code
          : "PROVISIONING_UNAVAILABLE";
        record = await this.host.store.issue({
          id: record.id,
          ownerId: controller.ownerId,
          expectedRevision: record.revision,
          code,
        });
        await revalidate();
        return openingView(record);
      }
    }
    return openingView(record);
  }
  private advance(
    record: OpeningRecord,
    to: "branch-ready" | "runtime-ready" | "dispatched",
  ) {
    return this.host.store.advance({
      id: record.id,
      ownerId: record.ownerId,
      expectedRevision: record.revision,
      from: record.phase,
      to,
    });
  }
}
