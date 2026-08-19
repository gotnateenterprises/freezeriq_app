/**
 * Public fundraiser inquiry — the top of the acquisition funnel.
 *
 * FR-FLOW-1 made this route persist at all: it previously validated its input,
 * ignored the tenant slug the form was already sending, wrote NOTHING, and
 * returned `{ success: true }` while the storefront promised a reply. Every
 * inquiry made through a tenant storefront was silently discarded.
 *
 * FR-FUNNEL-1 keeps every one of those security properties and adds durable
 * funnel structure on top:
 *
 *   Customer              — WHO they are. Unchanged FR-FLOW-1 identity rules.
 *   FundraiserOpportunity — WHERE this prospect sits. Mutable, one open per org.
 *   FundraiserInquiry     — THAT an inquiry happened. Immutable, append-only.
 *
 * WHY THE SPLIT MATTERS HERE
 * It is what lets this route handle repeat submissions without any time-window
 * heuristic. A double-click is stopped by the submission key. A deliberate
 * resubmit an hour later is recorded honestly as a second inquiry and folded
 * into the SAME opportunity, because the database permits only one open
 * opportunity per organization. Nothing has to guess whether two submissions
 * "feel like" duplicates.
 *
 * STILL TRUE, AND DELIBERATELY SO:
 *   - tenant resolved server-side from the storefront slug, never from the client
 *   - an existing customer's `type` and `source` are never overwritten
 *   - NO FundraiserCampaign is created; an inquiry is not a fundraiser
 *   - notification happens AFTER commit and cannot roll back a saved lead
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { FUNDRAISER_INQUIRY_TAG, FUNDRAISER_INQUIRY_SOURCE } from '@/lib/fundraiserLead';
import { validateSubmissionKey } from '@/lib/orderIdempotency';
import {
    resolveSourceChannel,
    buildInquiryFingerprint,
    cleanText,
    OPEN_OPPORTUNITY_STATUSES,
    SOURCE_DETAIL_MAX_LENGTH,
} from '@/lib/fundraiserFunnel';
// FR-FUNNEL-1P: the Production security baseline (772a046). Slug and email are
// matched LITERALLY, organization identity is resolved deterministically, and
// the advisory lock is the single canonical one — see lib/publicIdentity.ts.
import {
    findBusinessBySlug,
    findCustomersByEmailIdentity,
    identityLockKey,
    IDENTITY_LOCK_SQL,
} from '@/lib/publicIdentity';
import { resolveFundraiserCustomer, IDENTITY_REVIEW_TAG } from '@/lib/fundraiserCustomerResolution';
import { ensureInquiryOrganizationContact } from '@/lib/inquiryContact';
import { normalizeWebsiteUrl } from '@/lib/websiteUrl';

/**
 * Deliberately permissive: this only rejects input that cannot be an address at
 * all. A lead is more valuable than a perfectly-formatted contact, and a real
 * prospect must never be dropped over strictness.
 */
function isPlausibleEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

/** How many times to re-run the transaction when two requests race to create
 *  the same organization's opportunity. The loser of the race sees a unique
 *  violation on the open-opportunity index; re-running finds the winner's row. */
const OPPORTUNITY_RACE_RETRIES = 3;

