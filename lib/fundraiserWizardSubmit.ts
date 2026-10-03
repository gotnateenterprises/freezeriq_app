/**
 * DATA-CLEANUP-GUARDS-1 — the Start-a-Fundraiser wizard's submit, made retry-safe.
 *
 * For a brand-new organization the wizard makes two requests: POST /api/customers
 * to create the organization, then POST /api/campaigns for its fundraiser. The id
 * the first returned lived only in a local variable, so when the second failed —
 * a bad date, a family that went inactive, a network blip — the tenant's retry
 * created the organization AGAIN. Production carries organizations duplicated that
 * way.
 *
 * A submission object now lives for the whole wizard session:
 *   - the organization it created is remembered and reused by every later submit,
 *     so a retry never posts a second Customer (by id — never by matching names);
 *   - submits are single-flight: a double-click, or a retry clicked while the first
 *     attempt is still in flight, joins that attempt instead of starting another.
 *
 * It also turns the campaign route's "open fundraiser plan" refusal into a result
 * the wizard can show, rather than an error.
 *
 * No React here, and `fetch` is injected, so all of it runs under the node test
 * environment.
 */

export interface WizardOrganizationInput {
    name: string;
    contact_name: string;
    contact_email: string;
    contact_phone: string;
}

export interface WizardSubmitInput {
    /** The organization the tenant picked or the wizard opened with, if any. */
    existingCustomerId: string | null;
    /** Used only when the wizard has to create the organization. */
    organization: WizardOrganizationInput;
    /** The POST /api/campaigns body, without customerId (this module supplies it). */
    campaign: Record<string, unknown>;
    /** The tenant's explicit "create it separately" answer to an open plan. */
    separateFromOpportunityId?: string | null;
}

export type WizardSubmitResult =
    | { kind: 'created'; campaign: any; customerId: string }
    | { kind: 'open_opportunity'; customerId: string; opportunity: { id: string; status: string }; message: string }
    | { kind: 'error'; message: string; customerId: string | null };

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
    Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export interface WizardSubmission {
    /** The organization this wizard session created, once it has created one. */
    readonly createdOrganizationId: string | null;
    submit(input: WizardSubmitInput): Promise<WizardSubmitResult>;
}

export function createWizardSubmission(fetchImpl: FetchLike): WizardSubmission {
    let createdOrganizationId: string | null = null;
    let inFlight: Promise<WizardSubmitResult> | null = null;

    async function run(input: WizardSubmitInput): Promise<WizardSubmitResult> {
        // An organization this session already created always wins: the wizard
        // cannot switch organizations after creating one, and a retry must reuse it.
        let customerId = createdOrganizationId ?? input.existingCustomerId;
        if (!customerId) {
            const res = await fetchImpl('/api/customers', {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({ ...input.organization, type: 'Organization' }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || typeof data?.id !== 'string' || data.id.length === 0) {
                return { kind: 'error', message: data?.error || 'Could not create organization', customerId: null };
            }
            createdOrganizationId = data.id;
            customerId = data.id as string;
        }

        const res = await fetchImpl('/api/campaigns', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
                ...input.campaign,
                customerId,
                ...(input.separateFromOpportunityId ? { separateFromOpportunityId: input.separateFromOpportunityId } : {}),
            }),
        });
        const campaign = await res.json().catch(() => ({}));
        if (res.status === 409 && campaign?.refusal === 'open_opportunity' && typeof campaign?.openOpportunity?.id === 'string') {
            return {
                kind: 'open_opportunity',
                customerId,
                opportunity: { id: campaign.openOpportunity.id, status: String(campaign.openOpportunity.status ?? '') },
                message: String(campaign.error ?? ''),
            };
        }
        if (!res.ok) {
            return { kind: 'error', message: campaign?.error || 'Could not create campaign', customerId };
        }
        return { kind: 'created', campaign, customerId };
    }

    return {
        get createdOrganizationId() { return createdOrganizationId; },
        submit(input: WizardSubmitInput): Promise<WizardSubmitResult> {
            if (inFlight) return inFlight;
            const attempt = run(input).finally(() => { inFlight = null; });
            inFlight = attempt;
            return attempt;
        },
    };
}
