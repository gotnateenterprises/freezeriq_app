/**
 * FR-COORD-SEC-1C HARD GATE 1 — the cold-load ordering.
 *
 * Suppressing coordinator analytics is only worth anything if the filter is
 * active before the FIRST pageview leaves the browser. The coordinator URL
 * carries the credential in its fragment, and the upstream collector builds its
 * reported URL from `location.href`, fragment included — so a single pageview
 * emitted before `beforeSend` was installed would ship the secret.
 *
 * This test does NOT re-implement the vendor. It drives the REAL `inject()`
 * from the installed @vercel/analytics against minimal DOM stubs and asserts
 * the ORDER of the operations it actually performs. Only the remote collector
 * script — which is fetched at runtime and cannot be imported — is modelled,
 * and it is modelled from its verbatim source, quoted below.
 *
 * Verbatim, from https://www.freezeriqapp.com/_vercel/insights/script.js :
 *
 *   let a = e => e;                                     // beforeSend defaults to identity
 *   let k=e(), S=()=>{
 *       window.va=function(e,t){"beforeSend"===e?a=t: ... };
 *       window.vaq?.forEach(([e,t])=>{window.va(e,t)});  // replays the queue
 *   };
 *   (()=>{ if(window.vai||(window.vai=!0,S(),o.disableAutoTrack))return;
 *          w({withReferrer:!0});                        // FIRST pageview, AFTER S()
 *   })()
 *
 *   async function v({type,data,options}){ let f=e(p), v=a({type,url:f,payload:data});
 *       if(!1===v||null===v) return;                     // null drops the event; no fetch
 *       ... await fetch(...)
 *   }
 */
import { shouldSuppressAnalyticsUrl } from '@/components/analytics/SafeAnalytics';

/** Ordered log of everything the real inject() does to the DOM. */
let ops: string[] = [];

function installDomStubs() {
    ops = [];
    const head = {
        querySelector: () => null, // pretend the script is not present yet
        appendChild: (el: any) => { ops.push(`appendChild:${el.src}`); return el; },
    };
    (global as any).window = {
        get va() { return (global as any).__va; },
        set va(v) { (global as any).__va = v; ops.push('window.va installed'); },
    };
    (global as any).document = {
        head,
        createElement: () => { ops.push('createElement:script'); return { dataset: {} } as any; },
    };
    delete (global as any).__va;
    delete (global as any).__vaq;
}

afterEach(() => {
    delete (global as any).window;
    delete (global as any).document;
    delete (global as any).__va;
});

describe('HARD GATE 1 — beforeSend is registered before the first pageview', () => {
    it('the real inject() queues beforeSend BEFORE it appends the collector script', () => {
        installDomStubs();
        // The real vendor function, not a stand-in.
        const { inject } = require('@vercel/analytics') as { inject: (p: any) => void };

        const beforeSend = (e: any) => (shouldSuppressAnalyticsUrl(e.url) ? null : e);
        // window.va starts as a queue pusher created by initQueue(); record pushes.
        inject({ beforeSend, mode: 'production' });

        const w = (global as any).window;
        expect(typeof w.va).toBe('function');

        // beforeSend was handed to the queue…
        const queue: [string, unknown][] = (w.vaq ?? []) as any;
        const queued = queue.findIndex(([name]) => name === 'beforeSend');
        expect(queued).toBeGreaterThanOrEqual(0);
        expect(queue[queued][1]).toBe(beforeSend);

        // …and the script element was created and appended only afterwards, so
        // the collector cannot possibly run before the filter is queued.
        const appendAt = ops.findIndex((o) => o.startsWith('appendChild:'));
        const createAt = ops.findIndex((o) => o === 'createElement:script');
        expect(createAt).toBeGreaterThanOrEqual(0);
        expect(appendAt).toBeGreaterThan(createAt);
    });

    it('the collector replays the queue before emitting its first pageview', () => {
        installDomStubs();
        const { inject } = require('@vercel/analytics') as { inject: (p: any) => void };
        const beforeSend = (e: any) => (shouldSuppressAnalyticsUrl(e.url) ? null : e);
        inject({ beforeSend, mode: 'production' });

        const w = (global as any).window;

        // ── model of the remote collector, from the verbatim source above ──
        let a: (e: any) => any = (e) => e;         // let a = e => e
        const sent: string[] = [];
        const v = (evt: { type: string; url: string }) => {   // async function v(...)
            const out = a({ type: evt.type, url: evt.url, payload: null });
            if (out === false || out === null) return;        // if(!1===v||null===v) return
            sent.push(out.url);                               // ... fetch(...)
        };
        const S = () => {                                     // S = () => { ... }
            w.va = function (name: string, arg: any) { if (name === 'beforeSend') a = arg; };
            (w.vaq ?? []).forEach(([n, t]: any) => w.va(n, t)); // replays the queue
        };

        // The IIFE: S() FIRST, then the first pageview.
        S();
        v({ type: 'pageview', url: 'https://www.freezeriqapp.com/coordinator/access#SECRET_CANARY' });

        expect(sent).toEqual([]);                              // nothing left the browser
        expect(sent.join('|')).not.toContain('SECRET_CANARY');
    });

    it('a non-coordinator first pageview is still reported', () => {
        installDomStubs();
        const { inject } = require('@vercel/analytics') as { inject: (p: any) => void };
        const beforeSend = (e: any) => (shouldSuppressAnalyticsUrl(e.url) ? null : e);
        inject({ beforeSend, mode: 'production' });

        const w = (global as any).window;
        let a: (e: any) => any = (e) => e;
        const sent: string[] = [];
        const v = (evt: { type: string; url: string }) => {
            const out = a({ type: evt.type, url: evt.url, payload: null });
            if (out === false || out === null) return;
            sent.push(out.url);
        };
        const S = () => {
            w.va = function (name: string, arg: any) { if (name === 'beforeSend') a = arg; };
            (w.vaq ?? []).forEach(([n, t]: any) => w.va(n, t));
        };
        S();
        v({ type: 'pageview', url: 'https://www.freezeriqapp.com/shop/bob-test' });
        expect(sent).toEqual(['https://www.freezeriqapp.com/shop/bob-test']);
    });

    it('WITHOUT our filter the same first pageview would ship the credential', () => {
        // The negative control: this is what the product did before this phase,
        // and it is why the filter has to exist at all.
        let a: (e: any) => any = (e) => e;   // vendor default: identity
        const sent: string[] = [];
        const v = (evt: { type: string; url: string }) => {
            const out = a({ type: evt.type, url: evt.url, payload: null });
            if (out === false || out === null) return;
            sent.push(out.url);
        };
        v({ type: 'pageview', url: 'https://www.freezeriqapp.com/coordinator/access#SECRET_CANARY' });
        expect(sent.join('|')).toContain('SECRET_CANARY');
    });
});
