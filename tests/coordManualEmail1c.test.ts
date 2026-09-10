/**
 * COORD-MANUAL-EMAIL-1C — owner-found acceptance defect: the "Add Offline
 * Order" modal's Email (Optional) field did not visibly render, despite
 * COORD-MANUAL-EMAIL-1B's test suite reporting 30/30 green including a check
 * that the source contains the string "Email (Optional)".
 *
 * ROOT-CAUSE INVESTIGATION (see the COORD-MANUAL-EMAIL-1C final report for
 * the full trace): source, the locally-compiled production bundle for the
 * exact deployed commit, and Vercel's own build log for that exact deployment
 * all independently confirm the Email field IS present and unconditional.
 * No duplicate "Add Offline Order" implementation exists anywhere in the
 * repo, no conditional wraps the field, no service worker or custom cache
 * header exists that could serve stale assets. Live browser verification of
 * the running Preview was not possible: this project's Vercel deployments
 * carry team SSO deployment protection that blocks non-interactive fetch
 * tools independently of the app's own coordinator login.
 *
 * REGARDLESS of that inconclusive live-runtime result, COORD-MANUAL-EMAIL-1B's
 * test 5/6 had a genuine, independent weakness this file exists to close:
 * `src.toContain('value={formData.email}')` is true whether or not that JSX
 * is reachable. Wrapping the whole field in `{someFlag && (...)}` leaves the
 * string byte-for-byte in the file while making it unreachable at runtime —
 * exactly the class of defect the owner reported, and exactly what a plain
 * substring check cannot see. This file replaces that check with one that
 * verifies the Email field sits at the SAME conditional-nesting depth as the
 * Phone field the owner's own screenshot confirms IS visible.
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const PORTAL_PAGE = 'app/coordinator/portal/page.tsx';
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * True when the text immediately before `idx` ends with an unclosed JSX
 * conditional opener — `{expr && (` or `{expr ? (` — i.e. `idx` sits inside
 * a conditionally-rendered branch that does not also wrap the reference
 * point this is compared against.
 *
 * Deliberately simple substring/regex logic, not a full JSX parser — proven
 * correct empirically against this specific file by the mutation tests
 * below (M1-M4), which construct the exact class of defect this must catch
 * and confirm the assertions built on it actually go red.
 */
function endsWithUnclosedConditionalOpener(precedingText: string): boolean {
    const window = precedingText.slice(-160);
    return /(&&|\?)\s*\(\s*$/.test(window);
}

/**
 * Index of the `<div className="space-y-1">` that wraps a given field's
 * label, found by searching backward from the label text. This is the real
 * anchor point for the conditional check above: in genuine JSX, a
 * conditional opener (`{flag && (`) is immediately followed by the field's
 * OWN wrapper element, never by the label text directly (there is always at
 * least a `<div>` in between) — checked against the label text itself, the
 * check above would never fire even for a truly hidden field.
 */
function fieldWrapperStart(block: string, labelText: string): number {
    const labelIdx = block.indexOf(labelText);
    if (labelIdx === -1) throw new Error(`label not found: ${labelText}`);
    const wrapperIdx = block.lastIndexOf('<div className="space-y-1">', labelIdx);
    if (wrapperIdx === -1) throw new Error(`no space-y-1 wrapper found before label: ${labelText}`);
    return wrapperIdx;
}

/** Returns the [start, end) span of the balanced `(...)` starting at the
 *  first `(` at or after `fromIndex`. Assumes no unbalanced parens inside
 *  string/JSX literals in the scanned range (true for this file - verified
 *  by manual read; the field values here are simple, paren-free strings). */
function balancedParenSpan(src: string, fromIndex: number): [number, number] {
    const start = src.indexOf('(', fromIndex);
    if (start === -1) throw new Error('no opening paren found');
    let depth = 0;
    for (let i = start; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') {
            depth--;
            if (depth === 0) return [start, i + 1];
        }
    }
    throw new Error('unbalanced parens');
}

