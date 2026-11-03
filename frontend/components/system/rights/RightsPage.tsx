import { ModelContextLink } from "../../view/ModelContextLink.tsx";
import { Fragment } from "preact";
import type { MatrixFamily } from "../../../../src/domain/governance/records/authority-matrix.ts";
import { agentUnits } from "../../../lib/system/board/lookup.ts";
import type { Detail } from "../../../lib/system/board/detail.ts";
import type { AuthorityMatrix } from "../../../lib/system/rights/api.ts";
import {
  caveatsOf,
  type Family,
  markKey,
  type ReferenceRights,
  type Rights,
  rightsOf,
  said,
  SELF_APPROVAL,
} from "../../../lib/system/rights/projection.ts";
import { Icon, type IconName } from "../../view/Icon.tsx";
import { DetailPlace } from "../DetailSlot.tsx";
import { FamilyDetail } from "./RightsDetail.tsx";
import { RightsMark } from "./RightsMark.tsx";
import { RightsMatrix } from "./RightsMatrix.tsx";

/** What each family of rights is drawn with. */
const FAMILY_ICON: Readonly<Partial<Record<MatrixFamily, IconName>>> = {
  "tools": "wrench",
  "admission": "shield",
  "mandate": "key",
  "model": "file",
  "memory-skills": "archive",
  "behaviors": "arrows",
};

/** The mark of a family; one the page does not know has none of its own. */
const iconOf = (family: string): IconName | undefined =>
  Object.hasOwn(FAMILY_ICON, family)
    ? FAMILY_ICON[family as MatrixFamily]
    : undefined;

/** The units of the model as the page calls them (a unit as the team calls it, in SysML its identifier). */
const unitsOf = (detail: Detail) =>
  agentUnits(detail.index).map((unit) => ({
    qname: unit.qname,
    name: detail.nameOf(unit.id),
  }));

/** What a mark's tooltip says: the rights of the family one by one. */
const markTitle = (rights: Rights, lines: ReturnType<Rights["lines"]>) =>
  [
    ...new Set(
      lines.map((line) =>
        `${rights.columnLabel(line.column, false)}: ${said(line.mark)}`
      ),
    ),
  ].join("\n");

/**
 * A line read from another system's rights (the global Main in a Case, a
 * Branch Operator on the main system): its marks there, under this page's
 * families. It links to its own system and opens nothing here.
 */
function ReferenceGlanceLine(
  { line, families }: { line: ReferenceRights; families: readonly Family[] },
) {
  return (
    <tr class="is-main" data-actor={line.actor.id}>
      <th scope="row">
        <span class="mini" aria-hidden="true">{line.initials}</span>
        <a href={line.href} title={line.problem ?? line.about}>
          {line.actor.label}
        </a>
      </th>
      {families.map((family) => {
        const own = line.rights.families.find((entry) =>
          entry.id === family.id
        );
        const mark = own && line.rights.markIn(line.actor, own);
        if (!own || !mark) return <td key={family.id} />;
        return (
          <td
            key={family.id}
            title={markTitle(line.rights, line.rights.lines(line.actor, own))}
          >
            <RightsMark mark={mark} />
          </td>
        );
      })}
    </tr>
  );
}

/**
 * Who may do what at a glance: the actors in rows, you first, the families of
 * rights in columns, one mark where they meet. Choosing a mark opens, in a row
 * under the actor, the rights of that family one by one. A family nobody has a
 * right in is not drawn. Without the matrix yet, the actors are there with
 * nothing in their lines. In a Case, the global Main follows you; on the main
 * system, the open Cases' Branch Operators close the table.
 */
