import Link from 'next/link';

export default function HomePage() {
    return (
        <div className="min-h-screen bg-brand-cream dark:bg-slate-950 flex flex-col items-center justify-center p-6 text-center">
            <h1 className="text-5xl md:text-7xl font-serif text-slate-900 dark:text-white mb-6 tracking-tight">
                Welcome to <span className="text-brand-teal">FreezerIQ</span>
            </h1>
            <p className="text-xl text-slate-600 dark:text-slate-300 max-w-2xl mb-12 font-medium">
                The ultimate operating system for growing your freezer meal business. Turn home-cooked meals into a recurring revenue empire.
            </p>
            <div className="flex gap-4">
                <Link href="/login" className="bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-8 py-4 rounded-full font-black uppercase text-xs tracking-widest hover:scale-105 transition-transform">
                    Login to Dashboard
                </Link>
            </div>
        </div>
    );
}
