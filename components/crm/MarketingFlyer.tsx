import React, { forwardRef } from 'react';

interface BrandingSettings {
    business_name?: string;
    logo_url?: string | null;
    primary_color?: string;
    secondary_color?: string;
    accent_color?: string;
}

interface MarketingFlyerProps {
    customer: any;
    fundraiserInfo: any;
    branding?: BrandingSettings;
}

// Fixed dimensions for Letter/A4 PDF generation
// 8.5in x 11in at 96dpi is approx 816px x 1056px
// We'll use a standard width container that scales well
const MarketingFlyer = forwardRef<HTMLDivElement, MarketingFlyerProps>(({ customer, fundraiserInfo, branding }, ref) => {

    const {
        deadline,
        delivery_date,
        // Default to provided if available, otherwise blank for now
        deadline_time = '4:00 PM',
        delivery_time = 'TBD',
        pickup_location,
        checks_payable_to,
        flyer_details,
        bundle1_recipes,
        bundle2_recipes,
        bundle1_name,
        bundle2_name,
        bundle1_price = "126.50",
        bundle2_price = "60.60"
    } = fundraiserInfo || {};

    const orgName = customer.name || 'Your Organization';

    // Brand Colors - Use tenant branding or defaults
    const businessName = branding?.business_name || 'Freezer Chef';
    const logoUrl = branding?.logo_url || '/freezer-chef-logo.png';
    const primary = branding?.primary_color || '#10b981'; // Emerald 500
    const secondary = branding?.secondary_color || '#6366f1'; // Indigo 500
    const accent = branding?.accent_color || '#f59e0b'; // Amber 500
    const textDark = '#0f172a'; // Slate 900
    const textLight = '#64748b'; // Slate 500

    // Format dates safely
    const formatDate = (d: string) => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' }) : 'TBD';

    return (
        <div ref={ref} style={{
            position: 'absolute',
            top: '-9999px',
            left: '-9999px',
            display: 'flex',
            flexDirection: 'column',
            gap: '20px'
        }}>
            {/* Inject Google Fonts */}
            <style dangerouslySetInnerHTML={{
                __html: `
                @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=Montserrat:wght@700;800;900&display=swap');
                * { -webkit-font-smoothing: antialiased; }
            ` }} />

            {/* PAGE 1: MARKETING & BUNDLES */}
            <div id="flyer-page-1" style={{
                width: '816px',
                height: '1056px',
                padding: '30px 60px',
                backgroundColor: 'white',
                color: textDark,
                fontFamily: '"Outfit", sans-serif',
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                overflow: 'hidden'
            }}>
                {/* Header Table Layout */}
                <div style={{ display: 'table', width: '100%', marginBottom: '15px', marginTop: '0' }}>
                    <div style={{ display: 'table-row' }}>
                        <div style={{ display: 'table-cell', width: '90px', verticalAlign: 'middle' }}>
                            <img src={logoUrl} alt="Logo" style={{ width: '80px' }} />
                        </div>
                        <div style={{ display: 'table-cell', verticalAlign: 'middle', paddingLeft: '15px' }}>
                            <h1 style={{ fontFamily: '"Montserrat", sans-serif', color: primary, fontSize: '26px', fontWeight: '900', margin: '0 0 2px 0', letterSpacing: '-1px', textTransform: 'uppercase', lineHeight: '1' }}>
                                Raising Funds. Feeding Families.
                            </h1>
                            <h2 style={{ fontSize: '16px', fontWeight: '500', margin: '0', color: textLight }}>
                                Support <strong style={{ color: textDark, textDecoration: 'underline', textDecorationColor: primary, textDecorationThickness: '2px', textUnderlineOffset: '5px' }}>{orgName}</strong> with Delicious Meals!
                            </h2>
                        </div>
                    </div>
                </div>
                <div style={{ width: '100%', height: '4px', background: primary, marginBottom: '15px', borderRadius: '2px' }}></div>

                {/* Intro Text */}
                <div style={{ marginBottom: '15px', fontSize: '15px', lineHeight: '1.4', color: '#1e293b', textAlign: 'left', width: '100%' }}>
                    <p style={{ marginBottom: '6px' }}>
                        We're partnering with <strong style={{ color: secondary, fontWeight: '700' }}>{businessName}</strong> to bring you delicious, homemade-style meals that bring comfort to your table while supporting our cause!
                    </p>
                    <p>
                        By purchasing a meal bundle, you aren't just solving the "What's for dinner?" dilemma—you are directly supporting <strong>{orgName}</strong>. We earn <strong style={{ color: primary, fontSize: '18px', fontWeight: '800' }}>20%</strong> of every sale to help us thrive!
                    </p>
                </div>

                {/* Why You'll Love It */}
                <div style={{ marginBottom: '20px', width: '100%', textAlign: 'left', background: '#f1f5f9', padding: '15px 20px', borderRadius: '16px' }}>
                    <h3 style={{ fontFamily: '"Montserrat", sans-serif', color: secondary, fontSize: '15px', marginBottom: '10px', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '1px', textAlign: 'center' }}>Why You'll Love It</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 25px', fontSize: '14px' }}>
                        {[
                            { label: 'Healthy & Fresh', detail: 'Locally prepared fresh ingredients.' },
                            { label: 'Affordable', detail: 'Better value than eating out.' },
                            { label: 'Comfort & Convenience', detail: 'Oven & Slow-cooker ready.' },
                            { label: 'Support Local', detail: 'Help our specific community goals.' }
                        ].map((item, idx) => (
                            <div key={idx} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                <span style={{ color: primary, fontSize: '18px', fontWeight: 'bold', lineHeight: '1' }}>✓</span>
                                <div><strong style={{ fontWeight: '700', color: textDark }}>{item.label}:</strong> {item.detail}</div>
                            </div>
                        ))}
                    </div>
                </div>

                <h2 style={{ fontFamily: '"Montserrat", sans-serif', textAlign: 'center', color: textDark, fontSize: '20px', fontWeight: '900', marginBottom: '15px' }}>
                    It's as Easy as <span style={{ color: secondary }}>1</span>..<span style={{ color: primary }}>2</span>..<span style={{ color: accent }}>3</span>..!!
                </h2>

                {/* Step 1: Serving Size / Pricing */}
                <div style={{ width: '100%', marginBottom: '20px' }}>
                    <h3 style={{ fontSize: '14px', color: secondary, marginBottom: '10px', fontWeight: '800', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '1px' }}>1. Choose Your Serving Size...</h3>
                    <div style={{ display: 'flex', gap: '20px', alignItems: 'stretch' }}>
                        <div style={{ flex: 1, background: 'white', padding: '12px', borderRadius: '20px', textAlign: 'center', border: `3px solid ${secondary}`, display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '100px', boxSizing: 'border-box', justifyContent: 'center' }}>
                            <h4 style={{ fontSize: '16px', color: textDark, margin: '0 0 2px 0', fontWeight: '900', textTransform: 'uppercase', fontFamily: '"Montserrat", sans-serif' }}>Family Size Bundle</h4>
                            <div style={{ fontSize: '12px', color: textLight, marginBottom: '8px', fontWeight: '600' }}>Serves 5-6 People</div>
                            <div style={{ fontSize: '38px', fontWeight: '900', color: secondary, marginBottom: '8px', letterSpacing: '-1.2px', lineHeight: '1' }}>${bundle1_price}</div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', color: '#cbd5e1', fontWeight: '900', fontSize: '13px' }}>OR</div>
                        <div style={{ flex: 1, background: 'white', padding: '12px', borderRadius: '20px', textAlign: 'center', border: `3px solid ${secondary}`, display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '100px', boxSizing: 'border-box', justifyContent: 'center' }}>
                            <h4 style={{ fontSize: '16px', color: textDark, margin: '0 0 2px 0', fontWeight: '900', textTransform: 'uppercase', fontFamily: '"Montserrat", sans-serif' }}>Serves 2 Bundle</h4>
                            <div style={{ fontSize: '12px', color: textLight, marginBottom: '8px', fontWeight: '600' }}>Serves 2 People</div>
                            <div style={{ fontSize: '38px', fontWeight: '900', color: secondary, marginBottom: '8px', letterSpacing: '-1.2px', lineHeight: '1' }}>${bundle2_price}</div>
                        </div>
                    </div>
                </div>

                {/* Step 2: Choose Bundles */}
                <div style={{ width: '100%' }}>
                    <h3 style={{ fontSize: '14px', color: primary, marginBottom: '10px', fontWeight: '800', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '1px' }}>2. Choose Your Bundle(s)...</h3>
                    <div style={{ display: 'flex', background: 'white', borderRadius: '20px', border: '2px solid #e2e8f0', overflow: 'hidden' }}>
                        <div style={{ flex: 1, padding: '12px 20px' }}>
                            <h4 style={{ fontSize: '14px', borderBottom: `2.5px solid ${primary}`, paddingBottom: '4px', marginBottom: '8px', color: primary, fontWeight: '900', textTransform: 'uppercase' }}>
                                {bundle1_name ? `Bundle 1: ${bundle1_name}` : 'Bundle 1 Meals'}
                            </h4>
                            <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '13px', lineHeight: '1.3', color: '#1e293b' }}>
                                {(bundle1_recipes || 'No meals selected').split('\n').filter(Boolean).map((r: string, i: number) => (
                                    <li key={i} style={{ marginBottom: '3px', display: 'flex', gap: '8px', alignItems: 'flex-start' }}><span style={{ color: primary, fontSize: '14px', lineHeight: '1' }}>•</span> <span>{r}</span></li>
                                ))}
                            </ul>
                        </div>
                        <div style={{ width: '2px', background: '#e2e8f0' }}></div>
                        <div style={{ flex: 1, padding: '12px 20px' }}>
                            <h4 style={{ fontSize: '14px', borderBottom: `2.5px solid ${primary}`, paddingBottom: '4px', marginBottom: '8px', color: primary, fontWeight: '900', textTransform: 'uppercase' }}>
                                {bundle2_name ? `Bundle 2: ${bundle2_name}` : 'Bundle 2 Meals'}
                            </h4>
                            <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '13px', lineHeight: '1.3', color: '#1e293b' }}>
                                {(bundle2_recipes || 'No meals selected').split('\n').filter(Boolean).map((r: string, i: number) => (
                                    <li key={i} style={{ marginBottom: '3px', display: 'flex', gap: '8px', alignItems: 'flex-start' }}><span style={{ color: primary, fontSize: '14px', lineHeight: '1' }}>•</span> <span>{r}</span></li>
                                ))}
                            </ul>
                        </div>
                    </div>
                </div>
            </div>

            {/* PAGE 2: LOGISTICS & ORDER FORM */}
            <div id="flyer-page-2" style={{
                width: '816px',
                height: '1056px',
                padding: '40px 80px',
                backgroundColor: 'white',
                color: textDark,
                fontFamily: '"Outfit", sans-serif',
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                overflow: 'hidden'
            }}>
                <div style={{ textAlign: 'center', marginBottom: '20px', width: '100%' }}>
                    <h2 style={{ fontFamily: '"Montserrat", sans-serif', color: accent, fontSize: '20px', fontWeight: '900', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '1px' }}>
                        3. PAY AND PICK-UP ON DELIVERY DAY!
                    </h2>
                    <div style={{ width: '100%', height: '3px', background: primary, borderRadius: '3px' }}></div>
                </div>

                {/* Logistics Box */}
                <div style={{ width: '100%', background: '#fffbeb', padding: '20px', borderRadius: '24px', border: `2.5px solid ${accent}`, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '10px', marginBottom: '30px', paddingLeft: '180px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '16px', color: '#1e293b' }}>
                        <span style={{ fontSize: '20px' }}>🗓️</span> <strong style={{ width: '140px' }}>Order Deadline:</strong> <span style={{ fontWeight: '800', color: '#b45309' }}>{formatDate(deadline)}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '16px', color: '#1e293b' }}>
                        <span style={{ fontSize: '20px' }}>🚛</span> <strong style={{ width: '140px' }}>Delivery Date:</strong> <span style={{ fontWeight: '800', color: '#b45309' }}>{formatDate(delivery_date)}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '16px', color: '#1e293b' }}>
                        <span style={{ fontSize: '20px' }}>📍</span> <strong style={{ width: '140px' }}>Pickup Location:</strong> <span style={{ fontWeight: '800', color: '#b45309' }}>{pickup_location || 'TBD'}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '16px', color: '#1e293b' }}>
                        <span style={{ fontSize: '20px' }}>⏰</span> <strong style={{ width: '140px' }}>Pickup Time:</strong> <span style={{ fontWeight: '800', color: '#b45309' }}>{delivery_time || 'TBD'}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '16px', color: '#1e293b' }}>
                        <span style={{ fontSize: '20px' }}>💳</span> <strong style={{ width: '140px' }}>Checks Payable To:</strong> <span style={{ fontWeight: '800', color: '#b45309' }}>{checks_payable_to || orgName}</span>
                    </div>
                </div>

                {/* Cut Line */}
                <div style={{ width: '100%', borderTop: '2.5px dashed #cbd5e1', paddingTop: '25px', marginBottom: '25px', textAlign: 'center', position: 'relative' }}>
                    <span style={{ background: 'white', padding: '0 25px', position: 'relative', top: '-38px', fontSize: '12px', color: '#94a3b8', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '4px' }}>
                        ✂️ CUT & RETURN WITH PAYMENT ✂️
                    </span>
                </div>

                {/* Full Order Form (Scaled Down) */}
                <div style={{ width: '100%', padding: '30px', borderRadius: '24px', background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                    <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                        <p style={{ margin: 0, color: '#dc2626', fontWeight: '800', fontSize: '14px' }}>
                            ORDERS DUE BY: <span style={{ textDecoration: 'underline' }}>{formatDate(deadline) !== 'TBD' ? formatDate(deadline) : '(FIELD)'}</span> @ {deadline_time}
                        </p>
                    </div>

                    <div style={{ marginBottom: '20px' }}>
                        <div style={{ borderBottom: '1.5px solid #cbd5e1', height: '35px', display: 'flex', alignItems: 'end' }}>
                            <span style={{ fontWeight: '800', marginRight: '12px', color: textDark, fontSize: '12px', textTransform: 'uppercase' }}>NAME:</span>
                            <span style={{ flex: 1 }}></span>
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: '25px', marginBottom: '30px' }}>
                        <div style={{ flex: 1, borderBottom: '1.5px solid #cbd5e1', height: '35px', display: 'flex', alignItems: 'end' }}>
                            <span style={{ fontWeight: '800', marginRight: '12px', color: textDark, fontSize: '12px', textTransform: 'uppercase' }}>PHONE:</span>
                        </div>
                        <div style={{ flex: 1.5, borderBottom: '1.5px solid #cbd5e1', height: '35px', display: 'flex', alignItems: 'end' }}>
                            <span style={{ fontWeight: '800', marginRight: '12px', color: textDark, fontSize: '12px', textTransform: 'uppercase' }}>EMAIL:</span>
                        </div>
                    </div>

                    <div style={{ display: 'flex', gap: '20px', marginBottom: '5px' }}>
                        <div style={{ flex: 1, background: 'white', padding: '15px', borderRadius: '16px', border: `2px solid ${secondary}` }}>
                            <strong style={{ display: 'block', marginBottom: '10px', borderBottom: '2px solid #f8fafc', paddingBottom: '6px', color: secondary, fontSize: '13px', fontWeight: '900', textTransform: 'uppercase' }}>Family Bundle (${bundle1_price})</strong>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', fontWeight: '800' }}>
                                <span>Qty: ________</span>
                                <span>Total $: ________</span>
                            </div>
                        </div>
                        <div style={{ flex: 1, background: 'white', padding: '15px', borderRadius: '16px', border: `2px solid ${secondary}` }}>
                            <strong style={{ display: 'block', marginBottom: '10px', borderBottom: '2px solid #f8fafc', paddingBottom: '8px', color: secondary, fontSize: '13px', fontWeight: '900', textTransform: 'uppercase' }}>Serves 2 Bundle (${bundle2_price})</strong>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', fontWeight: '800' }}>
                                <span>Qty: ________</span>
                                <span>Total $: ________</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div style={{ marginTop: 'auto', textAlign: 'center', opacity: 0.5, paddingBottom: '10px' }}>
                    <p style={{ margin: 0, fontSize: '10px' }}>Generated by Freezer Chef Fundraising System</p>
                </div>
            </div>
        </div>
    );
});

MarketingFlyer.displayName = 'MarketingFlyer';
export default MarketingFlyer;
