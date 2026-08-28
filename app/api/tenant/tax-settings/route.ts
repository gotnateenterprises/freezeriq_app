/**
 * FR-TAX-1 — the tenant's default food/grocery tax rate.
 *
 * SEPARATE from StorefrontConfig.tax_percent on purpose. That field is the
 * RETAIL sales tax charged to an individual shopper at storefront checkout
 * (app/api/checkout/session/route.ts). This one is the FOOD/GROCERY tax on the
 * fundraiser sale to an ORGANIZATION. Two different taxes on two different
 * transactions; collapsing them would make one of the two silently wrong.
 *
 * This rate is a DEFAULT for campaigns launched from now on. It is snapshotted
 * onto each campaign at launch, so changing it here never rewrites the rate an
 * already-launched fundraiser was told (see lib/fundraiserTax.ts).
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { parseTaxRatePercent } from '@/lib/fundraiserTax';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const business = await prisma.business.findUnique({
            where: { id: session.user.businessId },
            select: { default_food_tax_percent: true },
        });

        return NextResponse.json({
            defaultFoodTaxPercent: Number(business?.default_food_tax_percent ?? 0),
        });
    } catch (e: any) {
        console.error('[FR-TAX-1] tax settings read error:', e?.message || e);
        return NextResponse.json({ error: 'Failed to load tax settings' }, { status: 500 });
    }
}

export async function PUT(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json().catch(() => ({}));
        const parsed = parseTaxRatePercent(body?.defaultFoodTaxPercent);
        if (!parsed.ok) {
            return NextResponse.json({ error: parsed.error }, { status: 400 });
        }

        const updated = await prisma.business.update({
            where: { id: session.user.businessId },
            data: { default_food_tax_percent: parsed.percent },
            select: { default_food_tax_percent: true },
        });

        return NextResponse.json({
            success: true,
            defaultFoodTaxPercent: Number(updated.default_food_tax_percent),
        });
    } catch (e: any) {
        console.error('[FR-TAX-1] tax settings write error:', e?.message || e);
        return NextResponse.json({ error: 'Failed to save tax settings' }, { status: 500 });
    }
}
