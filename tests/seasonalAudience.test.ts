/**
 * FR-RETENTION-2 — audience resolution tests.
 *
 * The engine decides who receives marketing email and who is suppressed, so
 * these cover the approved rules directly, including the ones most likely to
 * cause real harm if wrong: shared-inbox suppression and expiring pauses.
 */

import {
    resolveAudience,
    normalizeEmail,
    isPlausibleEmail,
    type AudienceContactInput,
    type AudiencePreferenceInput,
} from '@/lib/seasonalAudience';

const NOW = new Date('2026-08-07T00:00:00.000Z');

function contact(over: Partial<AudienceContactInput> & { contactId: string; displayName: string }): AudienceContactInput {
    return {
        archivedAt: null,
        needsReview: false,
        reviewReason: null,
        email: null,
        organizations: [{ customerId: 'org-' + over.contactId, name: 'Org ' + over.contactId, archived: false }],
        ...over,
    };
}

function run(contacts: AudienceContactInput[], preferences: AudiencePreferenceInput[] = []) {
    return resolveAudience({ contacts, preferences, now: NOW });
}

describe('normalization helpers', () => {
    it('normalizes for grouping only', () => {
        expect(normalizeEmail('  Shared@Example.COM ')).toBe('shared@example.com');
    });

    it('accepts ordinary addresses and rejects unusable ones', () => {
        expect(isPlausibleEmail('a@b.co')).toBe(true);
        expect(isPlausibleEmail('no-at-sign')).toBe(false);
        expect(isPlausibleEmail('a@b')).toBe(false);
        expect(isPlausibleEmail('two@@b.co')).toBe(false);
        expect(isPlausibleEmail('has space@b.co')).toBe(false);
    });
});

describe('1. one person / one org / one email', () => {
    it('produces a single included recipient', () => {
        const r = run([contact({ contactId: 'c1', displayName: 'Kim Parker', email: 'kim@pv.org' })]);
        expect(r.recipients).toHaveLength(1);
        expect(r.includedCount).toBe(1);
        expect(r.recipients[0].displayName).toBe('Kim Parker');
        expect(r.recipients[0].isSharedInbox).toBe(false);
        expect(r.recipients[0].organizations).toHaveLength(1);
    });
});

describe('2. one person / multiple orgs', () => {
    it('stays ONE recipient representing every organization', () => {
        const r = run([contact({
            contactId: 'c1', displayName: 'Riley Marsh', email: 'riley@grove.org',
            organizations: [
                { customerId: 'o1', name: 'Maple Grove', archived: false },
                { customerId: 'o2', name: 'Cedar Ridge', archived: false },
                { customerId: 'o3', name: 'Willow Creek', archived: false },
            ],
        })]);
        expect(r.recipients).toHaveLength(1);
        expect(r.recipients[0].organizations).toHaveLength(3);
        expect(r.recipients[0].contacts).toHaveLength(1);
        expect(r.includedCount).toBe(1);
    });
});

describe('3. multiple people / same email', () => {
    it('becomes ONE recipient linked to BOTH people and BOTH organizations', () => {
        const r = run([
            contact({ contactId: 'c1', displayName: 'Sam Rivera', email: 'office@cassfb.org', organizations: [{ customerId: 'o1', name: 'Willow Creek', archived: false }] }),
            contact({ contactId: 'c2', displayName: 'Alex Rivera', email: 'Office@CassFB.org', organizations: [{ customerId: 'o2', name: 'Birchwood', archived: false }] }),
        ]);
        expect(r.recipients).toHaveLength(1);
        const rec = r.recipients[0];
        expect(rec.isSharedInbox).toBe(true);
        // Two distinct people — never merged into one identity.
        expect(rec.contacts.map((c) => c.contactId).sort()).toEqual(['c1', 'c2']);
        expect(rec.organizations).toHaveLength(2);
        expect(rec.eligibility).toBe('included');
    });

    it('never sends twice to one normalized address', () => {
        const r = run([
            contact({ contactId: 'c1', displayName: 'A', email: 'shared@x.org' }),
            contact({ contactId: 'c2', displayName: 'B', email: 'SHARED@x.org' }),
            contact({ contactId: 'c3', displayName: 'C', email: ' shared@X.ORG ' }),
        ]);
        expect(r.recipients.filter((x) => x.normalizedEmail === 'shared@x.org')).toHaveLength(1);
    });
});

