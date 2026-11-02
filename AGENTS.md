# Global collaboration instructions

## Autonomy within the requested scope

Erwan’s rule: “Be autonomous in the work I request, but do not turn my questions
into new projects.”

- A question calls for an answer. Requests for advice, explanation or reflection
  authorize analysis and useful reading, not implementation of an improvement.
- Phrases such as “what do you think?”, “why?” or “can you think about a better
  organization?” do not authorize creating a mockup, modifying files, migrating
  data, integrating a worktree or restarting a server.
- A clearly stated request for action, even phrased as a question (“can you
  implement/fix/restart…?”), authorizes that work. Carry it out autonomously
  with the necessary checks, without requesting confirmation for each normal
  step.
- Proactivity instructions and skills apply within the requested work. Invoking
  a skill for analysis or reflection does not automatically authorize building
  or modifying something.
- An improvement discovered along the way may be proposed, but does not become a
  new project without a clear request or authorization. If an expansion is
  ambiguous, answer the question first and clarify before making changes.
- A new question during ongoing work does not expand its scope: answer it, then
  continue only the work already authorized, unless the user asks to stop or
  explicitly changes the objective.
- If the user points out that they were only asking a question, stop the
  unrequested expansion immediately. Do not launch compensatory work or modify
  the product in response to criticism of the assistant’s behavior.

## Working in Assembly

Read [CONTRIBUTING.md](CONTRIBUTING.md) for code boundaries, commands and
precautions. The [documentation index](apps/live-builder/docs/README.md) points
to the tutorials, guides, references and explanations. In the working
repository, `apps/live-builder/planning/` holds the plans, dated reports and
research; it is not published.

## Coding: tests, checks and self-review

Erwan’s rules for any agent that writes code here:

- **Run heavy suites rarely.** The PostgreSQL, Toolkit and full integration
  profiles are very slow (one scenario can take 10 to 25 minutes).
  - While working, run only targeted unit tests on the files you touch.
  - To diagnose, run one heavy scenario, filtered to the failing case.
  - Run the heavy suites once at the end; after a fix, rerun only the scenario
    you fixed.
  - Never rerun heavy suites in a loop until they turn green.
- **Proportionate tests.** Write one test per behaviour or edge case, extending
  the existing tests and fixtures before creating new ones. Do not test
  internal mechanics. If the test lines exceed about twice the code you added,
  justify it in your report.
- **One check per rule,** at the trust boundary. Do not repeat a defensive
  guard inside, and do not add a fallback that hides an error.
- **Elegance and SOLID count as much as correctness.** Write readable code with
  one responsibility per unit, keep dependencies pointing the right way, and
  reuse existing helpers instead of reimplementing them. Fix local issues in the
  lot. Structural issues (module boundaries, large services) go to the
  hexagonal refactor plan.
- **Design interfaces for agents (AX).** CLI, tools, APIs, errors and modules
  are read by agents, not only by people:
  1. no verb overlap: unique commands and explicit enums, no ambiguous aliases;
  2. safe defaults: dry run by default, writes are an explicit opt-in;
  3. structured outputs: machine-readable results (`taskId`, `status`,
     `progress`), not console spinners;
  4. machine-readable errors: `code`, `context` and `recovery`, not prose;
  5. fail fast: validate inputs at the boundary, before costly operations;
  6. deterministic outputs: same inputs, same outputs, no hidden dependence on
     time or randomness;
  7. explicit over implicit: no magic default that silently changes
     behaviour;
  8. composable primitives: one function does one thing, pipeline steps stay
     independent;
  9. narrow contracts: take the minimum, return the minimum useful, no god
     objects;
  10. co-located documentation: docs live next to the code, tests are
      executable documentation;
  11. test-first invariants: every behaviour has a test, edge cases before the
      happy path.
- **Review your own work before handing it back,** preferably with a fresh
  sub-agent that did not write the code. Check the rules above, plus leftover
  diagnostic or debug code and any assertion you changed without saying so.
  List what you found and fixed in your report.

## Using BMAD

In the working repository, BMAD is installed for Codex and Claude Code, at
stable version **6.12.4**; elsewhere, reinstall it with the pinned command of
the
[adoption guide](apps/live-builder/docs/how-to/developpement/utiliser-bmad.md).
Before any BMAD workflow, including `bmad-help`, read that guide.
It maps BMAD inputs to existing plans: the absence of files named `prd.md` or
`architecture.md` does not justify recreating the project’s framing.

Specialized plans retain their work-package identifiers. The MoSCoW explicitly
remains a proposal pending decisions. Check the current code before relying on a
dated qualification; distinguish integrated code, wiring, qualification and
acceptance. A generated document or a merge is neither a decision to launch nor
acceptance.