function Glance(
  { rights, detail, note, main, branches = [] }: {
    rights: Rights;
    detail: Detail;
    /** What the matrix does not tell, for the tooltip of the legend. */
    note?: string;
    main?: ReferenceRights;
    branches?: readonly ReferenceRights[];
  },
) {
  const { actors } = rights;
  const families = rights.families.filter((family) =>
    actors.some((actor) => rights.markIn(actor, family))
  );
  return (
    <>
      <div class="detail-table">
        <div class="matrix-scroll">
          <table class="glance">
            <thead>
              <tr>
                <th />
                {families.map((family) => (
                  <th key={family.id} scope="col" title={family.label}>
                    {iconOf(family.id) && <Icon name={iconOf(family.id)!} />}
                    <span>{family.short}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {actors.map((actor) => {
                // The family the address opens, if the actor holds anything in it.
                const open = families.find((family) =>
                  detail.choice === markKey(actor.id, family.id) &&
                  rights.markIn(actor, family)
                );
                return (
                  <Fragment key={actor.id}>
                    <tr data-actor={actor.id}>
                      <th scope="row">
                        <span class={`mini${actor.you ? " you" : ""}`}>
                          <Icon name={actor.you ? "person" : "spark"} />
                        </span>
                        {actor.label}
                      </th>
                      {families.map((family) => {
                        const mark = rights.markIn(actor, family);
                        if (!mark) return <td key={family.id} />;
                        const key = markKey(actor.id, family.id);
                        const on = detail.choice === key;
                        return (
                          <td key={family.id} class={on ? "act on" : "act"}>
                            <ModelContextLink
                              class="mark-link"
                              href={detail.toggle([key])}
                              title={markTitle(
                                rights,
                                rights.lines(actor, family),
                              )}
                              aria-label={`${actor.label}, ${family.label}: ${
                                said(mark)
                              }`}
                              aria-current={on ? "true" : "false"}
                              data-mark={key}
                            >
                              <RightsMark mark={mark} />
                              {rights.flagged(actor, family) && (
                                <span
                                  class="flag"
                                  role="img"
                                  aria-label={SELF_APPROVAL}
                                  title={SELF_APPROVAL}
                                />
                              )}
                            </ModelContextLink>
                          </td>
                        );
                      })}
                    </tr>
                    {open && (
                      <DetailPlace as="row" span={families.length + 1}>
                        <FamilyDetail
                          key={markKey(actor.id, open.id)}
                          actor={actor}
                          family={open}
                          rights={rights}
                          detail={detail}
                        />
                      </DetailPlace>
                    )}
                    {actor.you && main && (
                      <ReferenceGlanceLine line={main} families={families} />
                    )}
                  </Fragment>
                );
              })}
              {branches.map((line) => (
                <ReferenceGlanceLine
                  key={line.actor.id}
                  line={line}
                  families={families}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {families.length > 0 && (
        <div class="legend" title={note}>
          <span>
            <RightsMark mark={{ kind: "full", unusable: false }} />
            alone
          </span>
          <span>
            <RightsMark mark={{ kind: "half", unusable: false }} />
            proposes
          </span>
          <span>
            <RightsMark mark={{ kind: "empty", unusable: false }} />
            no
          </span>
          <span>
            <RightsMark mark={{ kind: "empty", unusable: true }} />
            granted, unusable
          </span>
          <span>
            <RightsMark mark={{ kind: "lock", unusable: false }} />
            never
          </span>
          {actors.some((actor) => actor.selfApproves) && (
            <span>
              <span class="flag" aria-hidden="true" />
              approves its own tools
            </span>
          )}
        </div>
      )}
    </>
  );
}

/**
 * System > Rights: who may do what, as the version of the model shown above
 * declares it. The readable page is the glance; in SysML's words it is the
 * whole matrix. The matrix is read apart from the board and is slow the first
 * time, so the page draws the actors without it and the place tells it is
 * reading. The page says plainly which version the rights are of (and that the
 * proposals waiting are not counted); the rest the matrix does not tell is in
 * the tooltip of the legend. In a Case, the global Main's rights on the main
 * system are drawn beside the Case's own; on the main system, each open
 * Case's Branch Operator with its rights in its branch. Both are read apart.
 */
export function RightsPage(
  { detail, matrix, main, branches }: {
    detail: Detail;
    matrix?: AuthorityMatrix;
    main?: ReferenceRights;
    branches?: readonly ReferenceRights[];
  },
) {
  const rights = rightsOf(matrix, unitsOf(detail));
  const { version, note } = caveatsOf(matrix);
  return (
    <div class="rights">
      {detail.sysml && matrix
        ? (
          <RightsMatrix
            rights={rights}
            detail={detail}
            note={note}
            main={main}
            branches={branches}
          />
        )
        : (
          <Glance
            rights={rights}
            detail={detail}
            note={note}
            main={main}
            branches={branches}
          />
        )}
      <p class="rights-caveats">{version}</p>
    </div>
  );
}