describe('4. shared address with unsubscribe', () => {
    it('excludes the whole inbox when ONE represented person unsubscribed', () => {
        const r = run(
            [
                contact({ contactId: 'c1', displayName: 'Joe Templin', email: 'shared@x.org' }),
                contact({ contactId: 'c2', displayName: 'Pat Lee', email: 'shared@x.org' }),
            ],
            [{ scope: 'contact', contactId: 'c1', normalizedEmail: null, status: 'unsubscribed', effectiveUntil: null }],
        );
        expect(r.recipients).toHaveLength(1);
        expect(r.recipients[0].eligibility).toBe('excluded');
        expect(r.recipients[0].exclusionReason).toBe('shared_address_unsubscribed');
        expect(r.recipients[0].exclusionDetail).toMatch(/everyone using it/i);
        expect(r.includedCount).toBe(0);
    });

    it('excludes when the ADDRESS itself is unsubscribed', () => {
        const r = run(
            [
                contact({ contactId: 'c1', displayName: 'A', email: 'shared@x.org' }),
                contact({ contactId: 'c2', displayName: 'B', email: 'shared@x.org' }),
            ],
            [{ scope: 'email_address', contactId: null, normalizedEmail: 'shared@x.org', status: 'unsubscribed', effectiveUntil: null }],
        );
        expect(r.recipients[0].eligibility).toBe('excluded');
        expect(r.recipients[0].exclusionReason).toBe('shared_address_unsubscribed');
    });
});

describe('5. contact unsubscribe (sole occupant)', () => {
    it('reports the personal reason, not the shared one', () => {
        const r = run(
            [contact({ contactId: 'c1', displayName: 'Marta Ellis', email: 'marta@x.org' })],
            [{ scope: 'contact', contactId: 'c1', normalizedEmail: null, status: 'unsubscribed', effectiveUntil: null }],
        );
        expect(r.recipients[0].exclusionReason).toBe('unsubscribed');
        expect(r.excludedCount).toBe(1);
    });
});

describe('6. no email', () => {
    it('is still shown so the tenant can fix it', () => {
        const r = run([contact({ contactId: 'c1', displayName: 'Pat Reilly', email: null })]);
        expect(r.recipients).toHaveLength(1);
        expect(r.recipients[0].exclusionReason).toBe('no_email');
        expect(r.recipients[0].normalizedEmail).toBeNull();
    });

    it('keeps several no-email people as separate rows', () => {
        const r = run([
            contact({ contactId: 'c1', displayName: 'A', email: null }),
            contact({ contactId: 'c2', displayName: 'B', email: '   ' }),
        ]);
        expect(r.recipients).toHaveLength(2);
    });
});

describe('7. invalid email', () => {
    it('is excluded with a plain-language reason', () => {
        const r = run([contact({ contactId: 'c1', displayName: 'R. Calloway', email: 'not-an-address' })]);
        expect(r.recipients[0].exclusionReason).toBe('invalid_email');
        expect(r.recipients[0].exclusionDetail).not.toMatch(/regex|parse|null/i);
    });
});

describe('8. paused contact', () => {
    it('is excluded while the pause is still running', () => {
        const r = run(
            [contact({ contactId: 'c1', displayName: 'J. Alvarez', email: 'j@x.org' })],
            [{ scope: 'contact', contactId: 'c1', normalizedEmail: null, status: 'paused', effectiveUntil: new Date('2027-01-01T00:00:00Z') }],
        );
        expect(r.recipients[0].exclusionReason).toBe('paused_until');
        expect(r.recipients[0].excludedUntil).toEqual(new Date('2027-01-01T00:00:00Z'));
    });
});

describe('9. not-interested-until in the future', () => {
    it('is excluded', () => {
        const r = run(
            [contact({ contactId: 'c1', displayName: 'Dee Otten', email: 'd@x.org' })],
            [{ scope: 'contact', contactId: 'c1', normalizedEmail: null, status: 'not_interested', effectiveUntil: new Date('2027-03-01T00:00:00Z') }],
        );
        expect(r.recipients[0].exclusionReason).toBe('not_interested_until');
    });
});

