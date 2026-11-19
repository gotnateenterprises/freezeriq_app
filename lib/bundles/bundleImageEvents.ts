/**
 * BUNDLE-POSTER-USE-AS-IMAGE-1 — "this bundle's official image just changed", inside one page.
 *
 * The Bundle Poster panel and the bundle editor are siblings on the bundle page. When the panel's
 * "Use as Bundle Image" has SAVED a poster as the bundle's image, it announces the new URL; the editor
 * shows it in its existing Bundle Image area and keeps it in its form, so the next "Save Bundle"
 * sends the new image instead of putting the previous one back.
 *
 * Browser-only and same-page only: a window event carrying the bundle id, which the editor checks
 * against its own bundle — an announcement for any other bundle is ignored.
 */

import { useEffect, useRef } from 'react';

export const BUNDLE_IMAGE_PUBLISHED_EVENT = 'freezeriq:bundle-image-published';

export interface BundleImagePublishedDetail {
    bundleId: string;
    imageUrl: string;
}

const pageTarget = (): EventTarget | null => (typeof window !== 'undefined' ? window : null);

export function announceBundleImagePublished(bundleId: string, imageUrl: string, target: EventTarget | null = pageTarget()): boolean {
    if (!target || !bundleId || !imageUrl) return false;
    target.dispatchEvent(new CustomEvent<BundleImagePublishedDetail>(BUNDLE_IMAGE_PUBLISHED_EVENT, { detail: { bundleId, imageUrl } }));
    return true;
}

/** The new image URL when `event` announces one for `bundleId`; otherwise null. */
export function publishedImageFor(event: Event, bundleId: string): string | null {
    const detail = (event as CustomEvent<unknown>).detail as Partial<BundleImagePublishedDetail> | null | undefined;
    if (!detail || typeof detail !== 'object') return null;
    if (detail.bundleId !== bundleId || typeof detail.imageUrl !== 'string' || !detail.imageUrl) return null;
    return detail.imageUrl;
}

export function subscribeBundleImagePublished(
    bundleId: string,
    onPublished: (imageUrl: string) => void,
    target: EventTarget | null = pageTarget(),
): () => void {
    if (!target || !bundleId) return () => {};
    const handler = (event: Event) => {
        const url = publishedImageFor(event, bundleId);
        if (url) onPublished(url);
    };
    target.addEventListener(BUNDLE_IMAGE_PUBLISHED_EVENT, handler);
    return () => target.removeEventListener(BUNDLE_IMAGE_PUBLISHED_EVENT, handler);
}

/** For the bundle editor: call `onPublished` with the new URL whenever THIS bundle's image is published. */
export function useBundleImagePublished(bundleId: string | null | undefined, onPublished: (imageUrl: string) => void): void {
    const latest = useRef(onPublished);
    latest.current = onPublished;
    useEffect(() => {
        if (!bundleId) return;
        return subscribeBundleImagePublished(bundleId, (url) => latest.current(url));
    }, [bundleId]);
}
