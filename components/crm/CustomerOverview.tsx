"use client";

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';

import EmailComposeModal from './EmailComposeModal';
import FundraiserSetup from './FundraiserSetup';
import MarketingFlyer from './MarketingFlyer';
import { ShoppingBag, DollarSign, Mail, Phone, MapPin, User, StickyNote, Plus, Calendar, Eye, Loader2, Archive, RotateCcw, Sparkles, Tag, UtensilsCrossed, Clock } from 'lucide-react';
import StatusPipeline from './StatusPipeline';
import { STATUS_LABELS, STATUS_COLORS, type CustomerStatus } from '@/lib/statusConstants';

// Template Generator (Matches API for default preview)
const generateIntroTemplate = (name: string, orgName?: string) => ({
    subject: `Delicious, stress-free fundraising for ${orgName || 'your group'}`,
    html: `
<p>Hi ${name || 'there'}!</p>
<p>I’d love to help <strong>${orgName || 'your organization'}</strong> raise funds in a way that truly supports your families—by solving dinner time!</p>
<p>With a Freezer Chef fundraiser, you aren't just raising money; you're giving families the gift of a wholesome, homemade dinner without the prep work.</p>

<h3>Why moms and groups love this:</h3>
<ul>
    <li><strong>Families Love It:</strong> Everyone needs dinner! These are comforting, ready-to-go meals (like delicious casseroles and crockpot favorites) that make weeknights easier.</li>
    <li><strong>Totally Stress-Free:</strong> We handle all the prep and sorting. You just smile and hand out the boxes.</li>
    <li><strong>Meaningful Profit:</strong> Your group keeps <strong>20%</strong> of every sale to support your goals.</li>
</ul>

<h3>It’s super simple:</h3>
<ol>
    <li><strong>Pick a Date:</strong> choose a Tuesday, Wednesday, or Thursday for delivery.</li>
    <li><strong>Share the Love:</strong> We provide beautiful flyers and forms effectively done for you.</li>
    <li><strong>Delivery Day:</strong> We bring the meals right to you—distribution takes just 15-30 minutes!</li>
</ol>

<p><strong>Ready to simplify dinner for your community?</strong><br>
I’d love to get a tentative date on the calendar for you or just chat about how we can make this your easiest fundraiser yet.</p>

<p>Just reply to let me know which month you're thinking of!</p>

<p>Warmly,</p>
<p><strong>Laurie</strong><br>
<a href="mailto:Laurie@MyFreezerChef.com">Laurie@MyFreezerChef.com</a><br>
<a href="https://MyFreezerChef.com">MyFreezerChef.com</a></p>
`
});

const generateInfoTemplate = (name: string, bundles: any[]) => ({
    subject: `Getting started with your Freezer Chef Fundraiser!`,
    html: `
<p>Hi ${name || 'there'}!</p>
<p>Thanks for your interest in a Freezer Chef fundraiser! We are so excited to help you raise money and feed your community.</p>

<h3>Here is how it works (The Easy 1-2-3):</h3>
<ol>
    <li><strong>Choose Your Bundles:</strong> Take a look at the Bundles below and let us know which 2 Bundles you'd like to offer (e.g., Family Friendly & Keto).</li>
    <li><strong>Pick Your Date:</strong> Choose your desired delivery date, time and delivery location. We will confirm date if available or get back with an alternative date.</li>
    <li><strong>We Create Your Marketing:</strong> Once you decide, we will build a custom order form, flyer and order tracking form just for your group to start selling!</li>
</ol>

<p>Please complete the short form below with all of the information we need to get you set up in our system and your custom marketing materials ready to go!</p>

<p>Warmly,<br>Laurie</p>

<hr style="border: 1px dashed #ccc; margin: 20px 0;">

<h3>Fundraiser Information:</h3>
<p>
    <strong>Organization Name:</strong><br><br>
    <strong>Contact Name:</strong><br><br>
    <strong>Contact Email:</strong><br><br>
    <strong>Contact Phone:</strong><br><br>
    <strong>Make Checks Payable to:</strong><br><br>
    <strong>Delivery Date:</strong> ________________ <strong>Time:</strong> ________________<br><br>
    <strong>Pickup Location:</strong>
</p>

<h3>Choose 2 Bundles below:</h3>
${bundles.length > 0 ? `
<ul style="list-style: none; padding-left: 0;">
    ${bundles.map((b: any) => `<li style="margin-bottom: 8px;"><input type="checkbox" style="margin-right: 10px;"><strong>${b.name}</strong>: ${b.contents?.map((c: any) => c.recipe?.name).join(', ') || 'Various meals'}</li>`).join('')}
</ul>
` : '<p><em>(No bundles found for this season)</em></p>'}
`
});

