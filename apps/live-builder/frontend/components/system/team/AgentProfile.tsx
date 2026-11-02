import type { ComponentChildren } from "preact";
import type {
  CandidateRead,
  HasToolChip,
} from "../../../lib/system/tools/candidates.ts";
import { ToolCandidateChip } from "../ToolCandidateChip.tsx";
import { monogram } from "../../../lib/workbench/desk.ts";
import type { ToolServer } from "../../../lib/system/tools/servers.ts";
import type {
  AgentProfile as Profile,
  ProfileSection,
  ProfileStat,
  TeamAgent,
} from "../../../lib/system/team/projection.ts";
import { Icon, type IconName } from "../../view/Icon.tsx";

/** What the agent is to the person, in a few words; none when nothing says. */
export function contactLine(agent: TeamAgent): string | null {
  const contact = agent.contact === "direct"
    ? "Talks with you"
    : agent.contact === "indirect"
    ? "Not in direct contact with you"
    : null;
  return [contact, agent.busy ? "working now" : null].filter(Boolean).join(
    " · ",
  ) || null;
}

function Stats({ stats }: { stats: readonly ProfileStat[] }) {
  return stats.length > 0
    ? (
      <div class="stats">
        {stats.map((stat) => (
          <div key={stat.id} class="stat" title={stat.label}>
            <b>{stat.value}</b>
            <span>{stat.label}</span>
          </div>
        ))}
      </div>
    )
    : null;
}

function Row(
  { label, children }: { label: string; children: ComponentChildren },
) {
  return (
    <div class="ctx-row">
      <span class="fl">{label}</span>
      {children}
    </div>
  );
}

/** One thing the agent has, a skill or a tool; the model's summary is its tooltip. */
function Chips(
  { chips }: { chips: readonly { id: string; text: string; title?: string }[] },
) {
  return (
    <>
      {chips.map((chip) => (
        <span key={chip.id} class="chip" title={chip.title}>{chip.text}</span>
      ))}
    </>
  );
}

function Section(
  { icon, title, children }: {
    icon: IconName;
    title: string;
    children: ComponentChildren;
  },
) {
  return (
    <section class="ctx-sec" data-section={title}>
      <div class="ctx-head">
        <Icon name={icon} />
        <h3>{title}</h3>
      </div>
      {children}
    </section>
  );
}

/** A section the model declares nothing for stays a dashed line that says so. */
function Declared(
  { icon, title, none, section, extra, things }: {
    icon: IconName;
    title: string;
    none: string;
    section: ProfileSection;
    extra?: ComponentChildren;
    things?: ComponentChildren;
  },
) {
  if (section.blank) {
    return (
      <section class="ctx-sec is-blank" data-section={title}>
        <div class="ctx-head">
          <Icon name={icon} />
          <h3>{title}</h3>
        </div>
        <div class="faint">{none}</div>
      </section>
    );
  }
  return (
    <Section icon={icon} title={title}>
      <Stats stats={section.stats} />
      {things ?? (section.things.length > 0 && (
        <Row label="Has">
          <Chips chips={section.things} />
        </Row>
      ))}
      {extra}
      {section.rules.length > 0 && (
        <Row label="Rules">
          {section.rules.map((rule) => (
            <span key={rule.id} class="rule">{rule.text}</span>
          ))}
        </Row>
      )}
    </Section>
  );
}

/**
 * One agent, as the model declares it: its context, tools and skills, memory,
 * mandate, and the flows it performs. Read-only; what the agent holds in the
 * runtime (its tool servers) comes beside what the model says, never in its
 * place. A part the model leaves out says so.
 */
export function AgentProfile(
  { agent, profile, servers, runtime, toolChips, toolStatus }: {
    agent: TeamAgent;
    profile: Profile;
    runtime?: CandidateRead;
    toolChips?: readonly HasToolChip[];
    toolStatus?: string;
    /** The tools the agent has in the runtime, by server; none when unknown. */
    servers?: readonly ToolServer[];
  },
) {
  const line = contactLine(agent);
  const { mandate } = profile;
  return (
    <article class="profile" aria-label={agent.name} data-agent={agent.id}>
      <header class="profile-head">
        <span class="tavatar is-big" aria-hidden="true">
          {monogram(agent.name)}
        </span>
        <div>
          <h2 title={agent.qname ?? undefined}>{agent.name}</h2>
          {line && <div class="faint">{line}</div>}
        </div>
      </header>
      <div class="ctx">
        <Declared
          icon="eye"
          title="Context"
          none="No context policy declared"
          section={profile.context}
        />
        <Declared
          icon="wrench"
          title="Tools & skills"
          none="No tool or skill declared"
          section={{
            ...profile.tools,
            blank: profile.tools.blank && !servers?.length &&
              !toolChips?.length && !toolStatus,
          }}
          things={runtime && toolChips && toolChips.length > 0
            ? (
              <Row label="Has">
                {toolChips.map(({ chip, candidates }, at) =>
                  candidates.length === 0
                    ? <Chips key={chip?.id ?? at} chips={chip ? [chip] : []} />
                    : candidates.length === 1
                    ? (
                      <ToolCandidateChip
                        key={JSON.stringify([
                          candidates[0].agentId,
                          candidates[0].candidate.id,
                        ])}
                        tool={candidates[0]}
                        read={runtime}
                        label={chip?.text}
                      />
                    )
                    : (
                      <span class="tool-candidate-group" key={chip?.id ?? at}>
                        {chip?.text}
                        {candidates.map((tool) => (
                          <ToolCandidateChip
                            key={JSON.stringify([
                              tool.agentId,
                              tool.candidate.id,
                            ])}
                            tool={tool}
                            read={runtime}
                            label={tool.candidate.id}
                          />
                        ))}
                      </span>
                    )
                )}
              </Row>
            )
            : undefined}
          extra={
            <>
              {toolStatus && (
                <p class="faint tool-read-status" role="status">{toolStatus}</p>
              )}
              {servers && servers.length > 0 && (
                <Row label="Servers">
                  {servers.map((server) => (
                    <span
                      key={server.name}
                      class="chip ghost"
                      data-tool-server={server.name}
                      title={server.tools.map((tool) => tool.name).join("\n")}
                    >
                      {server.name} {server.tools.length}
                    </span>
                  ))}
                </Row>
              )}
            </>
          }
        />
        <Declared
          icon="archive"
          title="Memory"
          none="No memory declared"
          section={profile.memory}
        />
        <section
          class={`ctx-sec${mandate.title ? "" : " is-blank"}`}
          data-section="Mandate"
        >
          <div class="ctx-head">
            <Icon name="key" />
            <h3>Mandate</h3>
          </div>
          {mandate.summary
            ? <p class="mandate" title={mandate.title}>{mandate.summary}</p>
            : mandate.title
            ? <p class="mandate faint">{mandate.title}</p>
            : <div class="faint">No mandate declared</div>}
          <Stats stats={mandate.limits} />
        </section>
        {profile.works.length > 0 && (
          <Section icon="arrows" title="Works on">
            <div class="ctx-row">
              <Chips chips={profile.works} />
            </div>
          </Section>
        )}
      </div>
    </article>
  );
}
