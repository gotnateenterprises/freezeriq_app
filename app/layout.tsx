import { Plus_Jakarta_Sans } from "next/font/google";
import Sidebar from '@/components/Sidebar';
import './globals.css';

import { ThemeProvider } from '@/components/ThemeProvider';

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"] });

export const metadata = {
    title: 'FreezerIQ',
    description: 'Intelligence for your Kitchen.',
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en">
            <body className={`${jakarta.className} antialiased bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-slate-100 h-screen overflow-hidden transition-colors duration-300`}>
                <ThemeProvider>
                    <div className="flex h-full print:block print:h-auto">
                        <div className="print:hidden">
                            <Sidebar />
                        </div>
                        <main className="flex-1 p-8 h-full overflow-y-auto overflow-x-hidden ml-[280px] print:ml-0 print:p-0 print:h-auto print:overflow-visible">
                            {children}
                        </main>
                    </div>
                </ThemeProvider>
            </body>
        </html>
    );
}
