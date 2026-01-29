import CalendarWidget from '@/components/CalendarWidget';

export default function CalendarPage() {
    return (
        <div className="max-w-7xl mx-auto pb-20">
            <div className="mb-8">
                <h1 className="text-4xl font-black text-slate-900 dark:text-white tracking-tight">Calendar</h1>
                <p className="text-slate-500 dark:text-slate-400 mt-2 text-lg">
                    View and manage your schedule
                </p>
            </div>

            <CalendarWidget />
        </div>
    );
}