function isUniqueViolation(e: unknown): e is Prisma.PrismaClientKnownRequestError {
    return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/** True when the unique violation came from the submission-key index rather
 *  than the open-opportunity index. */
function isSubmissionKeyViolation(e: Prisma.PrismaClientKnownRequestError): boolean {
    const target = e.meta?.target;
    const asText = Array.isArray(target) ? target.join(',') : String(target ?? '');
    return /submission_key/i.test(asText);
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const {
            name, email, phone, orgName, deliveryLocation, website, cause, notes, slug,
            submissionKey: rawSubmissionKey, sourceChannel: rawSourceChannel, sourceDetail: rawSourceDetail,
        } = body ?? {};

        // ── Required intake (FR-FUNNEL-1: deliveryLocation is NO LONGER required) ──
        // Low friction is the point. Delivery area is an operational detail that
        // can be asked once the conversation is real; requiring it to say hello
        // cost leads for no benefit.
        const contactName = cleanText(name, 200);
        const contactEmail = cleanText(email, 254);
        const contactPhone = cleanText(phone, 50);
        const organizationName = cleanText(orgName, 200);

        if (!contactName || !contactEmail || !contactPhone || !organizationName) {
            return NextResponse.json(
                { error: 'Name, email, phone, and organization are required.' },
                { status: 400 }
            );
        }
        if (!isPlausibleEmail(contactEmail)) {
            return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 });
        }

        // ── Tenant resolution: server-trusted, from the storefront slug ────────
        if (!slug || typeof slug !== 'string') {
            return NextResponse.json({ error: 'Unknown storefront.' }, { status: 400 });
        }
        // FR-PUBLIC-IDENTITY-1 (Production): literal slug resolution. The previous
        // `mode: 'insensitive'` compiled to ILIKE, so a submitted "%" resolved to
        // an ARBITRARY Business — a cross-tenant misroute of a public write.
        const business = await findBusinessBySlug(prisma, slug, { id: true });
        if (!business) {
            return NextResponse.json({ error: 'Unknown storefront.' }, { status: 404 });
        }
        const businessId = business.id;

        // ── Attribution ───────────────────────────────────────────────────────
        // An unrecognised channel is REJECTED rather than stored: a typo that
        // reaches the column becomes its own permanent bucket in every future
        // funnel report, indistinguishable from a real channel.
        const channelResult = resolveSourceChannel(rawSourceChannel);
        if (!channelResult.ok) {
            return NextResponse.json({ error: channelResult.error }, { status: 400 });
        }
        const sourceChannel = channelResult.channel;
        const sourceDetail = cleanText(rawSourceDetail, SOURCE_DETAIL_MAX_LENGTH);

        // ── Idempotency ───────────────────────────────────────────────────────
        const keyResult = validateSubmissionKey(rawSubmissionKey);
        if (!keyResult.ok) {
            return NextResponse.json({ error: keyResult.error }, { status: 400 });
        }
        const submissionKey = keyResult.key;
        const submissionFingerprint = buildInquiryFingerprint({
            slug, organizationName, contactEmail, contactName, contactPhone,
        });

        // FR-ACCEPTANCE-1: the submitted website, normalised to https. Optional —
        // a blank stays blank, and an unusable value is simply not recorded.
        const websiteResult = normalizeWebsiteUrl(website);
        const normalizedWebsite = websiteResult.ok ? websiteResult.url : null;

        // Context the form collects that has no dedicated column. Preserved as
        // readable notes rather than thrown away; no schema invented for it.
        const inquiryContext = [
            `Fundraiser inquiry submitted from the ${slug} storefront.`,
            deliveryLocation ? `Delivery/pickup area: ${cleanText(deliveryLocation, 300)}` : null,
            // FR-ACCEPTANCE-1: normalised server-side, so a person may type
            // "thebestbrewcoffee.com" the way they would say it out loud. A
            // rejected address is dropped rather than failing the whole enquiry —
            // losing a fundraiser lead over a mistyped website would be absurd.
            normalizedWebsite ? `Website: ${normalizedWebsite}` : null,
            cause ? `Cause: ${cleanText(cause, 500)}` : null,
            notes ? `Notes: ${cleanText(notes, 2000)}` : null,
        ].filter(Boolean).join('\n');

        // ── Replay pre-check ──────────────────────────────────────────────────
        // A fast path only. The partial unique index remains the real guarantee,
        // because two concurrent requests can both miss this read.
        if (submissionKey) {
            const existing = await prisma.fundraiserInquiry.findFirst({
                where: { business_id: businessId, submission_key: submissionKey },
                select: { id: true, customer_id: true, opportunity_id: true, submission_fingerprint: true },
            });
            if (existing) {
                if (existing.submission_fingerprint !== submissionFingerprint) {
                    return NextResponse.json(
                        { error: 'This submission was already received with different details.' },
                        { status: 409 }
                    );
                }
                return NextResponse.json({
                    success: true, customerId: existing.customer_id,
                    opportunityId: existing.opportunity_id, inquiryId: existing.id,
                    created: false, duplicate: true,
                });
            }
        }

        // ── Durable write ─────────────────────────────────────────────────────
        let result: { customerId: string; opportunityId: string; inquiryId: string; createdCustomer: boolean } | null = null;
        let replay: { customerId: string; opportunityId: string; inquiryId: string } | null = null;

        for (let attempt = 0; attempt < OPPORTUNITY_RACE_RETRIES && !result && !replay; attempt++) {
            try {
                result = await prisma.$transaction(async (tx) => {
                    // 0. FR-FUNNEL-1R — serialize organization resolution.
                    //    Two legitimate concurrent inquiries from the same NEW
                    //    organization carry different submission keys, so key
                    //    idempotency correctly lets both through; without this
                    //    lock both then saw "no such customer" and both created
                    //    one. Taken FIRST, on the same identity the lookup below
                    //    matches on, and released automatically at COMMIT or
                    //    ROLLBACK. Nothing is held while email is sent.
                    //    ONE lock for this identity — the canonical Production
                    //    implementation from lib/publicIdentity.ts, keyed on the
                    //    same normalized email its candidate query matches on.
                    await tx.$executeRawUnsafe(
                        IDENTITY_LOCK_SQL,
                        identityLockKey(businessId, contactEmail)
                    );

                    // 1. Organization identity — the PRODUCTION resolver (772a046).
                    //    Candidates are matched LITERALLY (no ILIKE, so "a_b@x.com"
                    //    can never match "aXb@x.com") and read AFTER the lock, and
                    //    ALL of them are fetched: `findFirst` with no ORDER BY chose
                    //    arbitrarily among the 5 duplicate-email groups Production
                    //    holds. Real history is resolved before any synthetic
                    //    holding record, and genuine ambiguity is never guessed.
                    const candidates = await findCustomersByEmailIdentity(tx as any, businessId, contactEmail);

                    let campaignOwnerIds = new Set<string>();
                    let orgContactIds = new Set<string>();
                    if (candidates.length > 1) {
                        const ids = candidates.map((c) => c.id);
                        const [withCampaigns, withContacts] = await Promise.all([
                            tx.fundraiserCampaign.findMany({
                                where: { customer_id: { in: ids } }, select: { customer_id: true },
                            }),
                            tx.fundraiserOrganizationContact.findMany({
                                where: { business_id: businessId, customer_id: { in: ids } },
                                select: { customer_id: true },
                            }),
                        ]);
                        campaignOwnerIds = new Set(withCampaigns.map((r) => r.customer_id));
                        orgContactIds = new Set(withContacts.map((r) => r.customer_id));
                    }

                    const outcome = resolveFundraiserCustomer({
                        candidates, organizationName, campaignOwnerIds, orgContactIds,
                    });

                    let customerId: string;
                    let createdCustomer: boolean;

                    if (outcome.kind === 'reuse') {
                        // Enrich, never overwrite. Only blank fields are filled, so a
                        // tenant's own corrections survive a resubmission. `type` and
                        // `source` are NEVER touched: type is a mutually-exclusive
                        // identity other subsystems route on, and source is
                        // first-touch attribution. See lib/fundraiserLead.ts.
                        const existingCustomer = outcome.customer;
                        const patch: Record<string, unknown> = {};
                        if (!existingCustomer.contact_name) patch.contact_name = contactName;
                        if (!existingCustomer.contact_phone) patch.contact_phone = contactPhone;
                        if (!existingCustomer.notes) patch.notes = inquiryContext;

                        const tags = existingCustomer.tags || [];
                        if (!tags.includes(FUNDRAISER_INQUIRY_TAG)) {
                            patch.tags = [...tags, FUNDRAISER_INQUIRY_TAG];
                        }
                        if (Object.keys(patch).length > 0) {
                            await tx.customer.update({ where: { id: existingCustomer.id }, data: patch });
                        }
                        customerId = existingCustomer.id;
                        createdCustomer = false;
                    } else {
                        // Ambiguous means the evidence left no defensible winner, so
                        // the lead is saved as its own organization and flagged —
                        // never bound to an arbitrary legacy row, and never dropped.
                        const ambiguous = outcome.reason === 'ambiguous';
                        const lead = await tx.customer.create({
                            data: {
                                business_id: businessId,
                                name: organizationName,
                                contact_name: contactName,
                                contact_email: contactEmail,
                                contact_phone: contactPhone,
                                type: 'fundraiser_org',
                                status: 'LEAD',
                                source: FUNDRAISER_INQUIRY_SOURCE,
                                notes: ambiguous
                                    ? `${inquiryContext}\n\nIDENTITY REVIEW: this tenant already has ${candidates.length} customers on this email address. FreezerIQ did not have enough evidence to decide which organization this inquiry belongs to, so it was saved as a new organization rather than attached to the wrong one. Reconcile the duplicates when convenient.`
                                    : inquiryContext,
                                tags: ambiguous
                                    ? [FUNDRAISER_INQUIRY_TAG, IDENTITY_REVIEW_TAG]
                                    : [FUNDRAISER_INQUIRY_TAG],
                            },
                        });
                        customerId = lead.id;
                        createdCustomer = true;
                    }

                    // 2. Opportunity — reuse the open one, or start a cycle.
                    //    A converted or lost prior opportunity does NOT block a new
                    //    one; that is what lets an organization come back next season.
                    const open = await tx.fundraiserOpportunity.findFirst({
                        where: {
                            business_id: businessId,
                            customer_id: customerId,
                            status: { in: [...OPEN_OPPORTUNITY_STATUSES] as any },
                        },
                        select: { id: true },
                    });

                    const opportunityId = open
                        ? open.id
                        : (await tx.fundraiserOpportunity.create({
                              data: { business_id: businessId, customer_id: customerId, status: 'new' },
                              select: { id: true },
                          })).id;

                    // 3. The immutable fact. Created LAST so it can never be an
                    //    orphan: opportunity_id is NOT NULL by contract.
                    const inquiry = await tx.fundraiserInquiry.create({
                        data: {
                            business_id: businessId,
                            customer_id: customerId,
                            opportunity_id: opportunityId,
                            source_channel: sourceChannel,
                            source_detail: sourceDetail,
                            submission_key: submissionKey,
                            submission_fingerprint: submissionKey ? submissionFingerprint : null,
                            contact_name: contactName,
                            contact_email: contactEmail,
                            contact_phone: contactPhone,
                            organization_name: organizationName,
                            context: inquiryContext || null,
                            storefront_slug: typeof slug === 'string' ? slug : null,
                        },
                        select: { id: true },
                    });

                    // 4. FR-ACCEPTANCE-1 — the person who wrote in becomes a contact
                    //    of this organisation.
                    //
                    //    Inside the SAME transaction as the inquiry, because an
                    //    inquiry recorded while its author is not is exactly the
                    //    split this fixes: the organisation existed, the enquiry
                    //    existed, and the address book was empty, so Launch
                    //    Fundraiser reported "no active contacts" about the very
                    //    person who had just asked for a fundraiser.
                    //
                    //    This makes them SELECTABLE, not appointed. The
                    //    relationship role is 'relationship_contact', never
                    //    'coordinator' — filling in a form is not agreeing to run
                    //    the fundraiser, and FR-FLOW-2A's campaign coordinator
                    //    remains the only record of that deliberate tenant choice.
                    await ensureInquiryOrganizationContact(tx, {
                        businessId,
                        customerId,
                        name: contactName,
                        email: contactEmail,
                        phone: contactPhone,
                    });

                    return { customerId, opportunityId, inquiryId: inquiry.id, createdCustomer };
                });
            } catch (txErr) {
                if (!isUniqueViolation(txErr)) throw txErr;

                if (submissionKey && isSubmissionKeyViolation(txErr)) {
                    // Lost a double-click race. The winner's row is the answer.
                    const winner = await prisma.fundraiserInquiry.findFirst({
                        where: { business_id: businessId, submission_key: submissionKey },
                        select: { id: true, customer_id: true, opportunity_id: true, submission_fingerprint: true },
                    });
                    if (winner && winner.submission_fingerprint === submissionFingerprint) {
                        replay = {
                            customerId: winner.customer_id,
                            opportunityId: winner.opportunity_id,
                            inquiryId: winner.id,
                        };
                        break;
                    }
                    return NextResponse.json(
                        { error: 'This submission was already received with different details.' },
                        { status: 409 }
                    );
                }

                // Otherwise it is the open-opportunity index: another request
                // created this organization's opportunity a moment ago. Re-run;
                // the next pass finds it and appends to it.
                if (attempt === OPPORTUNITY_RACE_RETRIES - 1) throw txErr;
            }
        }

        const settled = result ?? replay;
        if (!settled) {
            return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
        }

        // ── Tenant notification — best effort, AFTER the lead is durable ───────
        // Deliberately outside the transaction and individually caught: a mail
        // outage must never be able to lose a lead that is already saved.
        try {
            const owner = await prisma.user.findFirst({
                where: { business_id: businessId, role: 'ADMIN' as any },
                select: { email: true },
            }) ?? await prisma.user.findFirst({
                where: { business_id: businessId },
                select: { email: true },
            });

            if (owner?.email) {
                const { sendLeadNotificationEmail } = await import('@/lib/email');
                await sendLeadNotificationEmail(owner.email, {
                    name: contactName,
                    email: contactEmail,
                    phone: contactPhone,
                    source: FUNDRAISER_INQUIRY_SOURCE,
                    notes: inquiryContext,
                }, businessId);
            }
        } catch (notifyError) {
            // Logged, not surfaced: the submitter's request genuinely succeeded.
            console.error('[FUNDRAISER_REQUEST] lead saved but notification failed', notifyError);
        }

        return NextResponse.json({
            success: true,
            customerId: settled.customerId,
            opportunityId: settled.opportunityId,
            inquiryId: settled.inquiryId,
            created: result ? result.createdCustomer : false,
            duplicate: Boolean(replay),
        });
    } catch (error: any) {
        console.error('[FUNDRAISER_REQUEST]', error);
        return NextResponse.json(
            { error: 'Something went wrong. Please try again.' },
            { status: 500 }
        );
    }
}
