import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Share2, Heart, ShoppingBag, ArrowLeft, Thermometer, Info, ChevronRight } from 'lucide-react';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import CartDrawer from '@/components/shop/CartDrawer';
import DeliciousGrid from '@/components/shop/DeliciousGrid';
import PurchaseSidebar from '@/components/shop/PurchaseSidebar';

// We need to fetch data on the server
async function getData(slug: string, fundraiserId: string) {
    // 1. Fetch Business
    const business = await prisma.business.findUnique({
        where: { slug },
        select: { id: true, name: true, slug: true, logo_url: true }
    });

    if (!business) return null;

    // 2. Fetch Branding (Raw SQL to bypass missing relation)
    const brandingRecords: any[] = await prisma.$queryRaw`
        SELECT b.* 
        FROM tenant_branding b
        JOIN users u ON b.user_id = u.id
        WHERE u.business_id = ${business.id}
        AND u.role = 'ADMIN'
        LIMIT 1
    `;

    // Default branding if missing
    const branding = brandingRecords[0] || {
        business_name: business.name,
        primary_color: '#4f46e5',
        secondary_color: '#818cf8',
        tagline: '',
        logo_url: business.logo_url
    };

    // Attach branding to business object for compatibility
    (business as any).branding = branding;

    // 3. Fetch Campaign
    const campaigns: any[] = await prisma.$queryRaw`
        SELECT fc.*, c.name as organization_name 
        FROM fundraiser_campaigns fc
        JOIN customers c ON fc.customer_id = c.id
        WHERE fc.id = ${fundraiserId} 
        LIMIT 1
    `;
    const campaign = campaigns[0];

    if (!campaign) return null;

    // 4. Fetch Orders for goal calculation
    const orders: any[] = await prisma.$queryRaw`
        SELECT total_amount FROM orders WHERE campaign_id = ${fundraiserId}
    `;

    // Calculate total raised
    const raised = orders.reduce((sum: number, order: any) => sum + Number(order.total_amount), 0);
    const progress = campaign.goal_amount ? Math.min((raised / Number(campaign.goal_amount)) * 100, 100) : 0;

    // 5. Fetch Bundles
    const bundles: any[] = await prisma.$queryRaw`
        SELECT * FROM bundles 
        WHERE business_id = ${business.id} 
        AND is_active = true
    `;

    const bundleIds = bundles.map(b => b.id);
    let bundleItems: any[] = [];

    if (bundleIds.length > 0) {
        bundleItems = await prisma.$queryRaw`
             SELECT bc.*, r.name as recipe_name
             FROM bundle_contents bc
             JOIN recipes r ON bc.recipe_id = r.id
             WHERE bc.bundle_id IN(${Prisma.join(bundleIds)})
        `;
    }

    const formattedBundles = bundles.map(b => ({
        ...b,
        price: Number(b.price),
        stock_on_hand: Number(b.stock_on_hand),
        items: bundleItems.filter(i => i.bundle_id === b.id).map(i => ({
            ...i,
            quantity: Number(i.quantity),
            recipe: { name: i.recipe_name }
        }))
    }));

    (business as any).bundles = formattedBundles;

    return { business, campaign, raised, progress };
}

