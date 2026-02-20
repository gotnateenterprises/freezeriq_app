import CalendarWidget from '@/components/CalendarWidget';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';

export default async function CalendarPage() {
    const session = await auth();
    const businessId = session?.user?.businessId;

    let calendarUrl = '';
    if (businessId) {
        const business = await prisma.business.findUnique({
            where: { id: businessId },
            select: { google_calendar_url: true }
        });
        calendarUrl = business?.google_calendar_url || '';
    }

    return (
        <div className="max-w-7xl mx-auto pb-20">
            <div className="mb-8 px-6">
                <h1 className="text-4xl font-black text-slate-900 dark:text-white tracking-tight">Calendar</h1>
                <p className="text-slate-500 dark:text-slate-400 mt-2 text-lg">
                    View and manage your schedule
                </p>
            </div>

            <div className="px-6">
                <CalendarWidget initialUrl={calendarUrl} hideSettings={true} />
            </div>
        </div>
    );
}
