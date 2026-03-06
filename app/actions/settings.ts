
"use server";

import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { revalidatePath } from 'next/cache';

export async function updateCalendarUrl(url: string) {
    const session = await auth();
    if (!session?.user?.businessId) {
        throw new Error('Unauthorized');
    }

    let urlToSave = url.trim();

    // 1. Extract src if iframe
    if (urlToSave.includes('<iframe')) {
        const srcMatch = urlToSave.match(/src="([^"]+)"/);
        if (srcMatch && srcMatch[1]) urlToSave = srcMatch[1];
    }

    // 2. Handle "Browser URL" with cid (Base64 encoded email)
    // e.g. https://calendar.google.com/calendar/u/0?cid=bGRubGVudGVycHJpc2VzQGdtYWlsLmNvbQ
    if (urlToSave.includes('cid=')) {
        try {
            const urlObj = new URL(urlToSave);
            const cid = urlObj.searchParams.get('cid');
            if (cid) {
                const decodedEmail = atob(cid);
                urlToSave = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(decodedEmail)}&ctz=America%2FChicago`;
            }
        } catch (e) {
            console.error("Failed to parse CID url", e);
        }
    }

    // 3. Ensure it's an embed URL if it's a public google calendar link but missing /embed
    // e.g. https://calendar.google.com/calendar/public/u/0/email@gmail.com
    if (urlToSave.includes('calendar.google.com/calendar/') && !urlToSave.includes('/embed')) {
        // Try to convert public URL to embed URL
        // From: .../calendar/public/u/0/email@gmail.com
        // To: .../calendar/embed?src=email@gmail.com
        const publicMatch = urlToSave.match(/\/calendar\/public\/u\/0\/([^/]+)/);
        if (publicMatch && publicMatch[1]) {
            urlToSave = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(publicMatch[1])}&ctz=America%2FChicago`;
        }
    }

    try {
        await prisma.business.update({
            where: { id: session.user.businessId },
            data: { google_calendar_url: urlToSave }
        });

        revalidatePath('/');
        revalidatePath('/calendar');
        revalidatePath('/settings');
        return { success: true };
    } catch (error) {
        console.error("Failed to update calendar URL:", error);
        return { success: false, error: "Failed to save calendar URL" };
    }
}
