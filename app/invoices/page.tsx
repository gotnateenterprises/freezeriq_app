"use client";

import { useState, useEffect, Suspense } from 'react';
import {
    Plus,
    Search,
    Filter,
    FileText,
    CheckCircle2,
    Clock,
    AlertCircle,
    ChevronRight,
    MoreHorizontal,
    Download,
    Mail,
    Edit,
    Trash2,
    Tag,
    Info
} from 'lucide-react';
import { toast } from 'sonner';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import InvoiceComposeModal from '@/components/crm/InvoiceComposeModal';
import EmailComposeModal from '@/components/crm/EmailComposeModal';
import UpgradeRequired from '@/components/UpgradeRequired';

interface Invoice {
    id: string;
    customer_id: string;
    status: 'PENDING' | 'PAID' | 'OVERDUE' | 'CANCELED';
    total_amount: number;
    tax_amount: string | number;
    fundraiser_profit_percent: string | number | null;
    fundraiser_profit_amount: string | number | null;
    created_at: string;
    due_date: string | null;
    customer: {
        name: string;
        contact_email: string;
        delivery_address: string | null;
    };
    items: {
        description: string;
        quantity: number;
        unit_price: number;
        total: number;
    }[];
}

interface Branding {
    business_name: string;
    logo_url?: string;
    primary_color: string;
    user?: {
        email: string;
        phone: string | null;
        address: string | null;
    };
}

export default function InvoicesPage() {
    return (
        <Suspense fallback={<div className="p-8 text-center text-slate-400 font-bold">Loading Invoices...</div>}>
            <InvoicesContent />
        </Suspense>
    );
}

