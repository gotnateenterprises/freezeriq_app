import { Plus_Jakarta_Sans, Playfair_Display, DM_Serif_Display, Outfit } from "next/font/google";
import Sidebar from '@/components/Sidebar';
import { Toaster } from 'sonner';
import './globals.css';

import { ThemeProvider } from '@/components/ThemeProvider';
import TenantThemeProvider from '@/components/TenantThemeProvider';
import { AuthProvider } from '@/components/AuthProvider';
import { auth } from '@/auth';
// FR-COORD-SEC-1B: <Analytics/> reports location.href, fragment included, so it
// is wrapped in a client filter that drops every /coordinator event. See
// components/analytics/SafeAnalytics.tsx for the verified upstream behaviour.
import SafeAnalytics from '@/components/analytics/SafeAnalytics';
import { SpeedInsights } from '@vercel/speed-insights/next';

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: '--font-jakarta' });
const playfair = Playfair_Display({ subsets: ["latin"], variable: '--font-playfair' });
const dmSerif = DM_Serif_Display({ weight: '400', subsets: ["latin"], variable: '--font-dm-serif' });
const outfit = Outfit({ subsets: ["latin"], variable: '--font-outfit' });

import LayoutWrapper from '@/components/LayoutWrapper';

export const metadata = {
    title: 'FreezerIQ™',
    description: 'Intelligence for your Kitchen.',
};

export const viewport = {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 1,
};

export default async function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const session = await auth();
    const hasSession = !!session?.user;

    return (
        <html lang="en">
            <body className={`${jakarta.variable} ${dmSerif.variable} ${outfit.variable} antialiased bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-slate-100 min-h-screen transition-colors duration-300`}>
                <ThemeProvider>
                    <TenantThemeProvider />
                    <AuthProvider session={session}>
                        <LayoutWrapper hasSession={hasSession}>
                            {children}
                        </LayoutWrapper>
                    </AuthProvider>
                </ThemeProvider>
                <Toaster position="top-center" richColors />
                <SafeAnalytics />
                <SpeedInsights />
            </body>
        </html>
    );
}
