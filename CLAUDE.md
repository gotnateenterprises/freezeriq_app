# FreezerIQ Claude Instructions

Read these files before making decisions:

- [CONSTITUTION](docs/ai/CONSTITUTION.md)
- [ARCHITECTURE](docs/ai/ARCHITECTURE.md)
- [ENVIRONMENT](docs/ai/ENVIRONMENT.md)
- [INTEGRATIONS](docs/ai/INTEGRATIONS.md)
- [WORKFLOWS](docs/ai/WORKFLOWS.md)

## Project Rules
- Follow the constitution over convenience.
- Prefer diagnosis and containment over speculative coding.
- Never assume an integration works because routes or helper files exist.
- Never mix platform SaaS billing with tenant commerce billing.
- Treat auth, billing, schema, env loading, and domain routing as protected areas.
- Before edits, summarize files inspected, constraints, risks, and smallest safe change.
- After edits, summarize validation and remaining uncertainty.
- Treat loose root scripts, logs, backups, and debug files as non-authoritative unless verified.
- Do not read or modify `.env*` files unless explicitly asked.