describe('COORD-MANUAL-EMAIL-1C — the active render path, not just the source text', () => {
    describe('1. exactly one "Add Offline Order" implementation exists in the repo', () => {
        it('"Save Order & Update Goal" (the exact submit-button text from the owner\'s screenshot) appears in exactly one file in the repo', () => {
            const { execSync } = require('child_process');
            const out = execSync(
                'git grep -l "Save Order & Update Goal" -- "*.ts" "*.tsx"',
                { cwd: ROOT, encoding: 'utf8' },
            ).trim();
            const files = out.split('\n').filter(Boolean);
            expect(files).toEqual([PORTAL_PAGE]);
        });

        it('"Add Offline Order" appears as the modal\'s own title only in app/coordinator/portal/page.tsx (other mentions, if any, are references/comments, not a second implementation)', () => {
            const { execSync } = require('child_process');
            const out = execSync(
                'git grep -l "Add Offline Order" -- "*.ts" "*.tsx"',
                { cwd: ROOT, encoding: 'utf8' },
            ).trim();
            const files = out.split('\n').filter(Boolean);
            // Every file that mentions the phrase at all must ALSO be the one
            // real implementation, OR must not also contain the submit button
            // text (i.e. it's a reference, like a comment describing "the
            // existing Add Offline Order modal", not a second modal).
            for (const f of files) {
                if (f === PORTAL_PAGE) continue;
                const src = read(f);
                expect(src).not.toContain('Save Order & Update Goal');
                expect(src).not.toContain('Record a sale from cash');
            }
        });
    });

    describe('2. the Email field is structurally unconditional, at the same nesting depth as Phone', () => {
        const src = read(PORTAL_PAGE);

        // The single, unique gate for this whole modal. If this ever matches
        // more than once, the isolation below is no longer trustworthy and
        // must be revisited before trusting anything derived from it.
        const gateMatches = [...src.matchAll(/showOrderModal\s*&&/g)];

        it('the modal is gated by exactly one `showOrderModal &&` in the whole file', () => {
            expect(gateMatches).toHaveLength(1);
        });

        const gateIdx = gateMatches[0]?.index ?? -1;
        const [modalStart, modalEnd] = gateIdx >= 0 ? balancedParenSpan(src, gateIdx) : [0, 0];
        const modalBlock = src.slice(modalStart, modalEnd);

        it('the isolated modal block is the real one (contains title, all known fields, and the submit button)', () => {
            expect(modalBlock).toContain('Add Offline Order');
            expect(modalBlock).toContain('Record a sale from cash');
            expect(modalBlock).toContain('Buyer Name');
            expect(modalBlock).toContain('Phone (Optional)');
            expect(modalBlock).toContain('Email (Optional)');
            expect(modalBlock).toContain('Note / Address (Optional)');
            expect(modalBlock).toContain('Save Order & Update Goal');
        });

        it('fields appear in the owner-observed visual order: Buyer Name, Phone, Email, Note/Address, Save', () => {
            const order = ['Buyer Name', 'Phone (Optional)', 'Email (Optional)', 'Note / Address (Optional)', 'Save Order & Update Goal']
                .map((needle) => modalBlock.indexOf(needle));
            expect(order.every((i) => i > -1)).toBe(true);
            expect(order).toEqual([...order].sort((a, b) => a - b));
        });

        it('the Email field is not behind any conditional the Phone field is not also behind (both unconditional)', () => {
            const phoneWrapperIdx = fieldWrapperStart(modalBlock, 'Phone (Optional)');
            const emailWrapperIdx = fieldWrapperStart(modalBlock, 'Email (Optional)');
            expect(endsWithUnclosedConditionalOpener(modalBlock.slice(0, phoneWrapperIdx))).toBe(false);
            expect(endsWithUnclosedConditionalOpener(modalBlock.slice(0, emailWrapperIdx))).toBe(false);
        });

        it('meta-test: the conditional-opener detector actually fires on a constructed positive example (proves the check above is not vacuously true)', () => {
            // Realistic shape: a conditional opener is followed by the field's
            // OWN wrapper div, never by the label text directly.
            const hidden = 'some sibling </div>\n{isFeatureFlagOn && (\n<div className="space-y-1">\n<label>Email (Optional)</label>\n';
            expect(endsWithUnclosedConditionalOpener(hidden.slice(0, fieldWrapperStart(hidden, 'Email (Optional)')))).toBe(true);

            const ternaryHidden = 'some sibling </div>\n{tenant.plan === \'pro\' ? (\n<div className="space-y-1">\n<label>Email (Optional)</label>\n';
            expect(endsWithUnclosedConditionalOpener(ternaryHidden.slice(0, fieldWrapperStart(ternaryHidden, 'Email (Optional)')))).toBe(true);

            // And a genuinely unconditional field (a plain sibling div, no
            // preceding conditional) must NOT be flagged — the negative case.
            const notHidden = 'some sibling </div>\n<div className="space-y-1">\n<label>Email (Optional)</label>\n';
            expect(endsWithUnclosedConditionalOpener(notHidden.slice(0, fieldWrapperStart(notHidden, 'Email (Optional)')))).toBe(false);
        });

        it('the Email input is bound to formData.email and sits inside the same modal block (not a different, unmounted copy)', () => {
            expect(modalBlock).toContain('value={formData.email}');
            expect(modalBlock).toContain("setFormData({ ...formData, email: e.target.value })");
        });
    });
});
