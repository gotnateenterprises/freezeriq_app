"use client";

import { useEffect } from 'react';

// In a real implementation, this would likely take props from a server component
// or fetch settings via a hook.
export default function TenantThemeProvider() {
    useEffect(() => {
        const fetchBranding = async () => {
            try {
                const res = await fetch('/api/tenant/branding');
                if (res.ok) {
                    const data = await res.json();

                    if (data.primary_color) {
                        document.documentElement.style.setProperty('--color-primary', data.primary_color);
                        document.documentElement.style.setProperty('--primary', data.primary_color);
                    }

                    if (data.secondary_color) {
                        document.documentElement.style.setProperty('--color-secondary', data.secondary_color);
                        document.documentElement.style.setProperty('--secondary', data.secondary_color);
                    }
                }
            } catch (e) {
                console.error("Failed to apply tenant theme", e);
            }
        };

        fetchBranding();
    }, []);

    return null;
}
