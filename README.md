# Assembly

_By Casys — Build, run and evolve agentic systems._

Assembly runs a system of agents from its SysML v2 model. The admitted model
declares who acts, with which rights, tools and collaborators. SysML Toolkit
compiles it, Git keeps its versions, and Assembly controls every execution. When
an agent lacks a tool, a right or a collaborator, it proposes a change to the
model; the change is compiled, reviewed and admitted before it runs.

```text
chat request → operator acts within its mandate → controlled execution → trace
                 └─ lacks a tool, a right or a collaborator → proposal
proposal → compile and validate → review and admission
         → new model version in Git → adoption → the operator acts again
```

## What you can do

- Talk with the **Main Operator**, which designs the system with you and creates
  the operators it needs.
- Open **Requests**: each one is a Case with its own operator, team and
  conversations, delegated within explicit mandates.
- Read the system in the **System** and **Model** places: operators, mandates,
  tools, flows and the SysML sources, with their versions.
- Review **proposals**: the diff, the checks and the decision, then the admitted
  revision and its Release.

## Status

Assembly is in active development. It is built and qualified on macOS (Apple
silicon); other platforms are not qualified yet. Precompiled native bundles are
not published yet, so setup builds them from source.

## Getting started

Requirements: Git, Deno **2.9.7**, Rust **1.98.1**, Node and npm, Docker for the
local PostgreSQL, and an Anthropic API key.

```sh
deno task setup:source   # build the pinned SysML Toolkit and semantic index
deno task build          # build the interface
cp .env.example .env     # then set AGENT_PROVIDER, ANTHROPIC_MODEL, ANTHROPIC_API_KEY
deno task db:up          # local PostgreSQL in Docker
deno task db:migrate
deno task system create my-system
deno task system serve my-system   # prints the address to open
```

Product settings use the `ASSEMBLY_*` names of `.env.example`. A new system
receives a builder, its context, its memory and the `assembly-modeling` skill;
its tool catalog stays empty until tools are selected. Local data and toolchains
stay under `.data/`. See [local projects](docs/how-to/modeles/projets-locaux.md)
to choose the model directory, and the
[native contract](docs/reference/modeles/toolkit-local.md) for what setup
installs and verifies.

## Learn more

- [Documentation](docs/README.md): tutorials, how-to guides, reference and
  explanations, organized by topic.
- [APE code map](src/README.md) and [SysML model index](models/README.md): where
  each pattern lives in the code and the model.
- [Developing Assembly](CONTRIBUTING.md): commands, development mode, code
  boundaries and tests.

## License

Assembly is licensed under the [MIT License](LICENSE). Third-party components
retain their own licenses, including the
[vendored SysML Toolkit distribution](vendor/sysml-toolkit/README.md).