function InvoicesContent() {
    const { data: session, status } = useSession();
    const searchParams = useSearchParams();
    const router = useRouter();
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('ALL');
    const [searchQuery, setSearchQuery] = useState('');
    const [isComposeOpen, setIsComposeOpen] = useState(false);
    const [invoiceToEdit, setInvoiceToEdit] = useState<Invoice | null>(null);
    const [preselectedCustomerId, setPreselectedCustomerId] = useState<string | undefined>(undefined);
    const [branding, setBranding] = useState<Branding | null>(null);
    const [emailingId, setEmailingId] = useState<string | null>(null);
    const [isPreviewOpen, setIsPreviewOpen] = useState(false);
    const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
    const [previewContent, setPreviewContent] = useState({ subject: '', html: '', attachments: [] as any[] });
    const [prefilledItems, setPrefilledItems] = useState<any[] | undefined>(undefined);

    const userPlan = (session?.user as any)?.plan;
    const isSuperAdmin = (session?.user as any)?.isSuperAdmin;
    const hasAccess = userPlan === 'ENTERPRISE' || userPlan === 'ULTIMATE' || userPlan === 'FREE' || isSuperAdmin;

    useEffect(() => {
        fetchInvoices();
        fetchBranding();
    }, []);

    // Handle Deep Linking
    useEffect(() => {
        const action = searchParams.get('action');
        const custId = searchParams.get('customerId');
        const campaignName = searchParams.get('name');
        const salesAmount = searchParams.get('amount');

        if (action === 'new') {
            setInvoiceToEdit(null);
            if (custId) {
                setPreselectedCustomerId(custId);
            }
            if (campaignName && salesAmount) {
                setPrefilledItems([{
                    description: `Fundraiser Campaign: ${campaignName}`,
                    quantity: 1,
                    unit_price: Number(salesAmount),
                    total: Number(salesAmount)
                }]);
            } else {
                setPrefilledItems(undefined);
            }
            setIsComposeOpen(true);

            // Optionally clear the params so a refresh doesn't re-open it
            const newParams = new URLSearchParams(searchParams.toString());
            newParams.delete('action');
            newParams.delete('customerId');
            newParams.delete('name');
            newParams.delete('amount');
            const newUrl = newParams.toString() ? `/invoices?${newParams.toString()}` : '/invoices';
            router.replace(newUrl, { scroll: false });
        }
    }, [searchParams]);

    const fetchInvoices = async () => {
        try {
            const res = await fetch('/api/tenant/invoices');
            if (res.ok) {
                const data = await res.json();
                setInvoices(data);
            }
        } catch (error) {
            toast.error('Failed to load invoices');
        } finally {
            setLoading(false);
        }
    };

    const fetchBranding = async () => {
        try {
            const res = await fetch('/api/tenant/branding');
            if (res.ok) {
                const data = await res.json();
                setBranding(data);
            }
        } catch (e) {
            console.error('Failed to fetch branding');
        }
    };

    const generateInvoicePDF = async (invoice: Invoice) => {
        const jsPDF = (await import('jspdf')).default;
        const doc = new jsPDF('p', 'pt', 'letter');
        const primaryColor = branding?.primary_color || '#6366f1';

        // Header
        // Remove solid background and use a clean divider line instead
        doc.setDrawColor(200, 200, 200);
        doc.line(40, 120, 572, 120);

        if (branding?.logo_url) {
            try {
                const format = branding.logo_url.toLowerCase().endsWith('.png') ? 'PNG' : 'JPEG';
                doc.addImage(branding.logo_url, format, 40, 20, 80, 80, undefined, 'FAST');
            } catch (e) {
                console.error('Logo add error:', e);
            }
        } else {
            doc.setTextColor(50, 50, 50);
            doc.setFontSize(24);
            doc.setFont('helvetica', 'bold');
            doc.text(branding?.business_name || 'My Business', 40, 60);
        }

        doc.setTextColor(50, 50, 50);
        doc.setFontSize(32);
        doc.text('INVOICE', 572, 60, { align: 'right' });
        doc.setFontSize(10);
        doc.text('#' + invoice.id.slice(0, 8).toUpperCase(), 572, 80, { align: 'right' });

        // Billing Info
        doc.setTextColor(50, 50, 50);
        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.text('BILL TO:', 40, 160);
        doc.setFont('helvetica', 'normal');
        doc.text(invoice.customer.name, 40, 175);

        let billToY = 190;
        if (invoice.customer.delivery_address) {
            // Split address by newlines or commas to handle multi-line
            const addressLines = invoice.customer.delivery_address.split(/\n/).map(l => l.trim()).filter(Boolean);
            addressLines.forEach(line => {
                doc.text(line, 40, billToY);
                billToY += 15;
            });
        }
        doc.text(invoice.customer.contact_email, 40, billToY);

        doc.setFont('helvetica', 'bold');
        doc.text('INVOICE DATE:', 400, 160);
        doc.setFont('helvetica', 'normal');
        doc.text(new Date(invoice.created_at).toLocaleDateString(), 572, 160, { align: 'right' });

        doc.setFont('helvetica', 'bold');
        doc.text('DUE DATE:', 400, 175);
        doc.setFont('helvetica', 'normal');
        doc.text(invoice.due_date ? new Date(invoice.due_date).toLocaleDateString() : 'Upon Receipt', 572, 175, { align: 'right' });

        // Table Header
        let y = 240;
        doc.setFillColor(245, 245, 245);
        doc.rect(40, y, 532, 25, 'F');
        doc.setFont('helvetica', 'bold');
        doc.text('Description', 50, y + 16);
        doc.text('Qty', 350, y + 16, { align: 'center' });
        doc.text('Unit Price', 450, y + 16, { align: 'center' });
        doc.text('Total', 560, y + 16, { align: 'right' });

        // Table Content
        y += 40;
        invoice.items?.forEach((item, i) => {
            doc.setFont('helvetica', 'normal');
            doc.text(item.description, 50, y);
            doc.text(item.quantity.toString(), 350, y, { align: 'center' });
            doc.text('$' + Number(item.unit_price).toFixed(2), 450, y, { align: 'center' });
            doc.text('$' + Number(item.total).toFixed(2), 560, y, { align: 'right' });
            y += 20;

            doc.setDrawColor(240, 240, 240);
            doc.line(40, y - 5, 572, y - 5);
            y += 10;
        });

        // Totals
        y += 20;
        const itemsSubtotal = invoice.items?.reduce((acc, curr) => acc + Number(curr.total), 0) || 0;
        const profitAmount = Number(invoice.fundraiser_profit_amount) || 0;
        const profitPercent = Number(invoice.fundraiser_profit_percent) || 0;
        const taxAmountValue = Number(invoice.tax_amount) || 0;

        doc.setFont('helvetica', 'normal');
        doc.text('Subtotal:', 450, y);
        doc.text('$' + itemsSubtotal.toFixed(2), 560, y, { align: 'right' });

        if (profitAmount > 0) {
            y += 25;
            doc.setTextColor(22, 163, 74); // Green for profit deduction
            doc.text(`Fundraiser Profit (${profitPercent}%):`, 40, y);
            doc.text('-$' + profitAmount.toFixed(2), 560, y, { align: 'right' });
            doc.setTextColor(0, 0, 0); // Reset
        }

        y += 25;
        doc.text('Tax:', 40, y);
        doc.text('$' + taxAmountValue.toFixed(2), 560, y, { align: 'right' });

        y += 45;
        doc.setFontSize(14); // Lowered from 16
        doc.setFont('helvetica', 'bold');
        doc.setDrawColor(0, 0, 0); // Black for border if used
        doc.setTextColor(0, 0, 0); // Black for text
        const calculatedBalance = itemsSubtotal - profitAmount + taxAmountValue;
        const tenantName = branding?.business_name || 'Freezer Chef';
        const balanceLabel = profitAmount > 0 ? `Final Balance Due to ${tenantName}:` : 'Grand Total:';

        // Move towards center
        doc.text(balanceLabel, 80, y);
        doc.text('$' + calculatedBalance.toFixed(2), 560, y, { align: 'right' });

        if (profitAmount > 0) {
            y += 75;
            // Celebratory Success Section
            doc.setTextColor(22, 163, 74); // Success green
            doc.setFontSize(18); // Increased from 14
            doc.setFont('helvetica', 'bold');
            const celebText = "Congratulations! Your organization earned: ";
            doc.text(celebText, 50, y);

            const amountText = `$${profitAmount.toFixed(2)}`;
            const textWidth = doc.getTextWidth(celebText);
            const amountX = 50 + textWidth + 15;

            // "Hand-drawn" circle effect: Draw multiple jittered ellipses
            doc.setDrawColor(22, 163, 74);
            doc.setLineWidth(1);
            doc.text(amountText, amountX, y);

            const amountWidth = doc.getTextWidth(amountText);
            const circleX = amountX + (amountWidth / 2);
            const circleY = y - 5;
            const rx = (amountWidth / 2) + 20;
            const ry = 18;

            // Draw 3 skeletal ellipses with slight jitter
            doc.ellipse(circleX, circleY, rx, ry, 'S');
            doc.ellipse(circleX + 1, circleY - 1, rx + 1.5, ry + 1, 'S');
            doc.ellipse(circleX - 1.5, circleY + 0.5, rx - 0.5, ry + 1.5, 'S');

            doc.setTextColor(0, 0, 0); // Reset
            doc.setLineWidth(1);
        }

        // Footer
        doc.setFontSize(10);
        doc.setTextColor(50, 50, 50);

        // Acceptable Payments Section
        y = 660;
        doc.setFont('helvetica', 'bold');
        doc.text('ACCEPTABLE PAYMENT METHODS:', 306, y, { align: 'center' });

        y += 20;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(100, 100, 100);
        const paymentList = "ACH Transfer  |  Check  |  Venmo (@FreezerChef)  |  PayPal";
        doc.text(paymentList, 306, y, { align: 'center' });

        // Stylized Card Indicators
        y += 15;
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(150, 150, 150);
        doc.setFontSize(8);
        doc.text('VISA  |  MASTERCARD  |  AMEX  |  DISCOVER', 306, y, { align: 'center' });

        y += 25;
        doc.setFontSize(10);
        doc.setTextColor(50, 50, 50);
        doc.setFont('helvetica', 'bold');
        doc.text('Make Checks Payable to: ' + (branding?.business_name || 'Freezer Chef'), 306, y, { align: 'center' });

        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(100, 100, 100);

        let footerY = y + 20;
        if (branding?.user) {
            const contactLine = `Questions? Email: ${branding.user.email}${branding.user.phone ? ` | Phone: ${branding.user.phone}` : ''}`;
            doc.text(contactLine, 306, footerY, { align: 'center' });
            footerY += 15;
            if (branding.user.address) {
                doc.text(branding.user.address, 306, footerY, { align: 'center' });
            }
        }

        doc.setFontSize(9);
        doc.setTextColor(150, 150, 150);
        doc.setFont('helvetica', 'italic');
        doc.text('Thank you for your business!', 306, 750, { align: 'center' });
        doc.setFont('helvetica', 'normal');
        doc.text('Invoice generated on ' + new Date().toLocaleDateString(), 306, 765, { align: 'center' });

        return doc;
    };

    const handleDownloadPDF = async (invoice: Invoice) => {
        try {
            const doc = await generateInvoicePDF(invoice);
            doc.save(`Invoice-${invoice.id.slice(0, 8)}.pdf`);
            toast.success('PDF Generated');
        } catch (error) {
            console.error('PDF Error:', error);
            toast.error('Failed to generate PDF');
        }
    };

    const handleEmailInvoice = async (invoice: Invoice) => {
        if (!invoice?.customer?.contact_email) {
            console.error('Missing customer email for invoice:', invoice);
            return toast.error('Customer has no email address or registry data missing');
        }

        setEmailingId(invoice.id);
        try {
            const doc = await generateInvoicePDF(invoice);
            const pdfDataUri = doc.output('datauristring');
            const base64Content = pdfDataUri.split(',')[1];

            const subject = `Invoice from ${branding?.business_name || 'Your Meal Prep Business'} (#${invoice.id.slice(0, 8).toUpperCase()})`;
            const html = `
                <p>Hi ${invoice.customer.name},</p>
                <p>Please find your invoice attached for your recent order.</p>
                <p>Total Amount: <strong>$${Number(invoice.total_amount).toFixed(2)}</strong></p>
                <p>Thank you for your support!</p>
                <p>Warmly,<br>${branding?.business_name || 'Your Meal Prep Team'}</p>
            `;

            setPreviewContent({
                subject,
                html,
                attachments: [
                    {
                        filename: `Invoice-${invoice.id.slice(0, 8).toUpperCase()}.pdf`,
                        content: base64Content,
                        type: 'application/pdf'
                    }
                ]
            });
            setSelectedInvoice(invoice);
            setIsPreviewOpen(true);
        } catch (error) {
            console.error('Preview Error:', error);
            toast.error('Failed to prepare email preview');
        } finally {
            setEmailingId(null);
        }
    };

    const handleEditInvoice = (invoice: Invoice) => {
        setInvoiceToEdit(invoice);
        setIsComposeOpen(true);
    };

    const handleSendEmail = async (subject: string, html: string, attachments: any[]) => {
        if (!selectedInvoice) return;

        try {
            const res = await fetch('/api/email/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    to: selectedInvoice.customer.contact_email,
                    subject,
                    html,
                    attachments
                })
            });

            if (res.ok) {
                const result = await res.json();
                if (result.mocked) {
                    toast.info('Safety Mode: Email logged but not sent (EMAIL_LIVE is OFF)');
                } else {
                    toast.success('Invoice emailed successfully');
                }
            } else {
                const err = await res.json();
                toast.error(err.error || 'Failed to send email');
            }
        } catch (error) {
            toast.error('An error occurred while sending');
        }
    };

    const filteredInvoices = invoices.filter(inv => {
        const matchesFilter = filter === 'ALL' || inv.status === filter;
        const matchesSearch = inv.customer.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            inv.id.toLowerCase().includes(searchQuery.toLowerCase());
        return matchesFilter && matchesSearch;
    });

    if (status === 'loading') return <div className="p-8 text-center text-slate-400 font-bold animate-pulse">Checking Invoicing Access...</div>;

    if (!hasAccess) {
        return (
            <UpgradeRequired
                feature="Smart Invoicing"
                description="Generate professional PDF invoices, track bundle-based payments, and automate your wholesale billing."
            />
        );
    }

    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            {isComposeOpen && (
                <InvoiceComposeModal
                    isOpen={isComposeOpen}
                    onClose={() => {
                        setIsComposeOpen(false);
                        setInvoiceToEdit(null);
                        setPreselectedCustomerId(undefined);
                        setPrefilledItems(undefined);
                    }}
                    onSuccess={(savedInvoice) => {
                        fetchInvoices();
                        setInvoiceToEdit(null);
                        setPreselectedCustomerId(undefined);
                        setPrefilledItems(undefined);
                        // Small delay to ensure modals swap smoothly
                        setTimeout(() => {
                            handleEmailInvoice(savedInvoice);
                        }, 300);
                    }}
                    invoiceToEdit={invoiceToEdit}
                    preselectedCustomerId={preselectedCustomerId}
                    prefilledItems={prefilledItems}
                />
            )}

            <EmailComposeModal
                isOpen={isPreviewOpen}
                onClose={() => setIsPreviewOpen(false)}
                onSend={handleSendEmail}
                initialSubject={previewContent.subject}
                initialHtml={previewContent.html}
                recipientEmail={selectedInvoice?.customer.contact_email || ''}
                initialAttachments={previewContent.attachments}
            />

            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Invoices</h1>
                    <p className="text-slate-500 font-medium">Manage billing and loyalty points for your customers.</p>
                </div>
                <button
                    onClick={() => { setIsComposeOpen(true); setInvoiceToEdit(null); }}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-2xl font-black shadow-lg shadow-indigo-500/20 flex items-center gap-2 transition-all hover:scale-[1.02] active:scale-95"
                >
                    <Plus className="w-5 h-5" /> Create Invoice
                </button>
            </div>

            {/* Stats Overview */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                {[
                    { label: 'Total Outstanding', value: `$${invoices.filter(i => i.status === 'PENDING').reduce((acc, curr) => acc + Number(curr.total_amount), 0).toFixed(2)}`, icon: Clock, color: 'text-amber-600', bg: 'bg-amber-100/50' },
                    { label: 'Paid This Month', value: `$${invoices.filter(i => i.status === 'PAID').reduce((acc, curr) => acc + Number(curr.total_amount), 0).toFixed(2)}`, icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-100/50' },
                    { label: 'Overdue', value: `$${invoices.filter(i => i.status === 'OVERDUE').reduce((acc, curr) => acc + Number(curr.total_amount), 0).toFixed(2)}`, icon: AlertCircle, color: 'text-rose-600', bg: 'bg-rose-100/50' },
                    { label: 'Total Loyalty Issued', value: '1.2k pts', icon: Tag, color: 'text-indigo-600', bg: 'bg-indigo-100/50' },
                ].map((stat, i) => (
                    <div key={i} className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm">
                        <div className={`w-10 h-10 ${stat.bg} ${stat.color} rounded-xl flex items-center justify-center mb-4`}>
                            <stat.icon className="w-5 h-5" />
                        </div>
                        <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">{stat.label}</p>
                        <p className="text-2xl font-black">{stat.value}</p>
                    </div>
                ))}
            </div>

            {/* Filters & Search */}
            <div className="flex flex-col md:flex-row gap-4 items-center justify-between bg-white dark:bg-slate-800 p-4 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-700">
                <div className="flex bg-slate-100 dark:bg-slate-900 p-1 rounded-2xl w-full md:w-auto">
                    {['ALL', 'PENDING', 'PAID', 'OVERDUE'].map((f) => (
                        <button
                            key={f}
                            onClick={() => setFilter(f)}
                            className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${filter === f ? 'bg-white dark:bg-slate-800 text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                            {f}
                        </button>
                    ))}
                </div>
                <div className="relative w-full md:w-80">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                        type="text"
                        placeholder="Search by customer or ID..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-11 pr-4 py-3 rounded-2xl bg-slate-100 dark:bg-slate-900 border-none focus:ring-2 focus:ring-indigo-500/20 text-sm"
                    />
                </div>
            </div>

            {/* Invoice List */}
            <div className="bg-white dark:bg-slate-800 rounded-[32px] overflow-hidden shadow-sm border border-slate-100 dark:border-slate-700">
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-slate-50 dark:bg-slate-900/50">
                                <th className="px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-widest">Invoice</th>
                                <th className="px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-widest">Customer</th>
                                <th className="px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-widest">Amount</th>
                                <th className="px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-widest">Status</th>
                                <th className="px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-widest">Date</th>
                                <th className="px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-widest"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50 dark:divide-slate-700/50">
                            {loading ? (
                                [1, 2, 3].map(i => (
                                    <tr key={i} className="animate-pulse">
                                        <td colSpan={6} className="px-6 py-8"><div className="h-4 bg-slate-100 dark:bg-slate-700 rounded w-full"></div></td>
                                    </tr>
                                ))
                            ) : filteredInvoices.length > 0 ? filteredInvoices.map((inv) => (
                                <tr key={inv.id} className="group hover:bg-slate-50 dark:hover:bg-slate-900/40 transition-colors">
                                    <td className="px-6 py-5">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 flex items-center justify-center">
                                                <FileText className="w-5 h-5" />
                                            </div>
                                            <span className="font-bold text-sm">#{inv.id.slice(0, 8).toUpperCase()}</span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-5">
                                        <div>
                                            <Link
                                                href={`/fundraisers?search=${encodeURIComponent(inv.customer.name)}`}
                                                className="font-black text-sm hover:text-indigo-600 transition-colors"
                                            >
                                                {inv.customer.name}
                                            </Link>
                                            <p className="text-xs text-slate-400">{inv.customer.contact_email}</p>
                                        </div>
                                    </td>
                                    <td className="px-6 py-5">
                                        <span className="font-black text-sm">${Number(inv.total_amount).toFixed(2)}</span>
                                    </td>
                                    <td className="px-6 py-5">
                                        <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${inv.status === 'PAID' ? 'bg-emerald-100 text-emerald-600' :
                                            inv.status === 'PENDING' ? 'bg-amber-100 text-amber-600' :
                                                'bg-rose-100 text-rose-600'
                                            }`}>
                                            {inv.status}
                                        </span>
                                    </td>
                                    <td className="px-6 py-5 text-sm text-slate-500 font-medium">
                                        {new Date(inv.created_at).toLocaleDateString()}
                                    </td>
                                    <td className="px-6 py-5 text-right">
                                        <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <button
                                                onClick={() => handleDownloadPDF(inv)}
                                                className="p-2 hover:bg-white dark:hover:bg-slate-700 rounded-lg text-slate-400 hover:text-indigo-600 transition-all shadow-sm"
                                                title="Download PDF"
                                            >
                                                <Download className="w-4 h-4" />
                                            </button>
                                            <button
                                                onClick={() => handleEmailInvoice(inv)}
                                                disabled={emailingId === inv.id}
                                                className="p-2 hover:bg-white dark:hover:bg-slate-700 rounded-lg text-slate-400 hover:text-indigo-600 transition-all shadow-sm disabled:opacity-50"
                                                title="Email Invoice"
                                            >
                                                {emailingId === inv.id ? (
                                                    <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent animate-spin rounded-full" />
                                                ) : (
                                                    <Mail className="w-4 h-4" />
                                                )}
                                            </button>
                                            <button
                                                onClick={() => handleEditInvoice(inv)}
                                                className="p-2 hover:bg-white dark:hover:bg-slate-700 rounded-lg text-slate-400 hover:text-amber-600 transition-all shadow-sm"
                                                title="Edit Invoice"
                                            >
                                                <Edit className="w-4 h-4" />
                                            </button>
                                            <button className="p-2 hover:bg-rose-50 rounded-lg text-slate-400 hover:text-rose-600 transition-all shadow-sm">
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            )) : (
                                <tr>
                                    <td colSpan={6} className="px-6 py-20 text-center text-slate-400 italic">
                                        No invoices found matching your criteria.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Context Help */}
            <div className="flex items-center gap-4 bg-indigo-50 dark:bg-indigo-900/20 p-6 rounded-[2rem] border border-indigo-100 dark:border-indigo-800/30">
                <div className="p-3 bg-white dark:bg-slate-800 rounded-2xl text-indigo-600 shadow-sm">
                    <Info className="w-6 h-6" />
                </div>
                <div className="flex-1">
                    <p className="text-sm font-bold text-indigo-900 dark:text-indigo-100">About Loyalty Points</p>
                    <p className="text-xs text-indigo-700 dark:text-indigo-300 opacity-80 leading-relaxed">
                        Invoices marked as **PAID** automatically issue 1 point for every $1 spent. Customers can redeem 100 points for $5 in credit on their next order.
                    </p>
                </div>
                <button className="text-sm font-black text-indigo-600 uppercase tracking-widest hover:underline">
                    Loyalty Settings
                </button>
            </div>
        </div>
    );
}

