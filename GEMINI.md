# FreezerIQ Gemini Instructions

Read these files at the start of every task:

- [CONSTITUTION](docs/ai/CONSTITUTION.md)
- [ARCHITECTURE](docs/ai/ARCHITECTURE.md)
- [ENVIRONMENT](docs/ai/ENVIRONMENT.md)
- [INTEGRATIONS](docs/ai/INTEGRATIONS.md)
- [WORKFLOWS](docs/ai/WORKFLOWS.md)

For any work on the coordinator panel or recipe library redesigns, also read:

- [UI_REDESIGN_SPEC](docs/ai/UI_REDESIGN_SPEC.md) — source of truth; overrides any chat transcript or handoff doc.
- [RECIPE_LIBRARY_HANDOFF](docs/ai/RECIPE_LIBRARY_HANDOFF.md) — implementation detail for the recipe library redesign (spec §3).
- [CRM_REDESIGN_HANDOFF](docs/ai/CRM_REDESIGN_HANDOFF.md) — exact component code for the CRM redesign + Start a Fundraiser wizard (spec §5).
- [GROWTH_ENGINE_HANDOFF](docs/ai/GROWTH_ENGINE_HANDOFF.md) — exact code for the Growth Engine phases GE-1..11 (spec §6). Requires CRM-1..4 merged first.
- [crm_prototype.html](docs/ai/prototypes/crm_prototype.html) — the APPROVED visual reference for all CRM/Growth/wizard UI. Open in a browser; match it whenever look or copy is ambiguous.
- [STOREFRONT_REDESIGN_HANDOFF](docs/ai/STOREFRONT_REDESIGN_HANDOFF.md) — exact code for the customer storefront redesign SF-1..12 (spec §9).
- [storefront_prototype.html](docs/ai/prototypes/storefront_prototype.html) — APPROVED visual reference for the customer storefront + fundraiser buyer page (6 screens).
- [KITCHEN_DELIVERY_HANDOFF](docs/ai/KITCHEN_DELIVERY_HANDOFF.md) — exact code for the Kitchen Board + Delivery Day pipeline, phases DD-0..DD-5 + KB-1 (spec §12).
- [kitchen_board_prototype.html](docs/ai/prototypes/kitchen_board_prototype.html) + [delivery_day_prototype.html](docs/ai/prototypes/delivery_day_prototype.html) — APPROVED visual references for spec §12.
- [MISSION_CONTROL_HANDOFF](docs/ai/MISSION_CONTROL_HANDOFF.md) — exact code for the dashboard redesign MC-0..5 (spec §15).
- [mission_control_prototype.html](docs/ai/prototypes/mission_control_prototype.html) — APPROVED visual reference for the dashboard.

## Execution Rules
- Make the smallest safe change.
- Diagnose before coding.
- Never assume code scaffolding means the integration is live.
- Never mix platform billing with tenant storefront payment flows.
- Do not continue feature work while billing truth, env truth, or tenant scoping is unresolved.
- Treat schema, auth, billing, env loading, webhooks, and routing as approval-required areas.
- Before coding, state scope, touched files, constraints, and risks.
- After coding, state validation, uncertainty, and next safest step.