const generateMarketingTemplate = (name: string, info: any, campaign?: any) => {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://freezeriq.com';
    const portalUrl = campaign?.portal_token ? `${origin}/coordinator/${campaign.portal_token}` : null;
    const scoreboardUrl = campaign?.public_token ? `${origin}/fundraiser/${campaign.public_token}` : null;
    const guideUrl = campaign?.portal_token ? `${origin}/coordinator/${campaign.portal_token}/guide` : null;

    return {
        subject: `Your Fundraiser Marketing Materials are Ready!`,
        html: `
<p>Hi ${name || 'there'}!</p>
<p>Great news! Your fundraiser is all set up and ready to go.</p>

<div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 20px 0;">
    <h3 style="margin-top: 0; color: #4f46e5;">🚀 Your Coordinator Toolkit</h3>
    <p>We've created a private dashboard for you to track orders and a public scoreboard for your supporters:</p>
    <ul style="padding-left: 20px;">
        ${portalUrl ? `<li><strong>Coordinator Portal:</strong> <a href="${portalUrl}">${portalUrl}</a><br><em>(Record cash/Venmo sales and track progress here)</em></li>` : ''}
        ${guideUrl ? `<li><strong>Success Guide:</strong> <a href="${guideUrl}">How to Smash Your Goal</a><br><em>(Tips for social media, payments, and promotion)</em></li>` : ''}
        ${scoreboardUrl ? `<li><strong>Public Scoreboard:</strong> <a href="${scoreboardUrl}">${scoreboardUrl}</a><br><em>(Share this with your parents and community!)</em></li>` : ''}
    </ul>
</div>

<p>Attached to this email, you'll find your <strong>Offline Marketing Packet</strong>, including:</p>
<ul>
    <li><strong>Digital Flyer:</strong> To share on social media or email.</li>
    <li><strong>Order Form & Tracking Sheet:</strong> To collect orders manually.</li>
</ul>

<h3>Fundraiser Details Refresher:</h3>
<ul>
    <li><strong>Goal Amount:</strong> $${campaign?.goal_amount || info.goal_amount || '1,000'}</li>
    <li><strong>Order Deadline:</strong> ${info.deadline ? new Date(info.deadline + 'T12:00:00').toLocaleDateString() : 'TBD'}</li>
    <li><strong>Delivery Date:</strong> ${info.delivery_date ? new Date(info.delivery_date + 'T12:00:00').toLocaleDateString() : 'TBD'} @ ${info.delivery_time || 'TBD'}</li>
    <li><strong>Pickup Location:</strong> ${info.pickup_location || 'TBD'}</li>
</ul>

<p><strong>Next Steps:</strong><br>
Open your <strong>Success Guide</strong> above to see our recommended social media scripts, and start sharing the public scoreboard link!</p>

<p>Happy Fundraising!</p>

<p>Warmly,<br>Laurie</p>
`
    };
};

const generateSeasonalMenuTemplate = (name: string) => ({
    subject: `Fresh from the Kitchen: Our New Seasonal Menu is Here! 🥘`,
    html: `
<p>Hi ${name || 'there'}!</p>
<p>The seasons are changing, and so is our menu! We've been busy in the kitchen preparing some incredible new dishes that we know your family will love.</p>

<div style="background-color: #f0fdf4; border: 1px solid #dcfce7; border-radius: 12px; padding: 20px; margin: 20px 0;">
    <h3 style="margin-top: 0; color: #166534;">✨ What's New This Season?</h3>
    <ul style="padding-left: 20px;">
        <li><strong>Cozy Comforts:</strong> New family-sized casseroles.</li>
        <li><strong>Fresh & Healthy:</strong> Expanded Keto and Gluten-Free options.</li>
        <li><strong>Chef's Special:</strong> Our limited-time seasonal bundles.</li>
    </ul>
</div>

<p>Skip the meal prep tonight and let us handle the cooking. Our meals are prepared with love, frozen fresh, and ready when you are.</p>

<p><a href="https://freezeriq.com/menu" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Browse the New Menu</a></p>

<p>Warmly,<br>Laurie</p>
`
});

const generateWeMissYouTemplate = (name: string) => ({
    subject: `We miss you! Here's a little something for your next dinner... 🎁`,
    html: `
<p>Hi ${name || 'there'}!</p>
<p>It's been a while since we've seen you at the kitchen! We know life gets busy, and we'd love to help make your weeknights a little easier again.</p>

<p>To welcome you back, please use the code below for <strong>15% OFF</strong> your next order!</p>

<div style="background-color: #eef2ff; border: 2px dashed #4f46e5; border-radius: 12px; padding: 20px; margin: 20px 0; text-align: center;">
    <p style="margin: 0; font-size: 12px; text-transform: uppercase; font-weight: bold; color: #4f46e5;">Your Welcome Back Code</p>
    <h2 style="margin: 10px 0; color: #1e1b4b; letter-spacing: 2px;">WEMISSYOU15</h2>
</div>

<p>Whether it's your old favorites or something new from our seasonal menu, we're ready to stock your freezer with stress-free dinners.</p>

<p>Happy Eating!</p>

<p>Warmly,<br>Laurie</p>
`
});

interface CustomerOverviewProps {
    customer: any;
    onUpdateCustomer: (updates: any) => Promise<void>;
    onEditProfile: () => void;
}