describe('10. not-interested-until expired', () => {
    it('becomes mailable again without the tenant clearing anything', () => {
        const r = run(
            [contact({ contactId: 'c1', displayName: 'Dee Otten', email: 'd@x.org' })],
            [{ scope: 'contact', contactId: 'c1', normalizedEmail: null, status: 'not_interested', effectiveUntil: new Date('2026-01-01T00:00:00Z') }],
        );
        expect(r.recipients[0].eligibility).toBe('included');
        expect(r.recipients[0].exclusionReason).toBeNull();
    });

    it('an expired pause also releases', () => {
        const r = run(
            [contact({ contactId: 'c1', displayName: 'A', email: 'a@x.org' })],
            [{ scope: 'contact', contactId: 'c1', normalizedEmail: null, status: 'paused', effectiveUntil: new Date('2026-06-01T00:00:00Z') }],
        );
        expect(r.recipients[0].eligibility).toBe('included');
    });
});

describe('11. archived relationship behavior', () => {
    it('surfaces an archived organization for review rather than silently mailing', () => {
        const r = run([contact({
            contactId: 'c1', displayName: 'Jordan Fields', email: 'j@oldmill.org',
            archivedAt: new Date('2026-03-15T00:00:00Z'),
            organizations: [{ customerId: 'o1', name: 'Old Mill', archived: true }],
        })]);
        expect(r.recipients[0].eligibility).toBe('needs_review');
        expect(r.needsReviewCount).toBe(1);
    });

    it('excludes people with no current relationship entirely', () => {
        const r = run([contact({ contactId: 'c1', displayName: 'Retail Only', email: 'r@x.org', organizations: [] })]);
        expect(r.recipients).toHaveLength(0);
    });
});

describe('12. an active campaign does not exclude', () => {
    it('says nothing about campaigns at all — planning ahead is allowed', () => {
        const r = run([contact({ contactId: 'c1', displayName: 'Kim', email: 'k@x.org' })]);
        expect(r.includedCount).toBe(1);
    });
});

describe('13. repeated calculation is stable', () => {
    it('produces identical output, so re-running cannot duplicate recipients', () => {
        const input = [
            contact({ contactId: 'c1', displayName: 'B', email: 'shared@x.org' }),
            contact({ contactId: 'c2', displayName: 'A', email: 'shared@x.org' }),
            contact({ contactId: 'c3', displayName: 'C', email: null }),
        ];
        expect(JSON.stringify(run(input))).toEqual(JSON.stringify(run(input)));
        expect(run(input).recipients.filter((x) => x.normalizedEmail === 'shared@x.org')).toHaveLength(1);
    });
});

describe('needs-review flag', () => {
    it('surfaces a flagged contact without excluding them outright', () => {
        const r = run([contact({
            contactId: 'c1', displayName: 'Sam', email: 's@x.org',
            needsReview: true, reviewReason: 'Shares a delivery address with another organization',
        })]);
        expect(r.recipients[0].eligibility).toBe('needs_review');
        expect(r.recipients[0].exclusionDetail).toMatch(/delivery address/i);
    });
});

describe('suppression precedence', () => {
    it('unsubscribe wins over a needs-review flag', () => {
        const r = run(
            [contact({ contactId: 'c1', displayName: 'A', email: 'a@x.org', needsReview: true })],
            [{ scope: 'contact', contactId: 'c1', normalizedEmail: null, status: 'unsubscribed', effectiveUntil: null }],
        );
        expect(r.recipients[0].eligibility).toBe('excluded');
        expect(r.recipients[0].exclusionReason).toBe('unsubscribed');
    });

    it('a subscribed preference never suppresses', () => {
        const r = run(
            [contact({ contactId: 'c1', displayName: 'A', email: 'a@x.org' })],
            [{ scope: 'contact', contactId: 'c1', normalizedEmail: null, status: 'subscribed', effectiveUntil: null }],
        );
        expect(r.recipients[0].eligibility).toBe('included');
    });
});
