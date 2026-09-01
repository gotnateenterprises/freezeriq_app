/**
 * FULFILLMENT-CONTINUITY-1A — the fulfillment contract must stay registered.
 *
 * WHY THIS EXISTS
 *
 * The whole point of docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md is to stop
 * future agents silently re-deriving the fundraiser fulfillment rules. A
 * document nobody is told to read cannot do that. CLAUDE.md and GEMINI.md are
 * the read-first index files agents actually load, so registration there is the
 * mechanism, not a formality — FC-1 shipped the contract unregistered and this
 * is the gap that closed it.
 *
 * These are deliberately NARROW assertions: each checks for one specific
 * document path in one specific index file. They are not full-file regexes and
 * they do not pin surrounding wording, so ordinary edits to either index file
 * — including the parked franchise-guardrail work — pass unaffected.
 */
const fs = require('fs');
const path = require('path');

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const CONTRACT = 'docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md';

describe('the canonical fulfillment contract is registered where agents read', () => {
    it('the contract document exists', () => {
        expect(fs.existsSync(path.join(process.cwd(), CONTRACT))).toBe(true);
    });

    it('CLAUDE.md points at it', () => {
        expect(read('CLAUDE.md')).toContain(CONTRACT);
    });

    it('GEMINI.md points at it', () => {
        expect(read('GEMINI.md')).toContain(CONTRACT);
    });

    it('the registration names the surfaces it governs, so the trigger is unambiguous', () => {
        // A bare link is easy to skim past. The entry must say WHEN to read it.
        for (const index of ['CLAUDE.md', 'GEMINI.md']) {
            const line = read(index)
                .split(/\r?\n/)
                .find((l: string) => l.includes(CONTRACT));
            expect(line).toBeDefined();
            for (const surface of ['fundraiser', 'Production', 'label', 'Delivery', 'coordinator', 'tier']) {
                expect(line).toContain(surface);
            }
        }
    });

    it('the contract still declares the four rulings the rest of the code depends on', () => {
        const src = read(CONTRACT);
        expect(src).toContain('FundraiserCampaign.id');
        expect(src).toContain('FundraiserCampaign.pickup_location');
        expect(src).toContain('Bundle.serving_tier');
        expect(src).toContain('OrderItem.variant_size');
    });

    it('the contract no longer carries a manual-order tier exception', () => {
        // FC-1 wrote one; FC-1A disproved it. If a future phase wants to
        // reintroduce a custom-size sale it needs its own price resolution and
        // an explicit product decision — not a silent exception in the contract.
        const src = read(CONTRACT);
        expect(src).not.toContain('## 4.4 The one deliberate exception');
        expect(src).toContain('There is no exception');
    });
});