export default function CustomerOverview({ customer, onUpdateCustomer, onEditProfile }: CustomerOverviewProps) {
    // State
    const [notes, setNotes] = useState(customer.notes || '');
    const [typingTimeout, setTypingTimeout] = useState<NodeJS.Timeout | null>(null);

    // Flyer Generation
    const flyerRef = useRef<HTMLDivElement>(null);
    const [flyerData, setFlyerData] = useState<any>(null);
    const [isGeneratingFlyer, setIsGeneratingFlyer] = useState(false);
    const [branding, setBranding] = useState<any>(null);
    // Normalize API status (Title Case) to Enum (UPPER_CASE)
    const normalizedStatus = (customer.status || 'LEAD').toUpperCase().replace(/\s+/g, '_') as CustomerStatus;
    const [status, setStatus] = useState<CustomerStatus>(normalizedStatus);
    const [isArchived, setIsArchived] = useState(customer.archived || false);


    const [isEmailModalOpen, setIsEmailModalOpen] = useState(false);
    const [emailDraft, setEmailDraft] = useState({ subject: '', html: '' });
    const [emailAttachments, setEmailAttachments] = useState<{ filename: string; content: string }[]>([]);
    const [activeEmailContext, setActiveEmailContext] = useState<'intro' | 'info' | 'marketing' | 'custom' | 'seasonal' | 'promotion' | null>(null);

    // Catalog State
    const [catalogs, setCatalogs] = useState<any[]>([]);
    const [showCatalogSelector, setShowCatalogSelector] = useState(false);

    // Computed
    const campaigns = customer.campaigns || [];
    const activeCampaign = campaigns.length > 0 ? campaigns[0] : null;

    // Calculate Top Bundle Habit
    const topBundleHabit = (() => {
        const orders = customer.orders || [];
        if (orders.length === 0) return null;

        const bundleCounts: Record<string, number> = {};
        orders.forEach((order: any) => {
            if (!order.items) return;
            // Parse "1x Bundle Name, 2x Other Bundle"
            const parts = order.items.split(',').map((p: string) => p.trim());
            parts.forEach((part: string) => {
                const match = part.match(/^(\d+)x\s+(.+)$/);
                if (match) {
                    const qty = parseInt(match[1], 10);
                    const name = match[2];
                    bundleCounts[name] = (bundleCounts[name] || 0) + qty;
                }
            });
        });

        const sorted = Object.entries(bundleCounts).sort((a, b) => b[1] - a[1]);
        if (sorted.length === 0) return null;
        return { name: sorted[0][0], count: sorted[0][1] };
    })();

    // Calculate In Progress Orders
    const inProgressStats = (() => {
        const orders = customer.orders || [];
        const filtered = orders.filter((o: any) =>
            ['pending', 'production_ready', 'delivery'].includes((o.status || '').toLowerCase())
        );
        const totalAmount = filtered.reduce((sum: number, o: any) => {
            const amount = parseFloat((o.total || '0').replace(/[^0-9.-]+/g, ""));
            return sum + (isNaN(amount) ? 0 : amount);
        }, 0);
        return {
            count: filtered.length,
            amount: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(totalAmount)
        };
    })();

    // Calculate Weekly Order Total (Rolling 7 Days)
    const weeklyOrderTotal = (() => {
        const orders = customer.orders || [];
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const total = orders.reduce((sum: number, o: any) => {
            const orderDate = new Date(o.created_at || o.date);
            if (orderDate >= sevenDaysAgo) {
                const amount = parseFloat((o.total || '0').replace(/[^0-9.-]+/g, ""));
                return sum + (isNaN(amount) ? 0 : amount);
            }
            return sum;
        }, 0);
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(total);
    })();

    // Effects
    useEffect(() => {
        if (notes !== (customer.notes || '')) {
            if (typingTimeout) clearTimeout(typingTimeout);
            const timeout = setTimeout(() => {
                onUpdateCustomer({ notes });
            }, 1000);
            setTypingTimeout(timeout);
        }
    }, [notes]);

    useEffect(() => {
        fetch('/api/catalogs').then(res => res.json()).then(data => {
            if (Array.isArray(data)) setCatalogs(data);
        });
        fetch('/api/tenant/branding').then(res => res.json()).then(data => {
            setBranding(data);
        }).catch(err => console.error('Error fetching branding:', err));
    }, []);

    // Sync state with props (e.g., after global Save Changes)
    useEffect(() => {
        const normalized = (customer.status || 'LEAD').toUpperCase().replace(/\s+/g, '_') as CustomerStatus;
        setStatus(normalized);
        setIsArchived(customer.archived || false);
    }, [customer.status, customer.archived]);

    const generateFlyerPDF = async (data: any) => {
        setIsGeneratingFlyer(true);
        setFlyerData(data);

        // Wait for render
        await new Promise(resolve => setTimeout(resolve, 300));

        if (!flyerRef.current) {
            console.error("Flyer ref not found");
            setIsGeneratingFlyer(false);
            return null;
        }

        try {
            const html2canvas = (await import('html2canvas')).default;
            const jsPDF = (await import('jspdf')).default;

            const page1El = flyerRef.current.querySelector('#flyer-page-1') as HTMLElement;
            const page2El = flyerRef.current.querySelector('#flyer-page-2') as HTMLElement;

            if (!page1El || !page2El) {
                console.error("Flyer pages not found");
                return null;
            }

            // Capture Page 1
            const canvas1 = await html2canvas(page1El, {
                // @ts-ignore
                scale: 2,
                useCORS: true,
                logging: false
            });

            // Capture Page 2
            const canvas2 = await html2canvas(page2El, {
                // @ts-ignore
                scale: 2,
                useCORS: true,
                logging: false
            });

            const doc = new jsPDF('p', 'pt', 'letter');
            const pageWidth = doc.internal.pageSize.getWidth();
            const pageHeight = doc.internal.pageSize.getHeight();

            // Add Page 1
            doc.addImage(canvas1.toDataURL('image/png'), 'PNG', 0, 0, pageWidth, pageHeight);

            // Add Page 2
            doc.addPage();
            doc.addImage(canvas2.toDataURL('image/png'), 'PNG', 0, 0, pageWidth, pageHeight);

            const pdfBase64 = doc.output('datauristring').split(',')[1];
            return {
                filename: `Marketing Packet - ${customer.name}.pdf`,
                content: pdfBase64
            };
        } catch (e) {
            console.error("Flyer generation failed", e);
            alert("Failed to generate flyer PDF");
            return null;
        } finally {
            setIsGeneratingFlyer(false);
        }
    };

    // Handlers
    const openEmailComposer = (type: 'intro' | 'info' | 'marketing' | 'custom' | 'seasonal' | 'promotion', attachments: any[] = []) => {
        if (!customer.email) {
            alert("Please add an email address to the contact details first.");
            return;
        }

        if (type === 'info') {
            handleSendInfoParams();
            return;
        }

        const orgName = customer.name;
        const firstName = customer.contact_name ? customer.contact_name.split(' ')[0] : '';

        let template;
        if (type === 'intro') {
            template = generateIntroTemplate(firstName, orgName);
        } else if (type === 'marketing') {
            template = generateMarketingTemplate(firstName, customer.fundraiser_info || {}, activeCampaign);
        } else if (type === 'custom') {
            template = { subject: '', html: '' };
        } else if (type === 'seasonal') {
            template = generateSeasonalMenuTemplate(firstName);
        } else if (type === 'promotion') {
            template = generateWeMissYouTemplate(firstName);
        } else {
            template = { subject: '', html: '' };
        }

        setActiveEmailContext(type);
        setEmailDraft({ subject: template.subject, html: template.html });
        setEmailAttachments(attachments);
        setIsEmailModalOpen(true);
    };

    const handleSendInfoParams = () => {
        const active = catalogs.filter(c => c.is_active);

        if (active.length === 0) {
            // Fallback
            // Fix: Do not fallback to customer.name
            const firstName = customer.contact_name ? customer.contact_name.split(' ')[0] : '';
            const template = generateInfoTemplate(firstName, []);
            setEmailDraft({ subject: template.subject, html: template.html });
            setIsEmailModalOpen(true);
            return;
        }

        if (active.length === 1) {
            selectCatalog(active[0]);
        } else {
            setShowCatalogSelector(true);
        }
    };

    const selectCatalog = (catalog: any) => {
        setShowCatalogSelector(false);
        // Fix: Do not fallback to customer.name
        const firstName = customer.contact_name ? customer.contact_name.split(' ')[0] : '';
        const template = generateInfoTemplate(firstName, catalog.bundles || []);
        setEmailDraft({ subject: template.subject, html: template.html });
        setIsEmailModalOpen(true);
    };

    const handleSendEmail = async (subject: string, html: string, attachments: any[] = []) => {
        try {
            const res = await fetch('/api/email/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    to: customer.email,
                    subject,
                    html,
                    attachments,
                    customerId: customer.id,
                    context: activeEmailContext
                })
            });
            const data = await res.json();
            if (res.ok) {
                alert(data.mocked ? "Email Simulated (No API Key)" : "Email Sent Successfully!");
                setIsEmailModalOpen(false);

                // Update local status based on email context
                if (activeEmailContext === 'intro' && status === 'LEAD') {
                    setStatus('SEND_INFO');
                } else if (activeEmailContext === 'info' && status === 'SEND_INFO') {
                    setStatus('FLYERS');
                } else if (activeEmailContext === 'marketing' && status === 'FLYERS') {
                    setStatus('ACTIVE');
                }

                // Legacy campaign update support
                if (activeEmailContext === 'marketing') {
                    await handleCampaignStatusUpdate('Active');
                }
            } else {
                alert("Failed to send: " + data.error);
            }
        } catch (e) {
            alert("Error sending email");
            throw e;
        }
    };

    const handleCampaignStatusUpdate = async (newStatus: string) => {
        if (!activeCampaign) return;

        try {
            const res = await fetch(`/api/campaigns/${activeCampaign.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus })
            });

            if (res.ok) {
                window.location.reload();
            } else {
                alert("Failed to update campaign status");
            }
        } catch (e) {
            console.error(e);
            alert("Error updating campaign");
        }
    };

    const handleStartCampaign = async () => {
        const name = prompt("Enter Campaign Name (e.g., Spring 2026 Fundraiser):");
        if (!name) return;

        try {
            const res = await fetch('/api/campaigns', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customerId: customer.id,
                    name: name,
                    status: 'Lead',
                    startDate: new Date().toISOString()
                })
            });

            if (res.ok) {
                window.location.reload();
            } else {
                const err = await res.json();
                alert(err.error || "Failed to create campaign");
            }
        } catch (e) {
            alert("Error creating campaign");
        }
    };

    const handleManualStatusChange = async (newStatus: CustomerStatus) => {
        if (!confirm(`Are you sure you want to manually change status to ${STATUS_LABELS[newStatus]}?`)) return;

        let statusToSet = newStatus;

        if (newStatus === 'COMPLETE') {
            const choice = confirm("Mark as ACTIVE (OK) or INACTIVE (Cancel)?");
            if (!choice) {
                statusToSet = 'INACTIVE' as CustomerStatus;
            }
        }

        await onUpdateCustomer({ status: statusToSet });
    };

    const handleArchiveToggle = async () => {
        const action = isArchived ? 'unarchive' : 'archive';
        if (!confirm(`Are you sure you want to ${action} this customer?`)) return;

        await onUpdateCustomer({ archived: !isArchived });
    };

    const handleAddTag = async () => {
        const newTag = prompt("Enter new dietary tag (e.g., Dairy Free):");
        if (!newTag) return;

        const currentTags = customer.tags || [];
        if (currentTags.includes(newTag)) {
            alert("Tag already exists");
            return;
        }

        const updatedTags = [...currentTags, newTag];
        await onUpdateCustomer({ tags: updatedTags });
    };

    const handleDeleteTag = async (tagToDelete: string) => {
        if (!confirm(`Remove "${tagToDelete}" tag?`)) return;

        const currentTags = customer.tags || [];
        const updatedTags = currentTags.filter((t: string) => t !== tagToDelete);
        await onUpdateCustomer({ tags: updatedTags });
    };

    const handlePreviewFlyer = async (data: any) => {
        const pdf = await generateFlyerPDF(data);
        if (pdf) {
            const byteCharacters = atob(pdf.content);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
        }
    };

    const handlePreviewTracker = async (data: any) => {
        try {
            const res = await fetch('/api/documents/tracking-sheet', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            if (res.ok) {
                const blob = await res.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = "Freezer_Chef_Order_Tracking.xlsx";
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
            } else {
                alert("Failed to generate tracking sheet preview");
            }
        } catch (e) {
            console.error("Preview Error:", e);
            alert("Error generating preview");
        }
    };

    const statusColors = STATUS_COLORS[status] || STATUS_COLORS.LEAD;

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
            {/* Header Area with Status Pipeline */}
            <div className="bg-white dark:bg-slate-800 rounded-3xl p-8 border border-slate-200 dark:border-slate-700 shadow-sm">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
                    <div>
                        <div className="flex items-center gap-3 mb-2">
                            <h1 className="text-4xl font-black text-slate-900 dark:text-white tracking-tight">{customer.name}</h1>
                            {isArchived ? (
                                <span className="bg-slate-100 dark:bg-slate-700 text-slate-500 px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider">
                                    Archived
                                </span>
                            ) : (
                                <span className={`${statusColors.bg} ${statusColors.text} px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider border ${statusColors.border}`}>
                                    {STATUS_LABELS[status]}
                                </span>
                            )}
                            {customer.type === 'Fundraiser' || customer.type === 'Organization' ? (
                                <span className="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider">
                                    Fundraiser
                                </span>
                            ) : (
                                <span className="bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider">
                                    Individual
                                </span>
                            )}
                        </div>
                        <p className="text-slate-500 dark:text-slate-400 font-medium flex items-center gap-2">
                            {customer.contact_name}
                        </p>
                    </div>

                    <div className="flex gap-3">
                        <button
                            onClick={handleArchiveToggle}
                            className="bg-white dark:bg-slate-700 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 border border-slate-200 dark:border-slate-600 px-4 py-2 rounded-xl font-bold flex items-center gap-2 transition-colors"
                        >
                            {isArchived ? <RotateCcw size={18} /> : <Archive size={18} />}
                            {isArchived ? 'Reactivate' : 'Archive'}
                        </button>
                    </div>
                </div>

                {/* Visual Status Pipeline */}
                <div className="border-t border-slate-100 dark:border-slate-700/50 pt-6">
                    <StatusPipeline
                        currentStatus={status}
                        onStatusClick={handleManualStatusChange}
                        allowManualChange={true}
                    />
                </div>
            </div>

            {/* Catalog Selector Modal */}
            {showCatalogSelector && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
                    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl p-6 w-full max-w-md animate-in zoom-in duration-200">
                        <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">Select a Catalog</h3>
                        <p className="text-sm text-slate-500 mb-4">Choose which seasonal menu to send to the customer.</p>

                        <div className="space-y-3">
                            {catalogs.filter(c => c.is_active).map(cat => (
                                <button
                                    key={cat.id}
                                    onClick={() => selectCatalog(cat)}
                                    className="w-full text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-indigo-500 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all group"
                                >
                                    <div className="font-bold text-slate-900 dark:text-white group-hover:text-indigo-600">{cat.name}</div>
                                    <div className="text-xs text-slate-400 mt-1">{cat.bundles?.length || 0} Bundles included</div>
                                </button>
                            ))}
                        </div>

                        <button
                            onClick={() => setShowCatalogSelector(false)}
                            className="w-full mt-4 py-3 font-bold text-slate-500 hover:bg-slate-100 rounded-xl"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            <EmailComposeModal
                isOpen={isEmailModalOpen}
                onClose={() => setIsEmailModalOpen(false)}
                onSend={handleSendEmail}
                initialSubject={emailDraft.subject}
                initialHtml={emailDraft.html}
                recipientEmail={customer.email}
                initialAttachments={emailAttachments}
            />

            {/* Hidden Flyer for Generation */}
            <MarketingFlyer
                ref={flyerRef}
                customer={customer}
                fundraiserInfo={flyerData || customer.fundraiser_info}
                branding={branding}
            />

            {/* PIPELINE ACTIONS (Contextual) */}
            {(customer.type === 'Fundraiser' || customer.type === 'Organization') && (
                <div className="glass-panel p-8 rounded-3xl bg-white dark:bg-slate-800 dark:border-slate-700 shadow-sm">
                    <div className="flex justify-between items-center mb-6">
                        <div>
                            <h3 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-2">
                                Next Steps
                            </h3>
                            <p className="text-sm font-medium text-slate-500 mt-1">
                                Current Stage: <span className="text-indigo-600 dark:text-indigo-400 font-bold">{STATUS_LABELS[status]}</span>
                            </p>
                        </div>
                    </div>

                    <div className="space-y-6">

                        {/* LEAD STAGE: Intro Email */}
                        {status === 'LEAD' && (
                            <div className="bg-indigo-50 dark:bg-indigo-900/20 p-6 rounded-2xl border border-indigo-100 dark:border-indigo-800 flex items-center justify-between">
                                <div>
                                    <h4 className="font-bold text-indigo-900 dark:text-indigo-100 mb-1">Pass 'Go' to start Fundraising!</h4>
                                    <p className="text-sm text-indigo-600 dark:text-indigo-300">Send them the "Who We Are" intro email to gauge interest.</p>
                                </div>
                                <button
                                    onClick={() => openEmailComposer('intro')}
                                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-lg shadow-sm flex items-center gap-2"
                                >
                                    <Mail size={16} />
                                    Send Intro Email
                                </button>
                            </div>
                        )}

                        {/* SEND_INFO STAGE: Send Options & Bundle Selection */}
                        {status === 'SEND_INFO' && (
                            <div className="space-y-4">
                                <div className="bg-blue-50 dark:bg-blue-900/20 p-6 rounded-2xl border border-blue-100 dark:border-blue-800 flex items-center justify-between">
                                    <div>
                                        <h4 className="font-bold text-blue-900 dark:text-blue-100 mb-1">Step 2: Send Info Packet</h4>
                                        <p className="text-sm text-blue-600 dark:text-blue-300">Send the flyer options and ask them to pick 2 bundles.</p>
                                    </div>
                                    <button
                                        onClick={() => openEmailComposer('info')}
                                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg shadow-sm flex items-center gap-2"
                                    >
                                        <Mail size={16} />
                                        Send Info Packet
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* FLYERS STAGE: Setup Flyer / Marketing */}
                        {status === 'FLYERS' && (
                            <div className="space-y-6">
                                <div className="bg-emerald-50 dark:bg-emerald-900/20 p-6 rounded-2xl border border-emerald-100 dark:border-emerald-800 flex items-center justify-between">
                                    <div>
                                        <h4 className="font-bold text-emerald-900 dark:text-emerald-100 mb-1">Step 3: Marketing Packet</h4>
                                        <p className="text-sm text-emerald-600 dark:text-emerald-300">Once details are saved below, send the official flyer and order forms.</p>
                                    </div>
                                    <button
                                        onClick={async () => {
                                            if (!customer.fundraiser_info) {
                                                alert("Please save the fundraiser details below first.");
                                                return;
                                            }
                                            // 1. Generate PDF Flyer
                                            const pdf = await generateFlyerPDF(customer.fundraiser_info);

                                            // 2. Generate Tracking Sheet (Excel)
                                            let trackingSheet = null;
                                            try {
                                                const res = await fetch('/api/documents/tracking-sheet', {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify(customer.fundraiser_info)
                                                });
                                                if (res.ok) {
                                                    const blob = await res.blob();
                                                    const buffer = await blob.arrayBuffer();
                                                    // Convert ArrayBuffer to Base64
                                                    const base64 = Buffer.from(buffer).toString('base64');
                                                    trackingSheet = {
                                                        filename: 'Freezer_Chef_Order_Tracking.xlsx',
                                                        content: base64,
                                                        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                                                    };
                                                } else {
                                                    console.error("Failed to generate tracking sheet");
                                                }
                                            } catch (e) {
                                                console.error("Error fetching tracking sheet", e);
                                            }

                                            // 3. Attach Both
                                            const atts = [];
                                            if (pdf) atts.push(pdf);
                                            if (trackingSheet) atts.push(trackingSheet);

                                            openEmailComposer('marketing', atts);
                                        }}
                                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg shadow-sm flex items-center gap-2"
                                        disabled={isGeneratingFlyer}
                                    >
                                        {isGeneratingFlyer ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
                                        Send Marketing Packet
                                    </button>
                                </div>

                                <FundraiserSetup
                                    customer={customer}
                                    onSave={async (data) => {
                                        await onUpdateCustomer({ fundraiser_info: data });
                                        // Generate Flyer
                                        const pdf = await generateFlyerPDF(data);
                                        const atts = pdf ? [pdf] : [];

                                        // Auto-open Marketing Email
                                        const firstName = customer.contact_name ? customer.contact_name.split(' ')[0] : '';
                                        const template = generateMarketingTemplate(firstName, data, activeCampaign);
                                        setActiveEmailContext('marketing');
                                        setEmailDraft({ subject: template.subject, html: template.html });
                                        setEmailAttachments(atts);
                                        setIsEmailModalOpen(true);
                                    }}
                                    onPreview={handlePreviewFlyer}
                                    onPreviewTracker={handlePreviewTracker}
                                />
                            </div>
                        )}

                        {/* ACTIVE STAGE: Show Info Summary */}
                        {['ACTIVE', 'PRODUCTION', 'DELIVERY', 'COMPLETE'].includes(status) && (
                            <div className="bg-slate-50 dark:bg-slate-900/30 p-6 rounded-2xl border border-slate-100 dark:border-slate-800">
                                <h4 className="font-bold text-slate-900 dark:text-white mb-4">Fundraiser Details</h4>
                                <FundraiserSetup
                                    customer={customer}
                                    onSave={async (data) => await onUpdateCustomer({ fundraiser_info: data })}
                                    onPreview={handlePreviewFlyer}
                                    onPreviewTracker={handlePreviewTracker}
                                />
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* RETAIL ACTIONS: Promotions & Loyalty */}
            {customer.type === 'Individual' && (
                <div className="glass-panel p-8 rounded-3xl bg-white dark:bg-slate-800 dark:border-slate-700 shadow-sm">
                    <div className="flex justify-between items-center mb-6">
                        <div>
                            <h3 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-2">
                                <Sparkles className="text-indigo-500" size={20} /> Retail Toolkit
                            </h3>
                            <p className="text-sm font-medium text-slate-500 mt-1">
                                Personalized promotions and seasonal re-engagement.
                            </p>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        <div className="bg-emerald-50 dark:bg-emerald-900/20 p-6 rounded-2xl border border-emerald-100 dark:border-emerald-800 flex items-center justify-between group hover:border-emerald-300 transition-all">
                            <div>
                                <h4 className="font-bold text-emerald-900 dark:text-emerald-100 mb-1 flex items-center gap-2">
                                    <Mail size={16} /> Seasonal Menu
                                </h4>
                                <p className="text-[10px] text-emerald-600 dark:text-emerald-300 font-bold uppercase tracking-widest">Email Campaign</p>
                            </div>
                            <button
                                onClick={() => openEmailComposer('seasonal')}
                                className="p-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl shadow-sm transition-transform group-hover:scale-110"
                            >
                                <Mail size={18} />
                            </button>
                        </div>

                        <div className="bg-indigo-50 dark:bg-indigo-900/20 p-6 rounded-2xl border border-indigo-100 dark:border-indigo-800 flex items-center justify-between group hover:border-indigo-300 transition-all">
                            <div>
                                <h4 className="font-bold text-indigo-900 dark:text-indigo-100 mb-1 flex items-center gap-2">
                                    <Tag size={16} /> "We Miss You"
                                </h4>
                                <p className="text-[10px] text-indigo-600 dark:text-indigo-300 font-bold uppercase tracking-widest">Discount Promo</p>
                            </div>
                            <button
                                onClick={() => openEmailComposer('promotion')}
                                className="p-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-sm transition-transform group-hover:scale-110"
                            >
                                <Tag size={18} />
                            </button>
                        </div>

                        <div className="bg-slate-50 dark:bg-slate-900/20 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 border-dashed flex flex-col items-center justify-center gap-3 group hover:border-indigo-300 hover:bg-indigo-50/30 transition-all cursor-pointer">
                            <div className="w-12 h-12 rounded-full bg-white dark:bg-slate-800 flex items-center justify-center text-slate-400 group-hover:text-indigo-600 transition-colors shadow-sm">
                                <Plus size={24} />
                            </div>
                            <div className="text-center">
                                <h4 className="font-bold text-slate-900 dark:text-slate-100 text-sm">New Campaign</h4>
                                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Email or SMS</p>
                            </div>
                        </div>
                    </div>

                    {/* Dietary & Habits (Prominent) */}
                    <div className="bg-indigo-50/50 dark:bg-indigo-900/10 p-8 rounded-2xl border border-indigo-100 dark:border-indigo-900/30">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="font-black text-indigo-900 dark:text-indigo-100 flex items-center gap-2 text-lg">
                                <UtensilsCrossed size={18} /> Dietary Preferences & Habits
                            </h3>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="flex flex-wrap gap-2">
                                {(customer.tags || []).map((tag: string) => (
                                    <div key={tag} className="group/tag relative px-4 py-2 bg-white dark:bg-slate-800 border-2 border-indigo-100 dark:border-indigo-900 rounded-xl text-xs font-black text-indigo-600 shadow-sm flex items-center gap-2">
                                        {tag}
                                        <button
                                            onClick={() => handleDeleteTag(tag)}
                                            className="opacity-0 group-hover/tag:opacity-100 text-slate-400 hover:text-red-500 transition-all p-0.5"
                                        >
                                            <Plus size={14} className="rotate-45" />
                                        </button>
                                    </div>
                                ))}
                                <button
                                    onClick={handleAddTag}
                                    className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-black hover:bg-indigo-700 transition-all flex items-center gap-2"
                                >
                                    <Plus size={14} /> Add Tag
                                </button>
                            </div>
                            <div className="bg-white/50 dark:bg-slate-800/50 p-4 rounded-2xl border border-indigo-50 dark:border-indigo-900/30">
                                <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-1 leading-none">Top Bundle Habit</p>
                                <p className="text-sm font-bold text-slate-700 dark:text-slate-300">
                                    {topBundleHabit ? `${topBundleHabit.name} (${topBundleHabit.count}x Items)` : 'No orders yet'}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Left Column: Stats & Info */}
                <div className="space-y-6">
                    {/* Quick Stats */}
                    <div className="glass-panel p-6 rounded-3xl bg-white dark:bg-slate-800 dark:border-slate-700 shadow-sm transition-all border border-slate-200">
                        <div className="flex flex-col gap-4">
                            <div className="p-5 bg-slate-50 dark:bg-slate-900/50 rounded-2xl border border-slate-100 dark:border-slate-700">
                                <p className="text-xs text-slate-400 font-bold uppercase mb-2 tracking-wider">Total Orders</p>
                                <div className="flex items-center gap-3 text-3xl font-black text-slate-900 dark:text-white">
                                    <ShoppingBag size={24} className="text-indigo-500" />
                                    <span>{customer.orders?.length || 0}</span>
                                </div>
                            </div>
                            <div className="p-5 bg-slate-50 dark:bg-slate-900/50 rounded-2xl border border-slate-100 dark:border-slate-700">
                                <p className="text-xs text-slate-400 font-bold uppercase mb-2 tracking-wider">Weekly Order Total</p>
                                <div className="flex items-center gap-3 text-3xl font-black text-slate-900 dark:text-white">
                                    <DollarSign size={24} className="text-emerald-500" />
                                    <span>{weeklyOrderTotal}</span>
                                </div>
                            </div>

                            <div className="p-5 bg-indigo-50 dark:bg-indigo-900/20 rounded-2xl border border-indigo-100 dark:border-indigo-800">
                                <p className="text-xs text-indigo-400 dark:text-indigo-400 font-bold uppercase mb-2 tracking-wider">Orders In Progress</p>
                                <div className="flex items-center gap-3 text-3xl font-black text-slate-900 dark:text-white">
                                    <Clock size={24} className="text-indigo-500" />
                                    <span>{inProgressStats.count}</span>
                                    <span className="text-sm font-bold text-slate-500 dark:text-slate-400 ml-auto">{inProgressStats.amount}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Contact Profile */}
                <div
                    onClick={onEditProfile}
                    className="glass-panel p-6 rounded-3xl space-y-5 bg-white dark:bg-slate-800 dark:border-slate-700 cursor-pointer shadow-sm hover:border-indigo-300 transition-all group relative border border-slate-200"
                >
                    <div className="flex items-center justify-between border-b dark:border-slate-700 pb-3">
                        <h3 className="font-black text-slate-900 dark:text-white uppercase tracking-tight">Contact Profile</h3>
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                            <Plus size={16} className="text-indigo-500" />
                        </div>
                    </div>

                    <div className="space-y-4">
                        {customer.contact_name && (
                            <div className="flex items-center gap-4 text-slate-600 dark:text-slate-400">
                                <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0"><User size={20} /></div>
                                <div>
                                    <p className="text-[10px] font-bold uppercase text-slate-400 dark:text-slate-500 tracking-wider mb-0.5">Primary Contact</p>
                                    <span className="text-sm font-bold text-slate-900 dark:text-white">{customer.contact_name}</span>
                                </div>
                            </div>
                        )}

                        {customer.email && (
                            <div className="flex items-center gap-4 text-slate-600 dark:text-slate-400">
                                <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0"><Mail size={20} /></div>
                                <div>
                                    <p className="text-[10px] font-bold uppercase text-slate-400 dark:text-slate-500 tracking-wider mb-0.5">Email</p>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); openEmailComposer('custom'); }}
                                        className="text-sm font-bold text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 transition-colors"
                                    >
                                        {customer.email}
                                    </button>
                                </div>
                            </div>
                        )}

                        {customer.phone && (
                            <div className="flex items-center gap-4 text-slate-600 dark:text-slate-400">
                                <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0"><Phone size={20} /></div>
                                <div>
                                    <p className="text-[10px] font-bold uppercase text-slate-400 dark:text-slate-500 tracking-wider mb-0.5">Phone</p>
                                    <span className="text-sm font-bold text-slate-900 dark:text-white">{customer.phone}</span>
                                </div>
                            </div>
                        )}

                        {customer.delivery_address && (
                            <div className="flex items-center gap-4 text-slate-600 dark:text-slate-400">
                                <div className="w-10 h-10 rounded-xl bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 flex items-center justify-center shrink-0"><MapPin size={20} /></div>
                                <div>
                                    <p className="text-[10px] font-bold uppercase text-slate-400 dark:text-slate-500 tracking-wider mb-0.5">Delivery Address</p>
                                    <span className="text-sm font-medium leading-relaxed text-slate-900 dark:text-slate-100">{customer.delivery_address}</span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Kitchen Notes */}
                <div className="relative overflow-hidden bg-yellow-50/80 dark:bg-yellow-900/10 backdrop-blur-xl p-6 rounded-3xl border border-yellow-200/50 dark:border-yellow-900/30 shadow-soft">
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-yellow-300 to-orange-300 dark:from-yellow-700 dark:to-orange-700"></div>
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="font-black text-yellow-900 dark:text-yellow-100 flex items-center gap-2 text-lg">
                            <StickyNote size={20} className="fill-yellow-400 text-yellow-600 dark:text-yellow-500" /> Customer Notes
                        </h3>
                    </div>
                    <textarea
                        value={notes}
                        onChange={e => setNotes(e.target.value)}
                        className="w-full h-40 bg-yellow-100/30 dark:bg-yellow-900/20 border border-yellow-200/50 dark:border-yellow-700/30 rounded-2xl p-4 text-sm text-yellow-900 dark:text-yellow-50 focus:outline-none focus:bg-white/50 dark:focus:bg-yellow-900/40 focus:ring-2 focus:ring-yellow-400/50 transition-all font-medium leading-relaxed"
                        placeholder="Add preferences, allergies, or delivery notes here..."
                    />
                </div>
            </div>
        </div>
    );
}
