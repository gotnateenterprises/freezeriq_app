"use client";

import Link from 'next/link';
import { ChefHat, Heart, Instagram, Facebook, Mail } from 'lucide-react';

interface StorefrontFooterProps {
    businessName: string;
    slug: string;
    primaryColor: string;
    footerText?: string | null;
}

export default function StorefrontFooter({ businessName, slug, primaryColor, footerText }: StorefrontFooterProps) {
    const currentYear = new Date().getFullYear();

    return (
        <footer className="bg-white dark:bg-slate-950 pt-24 pb-12 relative z-30">
            <div className="max-w-7xl mx-auto px-6">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-16 mb-20">
                    {/* Brand Column */}
                    <div className="col-span-1 md:col-span-2 space-y-8">
                        <div className="space-y-4">
                            <h3 className="text-3xl font-black text-slate-900 dark:text-white tracking-tighter">
                                {businessName}
                            </h3>
                            <p className="text-slate-500 dark:text-slate-400 max-w-sm font-medium leading-relaxed">
                                {footerText || "Homemade meals, frozen for your convenience. We believe in the power of a family dinner without the stress of cooking."}
                            </p>
                        </div>
                        <div className="flex gap-4">
                            {[Instagram, Facebook, Mail].map((Icon, i) => (
                                <a key={i} href="#" className="w-12 h-12 rounded-2xl bg-teal-50/50 dark:bg-teal-950/20 flex items-center justify-center text-brand-teal hover:bg-brand-teal hover:text-white transition-all hover:-translate-y-1">
                                    <Icon size={20} />
                                </a>
                            ))}
                        </div>
                    </div>

                    {/* Links Column */}
                    <div className="space-y-6">
                        <h4 className="text-[10px] font-black text-brand-teal uppercase tracking-[0.2em]">Shop</h4>
                        <ul className="space-y-4 text-sm font-black text-slate-500 dark:text-slate-400 uppercase tracking-widest">
                            <li><Link href={`/shop/${slug}#shop-bundles`} className="hover:text-brand-teal transition-colors">Monthly Menus</Link></li>
                            <li><Link href={`/shop/${slug}#fundraisers`} className="hover:text-brand-teal transition-colors">Fundraisers</Link></li>
                            <li><Link href={`/shop/${slug}#extras`} className="hover:text-brand-teal transition-colors">Extra Meals</Link></li>
                        </ul>
                    </div>

                    {/* Community Column */}
                    <div className="space-y-6">
                        <h4 className="text-[10px] font-black text-brand-teal uppercase tracking-[0.2em]">Community</h4>
                        <ul className="space-y-6">
                            <li>
                                <Link href={`/shop/${slug}/raise-funds`} className="group flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-xl bg-teal-50 dark:bg-teal-950 flex items-center justify-center text-brand-teal group-hover:scale-110 transition-transform">
                                        <Heart size={14} fill="currentColor" />
                                    </div>
                                    <span className="text-sm font-black text-slate-500 dark:text-slate-400 uppercase tracking-widest group-hover:text-brand-teal">Raise Funds</span>
                                </Link>
                            </li>
                        </ul>
                    </div>
                </div>

                <div className="border-t border-slate-100 dark:border-slate-900 pt-12 flex flex-col md:flex-row items-center justify-center text-center gap-8">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">&copy; {currentYear} {businessName}. Handcrafted with care.</p>
                </div>
            </div>
        </footer>
    );
}
