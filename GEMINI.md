# FreezerIQ Gemini Instructions

Read these files at the start of every task:

- [CONSTITUTION](docs/ai/CONSTITUTION.md)
- [ARCHITECTURE](docs/ai/ARCHITECTURE.md)
- [ENVIRONMENT](docs/ai/ENVIRONMENT.md)
- [INTEGRATIONS](docs/ai/INTEGRATIONS.md)
- [WORKFLOWS](docs/ai/WORKFLOWS.md)

## Execution Rules
- Make the smallest safe change.
- Diagnose before coding.
- Never assume code scaffolding means the integration is live.
- Never mix platform billing with tenant storefront payment flows.
- Do not continue feature work while billing truth, env truth, or tenant scoping is unresolved.
- Treat schema, auth, billing, env loading, webhooks, and routing as approval-required areas.
- Before coding, state scope, touched files, constraints, and risks.
- After coding, state validation, uncertainty, and next safest step.
