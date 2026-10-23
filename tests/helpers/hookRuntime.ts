/**
 * A hook runtime small enough to drive a REAL client component without a DOM.
 *
 * No jsdom or react-test-renderer is installed. While `runtime.ctx` is set, `useState`, `useRef`
 * and `useMemo` are served from per-mount slots and effects are skipped; otherwise (for example
 * under renderToStaticMarkup) the real hooks run untouched.
 *
 * Usage, in a test file:
 *
 *     jest.mock('react', () => require('./helpers/hookRuntime').createReactMock());
 *     const m = mountComponent(Component, props);   // m.tree is the rendered element tree
 *     await clickable.props.onClick();  m.render();  // then re-render to read the new state
 *
 * Function components that use no hooks are expanded while the tree is walked, so a parent's
 * children (panels, lines) can be found and clicked like host elements.
 */
export const runtime: { ctx: null | { states: any[]; refs: any[]; si: number; ri: number } } = { ctx: null };

export function createReactMock() {
    const actual = jest.requireActual('react');
    return {
        ...actual,
        useState: (init: any) => {
            if (!runtime.ctx) return actual.useState(init);
            const h = runtime.ctx; const i = h.si++;
            if (!(i in h.states)) h.states[i] = typeof init === 'function' ? init() : init;
            return [h.states[i], (v: any) => { h.states[i] = typeof v === 'function' ? v(h.states[i]) : v; }];
        },
        useRef: (v: any) => {
            if (!runtime.ctx) return actual.useRef(v);
            const h = runtime.ctx; const i = h.ri++;
            if (!(i in h.refs)) h.refs[i] = { current: v };
            return h.refs[i];
        },
        useMemo: (fn: any, deps: any) => (runtime.ctx ? fn() : actual.useMemo(fn, deps)),
        useEffect: (fn: any, deps: any) => (runtime.ctx ? undefined : actual.useEffect(fn, deps)),
    };
}

export interface Mounted {
    /** The element tree from the most recent render. */
    readonly tree: any;
    /** Re-run the component against the current state and props; returns the new tree. */
    render(): any;
    /** Replace some props, then re-render. */
    setProps(next: Record<string, any>): any;
}

export function mountComponent(Component: any, initialProps: Record<string, any>): Mounted {
    const ctx = { states: [] as any[], refs: [] as any[], si: 0, ri: 0 };
    let props = { ...initialProps };
    let tree: any;
    const render = () => {
        ctx.si = 0; ctx.ri = 0; runtime.ctx = ctx;
        try { tree = Component(props); } finally { runtime.ctx = null; }
        return tree;
    };
    render();
    return {
        get tree() { return tree; },
        render,
        setProps(next) { props = { ...props, ...next }; return render(); },
    };
}

export const walk = (node: any, visit: (el: any) => void) => {
    if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return;
    if (Array.isArray(node)) { node.forEach((c) => walk(c, visit)); return; }
    if (typeof node === 'object' && node.props !== undefined) {
        if (typeof node.type === 'function') { walk(node.type(node.props), visit); return; } // hookless components
        visit(node);
        walk(node.props.children, visit);
    }
};

export const textOf = (node: any): string => {
    let out = '';
    const go = (x: any) => {
        if (x === null || x === undefined || typeof x === 'boolean') return;
        if (typeof x === 'string' || typeof x === 'number') { out += String(x); return; }
        if (Array.isArray(x)) { x.forEach(go); return; }
        if (typeof x === 'object' && x.props !== undefined) go(typeof x.type === 'function' ? x.type(x.props) : x.props.children);
    };
    go(node);
    return out.replace(/\s+/g, ' ').trim();
};

export const findAll = (tree: any, pred: (el: any) => boolean): any[] => {
    const hits: any[] = [];
    walk(tree, (el) => { if (pred(el)) hits.push(el); });
    return hits;
};