export default async function FundraiserPage({ params }: { params: Promise<{ slug: string; fundraiserId: string }> }) {
    const { slug, fundraiserId } = await params;
    const data = await getData(slug, fundraiserId);

    if (!data) notFound();

    const { business, campaign, raised, progress } = data;
    // @ts-ignore
    const primaryColor = business.branding?.primary_color || '#4f46e5';

    // Format currency
    const formatCurrency = (amount: number) => {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
        }).format(amount);
    };

    // Use the first bundle as the "Main Menu" if available
    // @ts-ignore
    const mainBundle = business.bundles[0];

    return (
        <div className="min-h-screen bg-white dark:bg-slate-950 pb-32">
            {/* Immersive Header */}
            <div className="relative pt-12 pb-32 px-4 overflow-hidden">
                {/* Feminine Background Layer */}
                <div className="absolute inset-0 z-0">
                    <div className="absolute inset-0 bg-linear-to-br from-indigo-50/50 via-white to-pink-50/30 dark:from-slate-900 dark:via-slate-950 dark:to-indigo-950/20" />
                    <div className="absolute inset-0 opacity-[0.03]" style={{
                        backgroundImage: 'radial-gradient(circle at 2px 2px, #4f46e5 1px, transparent 0)',
                        backgroundSize: '32px 32px'
                    }} />
                </div>

                <div className="max-w-6xl mx-auto relative z-10">
                    <div className="flex flex-col items-center text-center space-y-8">
                        <Link
                            href={`/shop/${slug}`}
                            className="inline-flex items-center gap-2 text-indigo-600/60 hover:text-indigo-600 transition-all font-black uppercase tracking-[0.2em] text-[10px] bg-white/50 px-5 py-2.5 rounded-full backdrop-blur-md shadow-sm border border-indigo-50"
                        >
                            <ArrowLeft size={14} strokeWidth={3} />
                            Back to {business.name} Shop
                        </Link>

                        <div className="space-y-4">
                            <span className="inline-block bg-indigo-600/10 text-indigo-600 px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-[0.2em] animate-pulse">
                                Live Fundraiser
                            </span>
                            <h1 className="text-5xl md:text-7xl font-black tracking-tight text-slate-900 dark:text-white leading-[1.1]">
                                Supporting <br />
                                <span className="text-indigo-600">{campaign.organization_name}</span>
                            </h1>
                        </div>

                        {/* Goal Progress Card - Refined */}
                        <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl p-10 rounded-[3rem] shadow-[0_32px_64px_-16px_rgba(79,70,229,0.15)] max-w-xl w-full border border-white dark:border-white/10">
                            <div className="flex justify-between items-end mb-6">
                                <div className="text-left">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-1">Impact Raised</p>
                                    <p className="text-5xl font-black text-slate-900 dark:text-white tracking-tight">{formatCurrency(raised)}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-1">Our Goal</p>
                                    <p className="text-xl font-black text-slate-400">{campaign.goal_amount ? formatCurrency(Number(campaign.goal_amount)) : 'No Goal Set'}</p>
                                </div>
                            </div>

                            {/* Progress Bar - Feminine Pro */}
                            <div className="h-6 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden shadow-inner p-1">
                                <div
                                    className="h-full rounded-full transition-all duration-1000 ease-out relative shadow-[0_4px_12px_rgba(79,70,229,0.3)]"
                                    style={{ width: `${progress}%`, backgroundColor: primaryColor }}
                                >
                                    <div className="absolute inset-0 bg-linear-to-r from-white/30 via-transparent to-transparent animate-[shimmer_2s_infinite]"></div>
                                </div>
                            </div>

                            <div className="mt-8 flex items-center justify-center gap-2 py-4 bg-indigo-50/50 dark:bg-indigo-900/20 rounded-2xl border border-indigo-100/30">
                                <Heart className="w-4 h-4 text-pink-500 fill-pink-500" />
                                <p className="text-[10px] font-black text-indigo-600 uppercase tracking-widest">
                                    Help us reach our goal by placing an order!
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Main Content Area - Beehive Two Column */}
            <main className="max-w-7xl mx-auto px-6 -mt-12 relative z-20">
                <div className="flex flex-col lg:flex-row gap-16">
                    {/* Left Column: Photo Grid & About */}
                    <div className="flex-1 space-y-16">
                        {/* The Delicious Grid */}
                        <div className="space-y-6">
                            <div className="flex items-center gap-2 mb-4">
                                <div className="w-10 h-10 rounded-2xl bg-indigo-50 dark:bg-indigo-950 flex items-center justify-center text-indigo-600">
                                    <ShoppingBag size={20} />
                                </div>
                                <h2 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight uppercase tracking-[0.1em]">On The Menu</h2>
                            </div>
                            <DeliciousGrid images={[]} />
                        </div>

                        {/* About This Mission */}
                        {/* @ts-ignore */}
                        {campaign.about_text && (
                            <section className="bg-indigo-50/30 dark:bg-slate-900/50 p-12 rounded-[3.5rem] border border-indigo-100/50 dark:border-slate-800">
                                <div className="flex items-center gap-3 mb-6 font-black uppercase tracking-[0.2em] text-[10px] text-indigo-600">
                                    <Info size={16} />
                                    About This Fundraiser
                                </div>
                                <div className="prose prose-lg dark:prose-invert max-w-none text-slate-600 dark:text-slate-300 font-medium leading-relaxed">
                                    {/* @ts-ignore */}
                                    <p className="whitespace-pre-wrap">{campaign.about_text}</p>
                                </div>
                            </section>
                        )}

                        {/* Fallback for other bundles if multiple exist */}
                        {/* @ts-ignore */}
                        {business.bundles.length > 1 && (
                            <section className="space-y-8 pt-12">
                                <h3 className="text-xl font-black text-slate-400 uppercase tracking-widest text-center">Other Available Bundles</h3>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                    {/* @ts-ignore */}
                                    {business.bundles.slice(1).map((bundle: any) => (
                                        <div key={bundle.id} className="bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-sm hover:shadow-xl transition-all">
                                            <h4 className="text-xl font-black mb-2">{bundle.name}</h4>
                                            <p className="text-sm text-slate-500 mb-6">{bundle.description}</p>
                                            <div className="font-black text-indigo-600 mb-6">${Number(bundle.price).toFixed(2)}</div>
                                            <Link
                                                href={`/shop/${slug}/bundle/${bundle.id}`}
                                                className="block text-center py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-indigo-50 transition-colors"
                                            >
                                                View Details
                                            </Link>
                                        </div>
                                    ))}
                                </div>
                            </section>
                        )}
                    </div>

                    {/* Right Column: Sticky Purchase Box */}
                    <div className="lg:w-[400px]">
                        {mainBundle && (
                            <PurchaseSidebar
                                bundle={mainBundle}
                                primaryColor={primaryColor}
                            />
                        )}

                        <div className="mt-8 p-10 bg-linear-to-br from-indigo-600 to-indigo-700 rounded-[2.5rem] text-white space-y-6 shadow-2xl shadow-indigo-500/20">
                            <h4 className="text-xl font-black leading-tight">Host Your Own Fundraiser</h4>
                            <p className="text-indigo-100 text-sm font-medium leading-relaxed">
                                Need to raise money for your team, school, or church? Freezer meals are the perfect fundraiser.
                            </p>
                            <Link
                                href={`/shop/${slug}/raise-funds`}
                                className="inline-flex items-center gap-2 bg-white text-indigo-600 px-6 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-transform hover:scale-105"
                            >
                                Get Started Today
                                <ChevronRight size={14} strokeWidth={3} />
                            </Link>
                        </div>
                    </div>
                </div>
            </main>

            <CartDrawer
                primaryColor={primaryColor}
                businessId={business.id}
                slug={slug}
                campaignId={fundraiserId}
                campaignParticipantLabel={campaign.participant_label}
            />
        </div>
    );
}
