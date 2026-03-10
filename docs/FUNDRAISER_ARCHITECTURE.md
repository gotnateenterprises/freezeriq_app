# Fundraiser Architecture & Data Flow Corrected

### Overview
This document clarifies the actual responsibilities and data flow of the `Fundraiser` module in the FreezerIQ platform. Previously, some code and assumptions incorrectly treated fundraiser pages as standalone e-commerce checkout experiences. This is an explicit correction to that model.

### Corrected Architecture
Fundraiser pages are **not** independent online stores. They do **not** process live transactions via Stripe or any other integrated payment gateway during the user's interaction with the fundraiser interface.

Instead, the fundraiser module operates as a **post-transaction coordination tool**:

1. **Transaction Phase**:
   - The end customer completes their purchase/payment externally. This primarily happens via **Square** (POS / online) or via manual cash payment collected by the host.
2. **Order Intake & Token Generation**:
   - The purchase details (customer email, items bought) are ingested into FreezerIQ's database.
   - For every processed order, FreezerIQ creates an `Order` record and generates a unique, secure `magic link` containing a token.
3. **Coordination Phase (The "Fundraiser App")**:
   - The customer receives an email with their magic link to access their specific **Coordinator Page**.
   - Upon clicking the link, they view their order details and interact with the coordination tools (e.g. allocating credit to a specific participant/student).
   - If a customer modifies their coordination details (such as attributing their order to a seller), the update is sent to `api/coordinator/[token]`, and if applicable, order source tracking such as `OrderSource.fundraiser` is set.

### Code Implications
- Any routing logic, API endpoint, or UI component assuming "public checkout" on fundraiser pages is legacy or a misunderstanding of the intended workflow.
- Do not add Stripe Elements or direct checkout flows to the fundraiser views.
- The route `app/api/coordinator/[token]/route.ts` is the primary mechanism for customers to interact with their orders *after* payment has already been secured externally.

*End of correction document.*
