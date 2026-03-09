import { Plus_Jakarta_Sans, Playfair_Display, DM_Serif_Display, Outfit } from "next/font/google";
import Sidebar from '@/components/Sidebar';
import './globals.css';

import { ThemeProvider } from '@/components/ThemeProvider';
import TenantThemeProvider from '@/components/TenantThemeProvider';
import { AuthProvider } from '@/components/AuthProvider';
import { auth } from '@/auth';

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
            </body>
        </html>
    );
}
