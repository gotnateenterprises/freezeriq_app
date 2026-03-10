# FreezerIQ AI Workflows
Last updated: 2026-03-09

## Purpose
This file defines how AI agents should work inside the FreezerIQ repo to reduce drift, overreach, and accidental architecture damage.

---

## Guiding Principle
The agent's job is not to "be helpful at all costs."
The agent's job is to preserve architecture truth while making the smallest safe progress.

---

## Standard Repair Loop

For any bugfix, cleanup, or stabilization task:

### Step 1: Inspect
Read the relevant files first.
Examples:
- schema files
- route handlers
- service files
- config loaders
- middleware
- related docs

### Step 2: Summarize Current Truth
State:
- what the system currently appears to do
- what evidence supports that
- what is assumed versus verified

### Step 3: Compare Against Intended Architecture
Identify mismatch between:
- current implementation
- architecture docs
- env contract
- integration ownership

### Step 4: Propose Smallest Safe Fix
Before coding, state:
- exact problem
- exact files to touch
- exact behavior to change
- risks

### Step 5: Approval Check
If the task touches protected areas, stop for approval.

### Step 6: Implement
Make the smallest safe diff.
Avoid broad speculative rewrites.

### Step 7: Validate
Use the strongest available checks:
- typecheck
- lint
- tests
- build
- targeted local verification
- migration review if relevant

### Step 8: Report
Summarize:
- files changed
- what was fixed
- what remains uncertain
- next safest step

---

## Protected Areas Requiring Approval

Do not modify these without explicit approval:

### Billing
- Stripe key paths
- billing flow logic
- webhook ownership or routing
- subscription plan mapping
- payment domain separation

### Authentication
- NextAuth config
- role logic
- session identity structure
- auth callbacks
- credential handling

### Database Schema
- Prisma schema
- enums
- migrations
- relation changes
- scoped field naming changes

### Environment / Secrets
- env loading code
- secret names
- fallback behavior for critical secrets
- deployment config touching secrets

### Multi-Tenant Routing
- domain rewrite middleware
- root domain logic
- tenant resolution logic

---

## Changes Allowed Without Approval
These can usually proceed directly if low risk:
- docs
- comments
- copy changes
- non-breaking UI text
- organizing clearly-unused scripts
- moving logs/backups out of root
- dead-code notes
- integration status labeling docs

If unsure, treat as protected.

---

## File Inspection Rules

Before changing code, the agent should inspect:
1. primary implementation file
2. connected route/service/helper
3. related type/schema/model if applicable
4. relevant architecture/env/integration doc

Do not edit based on one file alone when cross-file behavior is likely.

---

## Diff Discipline

### Prefer
- smallest safe diff
- one problem at a time
- preserve public contracts unless planned change
- explicit comments where ambiguity remains

### Avoid
- broad cleanup mixed with feature work
- drive-by refactors in protected areas
- renaming concepts across the repo without plan
- hidden behavior changes bundled into "cleanup"

---

## Validation Standards

### Minimum validation
For any code change:
- project typecheck if practical
- lint if practical
- note untested assumptions explicitly

### Additional validation for protected areas
- confirm exact env variables used
- confirm migration impact
- confirm callback/webhook behavior
- confirm no cross-tenant permission break

### Integration validation
An integration is only verified if:
1. config exists
2. credentials are correct
3. auth/callback succeeds
4. data is stored or action completes
5. failure path is understood

---

## Status Reporting Format

After work, report in this structure:

### Files inspected
- file A
- file B
- file C

### Constraints
- billing separation
- business scoping
- env mismatch
- etc.

### Change made
One paragraph describing exactly what changed.

### Validation
- typecheck result
- lint result
- tests/build result
- manual reasoning if no runtime verification

### Remaining risk
List what is still uncertain or out of scope.

### Next safest step
One small recommended follow-up.

---

## Work Modes

## Mode 1: Diagnose Only
Use when truth is unclear.
Output:
- findings
- ambiguity
- recommended next inspection
No code changes.

## Mode 2: Repair
Use when problem is understood and fix is bounded.
Output:
- minimal implementation
- validation
- remaining uncertainty

## Mode 3: Plan
Use when issue spans protected areas.
Output:
- phased plan
- approval checkpoints
- risk list

---

## Special Workflow: Billing Work
For any billing-related task:

1. identify whether domain is platform billing or tenant commerce
2. identify exact credentials involved
3. identify exact webhook path involved
4. identify affected plan/subscription data
5. stop if test/live truth is ambiguous
6. do not implement until domain separation is clear

---

## Special Workflow: Schema Work
For any Prisma/schema task:

1. inspect current schema
2. inspect existing data assumptions
3. identify migrations needed
4. describe backward compatibility risk
5. obtain approval
6. implement schema + migration plan together

---

## Special Workflow: Env Work
For any environment/config issue:

1. identify canonical variable names
2. identify invalid/stale/duplicate names
3. classify variables as platform or tenant domain
4. propose documentation update first if truth is unclear
5. do not "paper over" missing values in code silently

---

## Special Workflow: Repo Cleanup
For loose scripts, debug files, logs, or backups:

1. identify likely non-authoritative files
2. confirm they are not imported or executed in runtime
3. move to `/scripts`, `/archive`, or remove as appropriate
4. do not combine repo cleanup with protected-area changes

---

## Refusal Rule
The agent should refuse or pause implementation when:
- billing truth is ambiguous
- env truth is ambiguous
- schema change is requested without migration consideration
- cross-tenant impact is possible but not analyzed
- protected areas are implicated without approval

---

## AI Agent Success Criteria
A successful task is:
- accurate
- bounded
- architecture-safe
- explicit about uncertainty
- easy to review
