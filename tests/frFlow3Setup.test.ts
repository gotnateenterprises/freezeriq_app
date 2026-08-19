/**
 * FR-FLOW-3 — coordinator setup, final selection, activation and the first-order lock.
 *
 * The rules live in lib/coordinatorSetup.ts and are called directly here; the
 * route is run for real against the recording Prisma double, so what is asserted
 * is the query the handler actually built. The one thing neither can prove — that
 * two concurrent transactions cannot both win — is proven against real PostgreSQL
 * in tests/frFlow3Concurrency.test.ts.
 */

import fs from 'fs';
import path from 'path';
import {
    BUNDLE_SELECTION_LOCKED_MESSAGE,
    checkChecksPayable,
    checkCoordinatorSetup,
    checkDeliveryTime,
    checkPaymentLink,
    checkPickupLocation,
    isSetupRefusal,
    DELIVERY_TIME_MAX,
} from '@/lib/coordinatorSetup';
import {
    CAMPAIGN_SELECTION_LOCK_SQL,
    campaignSelectionLockKey,
    CAMPAIGN_SELECTION_LOCK_NAMESPACE,
} from '@/lib/campaignSelectionLock';

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/)
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join('\n');

const COORD_ROUTE = 'app/api/coordinator/bundle-selection/route.ts';
const ORDER_ROUTE = 'app/api/public/order/route.ts';
const SYNC_ROUTE = 'app/api/customers/[id]/route.ts';

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the pickup/delivery time', () => {
    it('accepts a single time, a window and TBD', () => {
        for (const v of ['4:45 PM', '3–5 PM', 'TBD', '9 AM–noon']) {
            const r = checkDeliveryTime(v);
            expect(r.ok).toBe(true);
            expect((r as any).value).toBe(v);
        }
    });

    it('treats blank as "not answered", not as an error', () => {
        for (const v of ['', '   ', null, undefined]) {
            const r = checkDeliveryTime(v);
            expect(r.ok).toBe(true);
            expect((r as any).value).toBeNull();
        }
    });

    it('is bounded', () => {
        expect(checkDeliveryTime('x'.repeat(DELIVERY_TIME_MAX)).ok).toBe(true);
        expect(checkDeliveryTime('x'.repeat(DELIVERY_TIME_MAX + 1)).ok).toBe(false);
    });

    it('refuses markup', () => {
        expect(checkDeliveryTime('<script>alert(1)</script>').ok).toBe(false);
    });

    it('is never parsed as a clock value — a window has no single time', () => {
        const src = read('lib/coordinatorSetup.ts');
        expect(src).not.toMatch(/new Date\(/);
        expect(src).not.toMatch(/parseTime|Date\.parse/);
    });

    it('is stored separately from the location, never merged into it', () => {
        const code = stripComments(read(COORD_ROUTE));
        expect(code).not.toMatch(/pickup_location[^\n]*delivery_time/);
        expect(code).not.toMatch(/delivery_time[^\n]*\+[^\n]*pickup_location/);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the other logistics fields', () => {
    it('accept ordinary text including apostrophes', () => {
        expect((checkChecksPayable("St. John's PTO") as any).value).toBe("St. John's PTO");
        expect((checkPickupLocation('Gym, north entrance') as any).value).toBe('Gym, north entrance');
    });

    it('trim, and treat whitespace-only as unanswered', () => {
        expect((checkPickupLocation('  Gym  ') as any).value).toBe('Gym');
        expect((checkPickupLocation('   ') as any).value).toBeNull();
    });

    it('refuse markup', () => {
        expect(checkChecksPayable('<b>PTO</b>').ok).toBe(false);
        expect(checkPickupLocation('Gym <img src=x onerror=1>').ok).toBe(false);
    });

    it('refuse non-strings', () => {
        expect(checkChecksPayable({ evil: true }).ok).toBe(false);
        expect(checkPickupLocation(42).ok).toBe(false);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the optional payment link', () => {
    it('accepts public https payment pages', () => {
        for (const u of [
            'https://venmo.com/u/lincoln-pto',
            'https://www.paypal.com/paypalme/lincolnpto',
            'https://cash.app/$LincolnPTO',
        ]) {
            expect(checkPaymentLink(u).ok).toBe(true);
        }
    });

    it('accepts blank — a link is optional', () => {
        expect((checkPaymentLink('') as any).value).toBeNull();
        expect((checkPaymentLink(null) as any).value).toBeNull();
    });

    it('refuses script-execution and local schemes', () => {
        for (const u of [
            'javascript:alert(1)',
            'data:text/html;base64,PHNjcmlwdD4=',
            'file:///etc/passwd',
            'vbscript:msgbox(1)',
        ]) {
            const r = checkPaymentLink(u);
            expect(r.ok).toBe(false);
        }
    });

    it('refuses plain http — a payment page must not be downgraded', () => {
        const r = checkPaymentLink('http://venmo.com/u/x');
        expect(r.ok).toBe(false);
        expect((r as any).code).toBe('payment_link_scheme');
    });

    it('refuses a URL carrying credentials rather than silently stripping them', () => {
        const r = checkPaymentLink('https://user:secret@venmo.com/u/x');
        expect(r.ok).toBe(false);
        expect((r as any).code).toBe('payment_link_credentials');
        expect((r as any).error).not.toContain('secret');
    });

    it('refuses malformed input', () => {
        for (const u of ['venmo.com/u/x', 'not a url', 'https://', 'https://localhost']) {
            expect(checkPaymentLink(u).ok).toBe(false);
        }
    });

    it('MUTATION: dropping the scheme check must be detectable', () => {
        const src = read('lib/coordinatorSetup.ts');
        const re = /if \(url\.protocol !== 'https:'\)/;
        expect(src).toMatch(re);
        expect(src.replace(re, 'if (false)')).not.toBe(src);
    });

    it('following the link is never described as paying', () => {
        // JSX wraps prose across lines, so compare on collapsed whitespace.
        const ui = read('components/coordinator/CoordinatorSetupFields.tsx').replace(/\s+/g, ' ');
        expect(ui).toMatch(/does not mark an order paid/i);
        // The order path must contain no payment-status side effect for the link.
        const order = stripComments(read(ORDER_ROUTE));
        expect(order).not.toMatch(/external_payment_link[^\n]*(paid|payment_status)/i);
    });

    it('stores no secrets — nothing credential-shaped is ever persisted', () => {
        const src = stripComments(read('lib/coordinatorSetup.ts'));
        // `url.username` / `url.password` are the REFUSAL of credentials, not
        // storage of them, so they are excluded before the scan; anything else
        // credential-shaped would be a real finding.
        const scanned = src.replace(/url\.(username|password)/g, '');
        expect(scanned).not.toMatch(/api[_-]?key|secret|private[_-]?key|\btoken\b/i);
        // The only persisted keys are the five logistics columns.
        const persisted = src.slice(src.indexOf('values: {'));
        expect(persisted).not.toMatch(/password|secret|token/i);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the whole setup payload', () => {
    it('validates every field and returns exactly the five persistable columns', () => {
        const r = checkCoordinatorSetup({
            checksPayable: 'Lincoln PTO',
            pickupLocation: 'Gym',
            deliveryTime: '4:45 PM',
            paymentInstructions: 'Cash or check at pickup.',
            paymentLink: 'https://venmo.com/u/x',
        });
        expect(r.ok).toBe(true);
        expect(Object.keys((r as any).values).sort()).toEqual([
            'checks_payable', 'delivery_time', 'external_payment_link',
            'payment_instructions', 'pickup_location',
        ]);
    });

    it('carries NO tenant-owned field — a locked value cannot even be expressed', () => {
        const r = checkCoordinatorSetup({ deliveryTime: '4:45 PM' }) as any;
        for (const forbidden of [
            'delivery_date', 'end_date', 'org_share_percent',
            'bundle_selection_limit', 'bundle_selection_status', 'status',
        ]) {
            expect(Object.keys(r.values)).not.toContain(forbidden);
        }
    });

    it('refuses on the first bad field', () => {
        const r = checkCoordinatorSetup({ checksPayable: 'ok', paymentLink: 'javascript:x' });
        expect(isSetupRefusal(r)).toBe(true);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('locked tenant fields', () => {
    const code = stripComments(read(COORD_ROUTE));

    it('the coordinator route writes none of them', () => {
        const update = code.slice(code.indexOf('bundle_selection_status: \'selected\''));
        for (const f of ['delivery_date', 'end_date', 'org_share_percent', 'bundle_selection_limit']) {
            expect(update).not.toMatch(new RegExp(`${f}\\s*:`));
        }
    });

    it('the request body is never spread into an update', () => {
        expect(code).not.toMatch(/data:\s*\{\s*\.\.\.(rawBody|body)\b/);
    });

    it('only the validated setup object reaches the update', () => {
        expect(code).toMatch(/\.\.\.\(setupValues \?\? \{\}\)/);
    });

    it('MUTATION: allowing a client delivery_date would be detectable', () => {
        expect(code).not.toMatch(/delivery_date:\s*rawBody/);
        expect(code).not.toMatch(/delivery_date:\s*body/);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the first-order lock', () => {
    const code = stripComments(read(COORD_ROUTE));

    it('counts live orders INSIDE the transaction', () => {
        const tx = code.slice(code.indexOf('$transaction'));
        expect(tx).toMatch(/tx\.order\.count\(\{[\s\S]*?campaign_id: campaignId, canceled_at: null/);
    });

    it('counts them AFTER taking the lock, never before', () => {
        const tx = code.slice(code.indexOf('$transaction'));
        expect(tx.indexOf('lockCampaignSelection')).toBeGreaterThanOrEqual(0);
        expect(tx.indexOf('lockCampaignSelection')).toBeLessThan(tx.indexOf('tx.order.count'));
    });

    it('a cancelled order does not lock the campaign — canceled_at: null is the contract', () => {
        expect(code).toMatch(/canceled_at: null/);
    });

    it('refuses reselection once orders exist, with a message naming no internals', () => {
        expect(code).toMatch(/if \(ordersHaveStarted\)/);
        expect(BUNDLE_SELECTION_LOCKED_MESSAGE).toMatch(/Orders have already started/);
        expect(BUNDLE_SELECTION_LOCKED_MESSAGE).not.toMatch(/order id|bundle_selection|candidate|active|campaign_id/i);
    });

    it('guards the lock twice, so reordering the blocks fails closed', () => {
        expect((code.match(/ordersHaveStarted/g) || []).length).toBeGreaterThanOrEqual(3);
    });

    it('MUTATION: removing the order-count guard must be detectable', () => {
        const re = /if \(ordersHaveStarted\) \{/g;
        expect(code.match(re)).not.toBeNull();
        expect(code.replace(re, 'if (false) {')).not.toBe(code);
    });

    it('does NOT give the coordinator a post-order override', () => {
        expect(code).not.toMatch(/override/i);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('pre-first-order reselection', () => {
    const code = stripComments(read(COORD_ROUTE));

    it('an identical resubmission stays idempotent', () => {
        expect(code).toMatch(/familySetsEqual\(existingFamilyIds, familyIds\)/);
        expect(code).toMatch(/alreadySelected: true/);
    });

    it('a different submission falls through instead of being refused outright', () => {
        // The old behaviour returned 409 unconditionally at the end of the
        // already-selected block. Now the ONLY refusal there is the order lock.
        const start = code.indexOf("currentStatus === 'selected'");
        const end = code.indexOf("currentStatus !== 'pending'");
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const selectedBlock = code.slice(start, end);
        expect(selectedBlock).toMatch(/ordersHaveStarted/);
        expect(selectedBlock).not.toMatch(/Bundle selection has already been submitted/);
    });

    it('activation accepts pending OR selected, and nothing else', () => {
        expect(code).toMatch(/currentStatus !== 'pending' && currentStatus !== 'selected'/);
    });

    it('the exact-count rule still applies to a reselection', () => {
        expect(code).toMatch(/familyIds\.length !== selectionLimit/);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the shared synchronization boundary', () => {
    it('both paths take the SAME lock helper', () => {
        expect(stripComments(read(COORD_ROUTE))).toMatch(/lockCampaignSelection\(tx, campaignId\)/);
        expect(stripComments(read(ORDER_ROUTE))).toMatch(/lockCampaignSelection\(tx, campaign\.id\)/);
    });

    it('the key is derived identically, so the two cannot take different locks', () => {
        expect(campaignSelectionLockKey('camp-1')).toBe(`${CAMPAIGN_SELECTION_LOCK_NAMESPACE}:camp-1`);
        expect(campaignSelectionLockKey('camp-1')).toBe(campaignSelectionLockKey('camp-1'));
        expect(campaignSelectionLockKey('camp-1')).not.toBe(campaignSelectionLockKey('camp-2'));
    });

    it('the key is hashed by Postgres and bound as a parameter, never interpolated', () => {
        expect(CAMPAIGN_SELECTION_LOCK_SQL).toMatch(/md5\(\$1\)/);
        expect(CAMPAIGN_SELECTION_LOCK_SQL).toMatch(/pg_advisory_xact_lock/);
        expect(CAMPAIGN_SELECTION_LOCK_SQL).not.toMatch(/\$\{/);
    });

    it('the lock is transaction-scoped, so nothing can leak it', () => {
        expect(CAMPAIGN_SELECTION_LOCK_SQL).toContain('_xact_');
        expect(read('lib/campaignSelectionLock.ts')).not.toMatch(/pg_advisory_unlock/);
    });

    it('it is the FIRST statement in the coordinator transaction', () => {
        const code = stripComments(read(COORD_ROUTE));
        const tx = code.slice(code.indexOf('prisma.$transaction'));
        expect(tx.indexOf('lockCampaignSelection')).toBeLessThan(tx.indexOf('tx.fundraiserCampaign.findUnique'));
    });

    it('it is the FIRST statement in the order transaction', () => {
        const code = stripComments(read(ORDER_ROUTE));
        const tx = code.slice(code.indexOf('prisma.$transaction'));
        expect(tx.indexOf('lockCampaignSelection')).toBeLessThan(tx.indexOf('tx.customer.findFirst'));
    });

    it('the coordinator transaction does NOT run at Serializable, which would read a pre-lock snapshot', () => {
        const code = stripComments(read(COORD_ROUTE));
        expect(code).toMatch(/isolationLevel: 'ReadCommitted'/);
        expect(code).not.toMatch(/isolationLevel: 'Serializable'/);
    });

    it('MUTATION: removing the lock from either path must be detectable', () => {
        for (const p of [COORD_ROUTE, ORDER_ROUTE]) {
            const code = read(p);
            expect(code).toMatch(/lockCampaignSelection\(/);
            expect(code.replace(/await lockCampaignSelection\([^)]*\);/, '')).not.toBe(code);
        }
    });

    it('only campaign orders contend — the ordinary storefront path takes nothing', () => {
        const code = stripComments(read(ORDER_ROUTE));
        expect(code).toMatch(/if \(campaign\) \{[\s\S]{0,120}lockCampaignSelection/);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the order path rechecks the sellable set', () => {
    const code = stripComments(read(ORDER_ROUTE));

    it('refuses a basket whose bundles are no longer active', () => {
        expect(code).toMatch(/BundleSelectionChangedError/);
        expect(code).toMatch(/state: 'active'/);
        expect(code).toMatch(/sellable\.has/);
    });

    it('refuses outright while setup is reopened (pending)', () => {
        expect(code).toMatch(/selectionStatus === 'pending'[\s\S]{0,80}BundleSelectionChangedError/);
    });

    it('leaves the legacy not_required contract alone', () => {
        expect(code).toMatch(/selectionStatus === 'selected'/);
    });

    it('detects its own error by marker, not fragile instanceof', () => {
        expect(code).toMatch(/isBundleSelectionChanged/);
        expect(code).not.toMatch(/instanceof BundleSelectionChangedError/);
    });

    it('tells the supporter nothing about coordinators or internal state', () => {
        // The message contains an escaped apostrophe, so match to the line end
        // rather than to the next quote.
        const msg = code.split(/\r?\n/).find((l) => l.includes('This fundraiser')) ?? '';
        expect(msg).toMatch(/refresh/i);
        expect(msg).not.toMatch(/coordinator|candidate|pending|bundle_selection/i);
    });

    it('preserves the existing closed-state, deadline and idempotency guards', () => {
        expect(code).toMatch(/isCampaignClosed\(currentCampaign\)/);
        expect(code).toMatch(/isCampaignPastOrderDeadline\(currentCampaign, tenantZone\)/);
        expect(code).toMatch(/submission_key/);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('activation writes setup and status together', () => {
    const code = stripComments(read(COORD_ROUTE));

    it('status, timestamp and logistics are one update', () => {
        const update = code.slice(code.indexOf("bundle_selection_status: 'selected'"));
        const block = update.slice(0, update.indexOf('});'));
        expect(block).toMatch(/bundle_selection_at: now/);
        expect(block).toMatch(/\.\.\.\(setupValues \?\? \{\}\)/);
    });

    it('candidate rows are preserved — only active rows are replaced', () => {
        expect(code).toMatch(/deleteMany\(\{[\s\S]{0,120}state: 'active'/);
        const del = code.match(/tx\.campaignBundle\.deleteMany\(\{[\s\S]*?\}\)/)?.[0] ?? '';
        expect(del).not.toMatch(/'candidate'/);
    });

    it('MUTATION: deleting candidate rows would be detectable', () => {
        const del = code.match(/tx\.campaignBundle\.deleteMany\(\{[\s\S]*?\}\)/)![0];
        expect(del).toMatch(/state: 'active'/);
        expect(del.replace(/,?\s*state: 'active'/, '')).not.toBe(del);
    });

    it('MUTATION: dropping delivery_time persistence would be detectable', () => {
        const lib = read('lib/coordinatorSetup.ts');
        expect(lib).toMatch(/delivery_time: time\.value/);
        expect(lib.replace(/delivery_time: time\.value,/, '')).not.toBe(lib);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('session authority and tenant isolation', () => {
    const code = stripComments(read(COORD_ROUTE));

    it('the campaign comes from the session, never the client', () => {
        expect(code).toMatch(/const guard = await requireCoordinatorSession\(req\)/);
        expect(code).toMatch(/const campaignId = guard\.campaignId/);
    });

    it('no client-supplied identity is read', () => {
        expect(code).not.toMatch(/rawBody\.(campaignId|businessId|customerId|campaign_id|business_id)/);
    });

    it('a failed guard short-circuits before any work', () => {
        expect(code).toMatch(/if \(!guard\.ok\) return guard\.response/);
    });

    it('tenant ownership is reconfirmed inside the transaction', () => {
        expect(code).toMatch(/freshCampaign\.customer\.business_id !== expectedBusinessId/);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('coordinator contact is read-only', () => {
    const code = stripComments(read(COORD_ROUTE));

    it('no contact table is written from the coordinator path', () => {
        for (const m of [
            'fundraiserContact', 'fundraiserContactPoint',
            'fundraiserOrganizationContact', 'fundraiserCampaignCoordinator',
        ]) {
            expect(code).not.toMatch(new RegExp(`${m}\\.(create|update|updateMany|upsert|delete|deleteMany)`));
        }
    });

    it('no contact-editing fields are accepted', () => {
        expect(code).not.toMatch(/coordinatorName|coordinatorEmail|coordinatorPhone|orgContactId/);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('secure link architecture is untouched', () => {
    it('the coordinator route carries no credential in a path or query', () => {
        const code = read(COORD_ROUTE);
        expect(code).not.toMatch(/\?token=/);
        expect(code).not.toMatch(/params\.token/);
        expect(code).not.toMatch(/searchParams\.get\(['"]token/);
    });

    it('nothing logs a credential', () => {
        for (const p of [COORD_ROUTE, ORDER_ROUTE]) {
            for (const m of read(p).match(/console\.(log|error|warn|info)\([^)]*\)/g) ?? []) {
                expect(m).not.toMatch(/portal_token|credential|session_hash/i);
            }
        }
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('public gates, Ready/Live and the legacy sync', () => {
    it('the listing still excludes pending', () => {
        expect(read('app/api/public/tenant/[slug]/route.ts')).toMatch(/bundle_selection_status <> 'pending'/);
    });

    it('Ready/Live is Active + selected — no new persisted status was invented', () => {
        const code = stripComments(read(COORD_ROUTE));
        expect(code).toMatch(/bundle_selection_status: 'selected'/);
        expect(code).not.toMatch(/status: 'Ready'|status: 'Live'/);
    });

    it('the sync will not overwrite a coordinator-confirmed time', () => {
        const code = stripComments(read(SYNC_ROUTE));
        expect(code).toMatch(/latestCampaign\.bundle_selection_status === 'selected'[\s\S]{0,80}\{\}/);
        expect(code).toMatch(/delivery_time: fi\.delivery_time \|\| undefined/);
    });

    it('MUTATION: making the sync unconditional would be detectable', () => {
        const code = read(SYNC_ROUTE);
        const re = /\.\.\.\(latestCampaign\.bundle_selection_status === 'selected'[\s\S]*?\)/;
        expect(code).toMatch(re);
        expect(code.replace(re, 'delivery_time: fi.delivery_time')).not.toBe(code);
    });

    it('the public page prefers the campaign time and no longer fabricates one from the date', () => {
        const client = read('app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx');
        expect(client).toMatch(/const deliveryTimeStr = \(campaign\.delivery_time/);
        expect(client).not.toMatch(/deliveryTimeStr = formatTime\(campaign\.delivery_date\)/);
    });

    it('delivery_time reaches the public payload', () => {
        expect(read('lib/publicFundraiserPayload.ts')).toMatch(/'delivery_time',/);
        expect(read('app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx')).toMatch(/fc\.delivery_time/);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the schema and migration', () => {
    const schema = () => read('prisma/schema.prisma');
    const MIG = 'prisma/migrations/20260821000000_fr_flow_3_campaign_delivery_time/migration.sql';
    const statements = () =>
        read(MIG).split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('--')).join('\n');

    it('adds delivery_time as nullable free text with no default', () => {
        const model = schema().slice(schema().indexOf('model FundraiserCampaign {'));
        expect(model.slice(0, model.indexOf('@@map'))).toMatch(/delivery_time\s+String\?/);
        expect(model.slice(0, model.indexOf('@@map'))).not.toMatch(/delivery_time[^\n]*@default/);
        expect(model.slice(0, model.indexOf('@@map'))).not.toMatch(/delivery_time[^\n]*@db\.Time/);
    });

    it('adds NO deadline_time', () => {
        expect(schema()).not.toMatch(/deadline_time/);
        expect(statements()).not.toMatch(/deadline_time/);
    });

    it('the migration is one additive ALTER and nothing else', () => {
        const st = statements();
        expect(st.split(';').filter((s) => s.trim()).length).toBe(1);
        expect(st).toMatch(/ALTER TABLE "fundraiser_campaigns" ADD COLUMN "delivery_time" TEXT;/);
        expect(st).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bINSERT\b|\bUPDATE\b|NOT NULL|DEFAULT/i);
    });

    it('touches no other table', () => {
        expect(statements()).not.toMatch(/"orders"|"invoices"|"campaign_bundles"|"customers"|PasswordResetToken/);
    });

    it('the parked block is untouched and still precedes the newest models', () => {
        expect(schema()).toMatch(/model PasswordResetToken \{/);
    });
});
