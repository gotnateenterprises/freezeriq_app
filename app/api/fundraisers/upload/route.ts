
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

function splitCsvLine(line: string): string[] {
    const re = /,(?=(?:(?:[^"]*"){2})*[^"]*$)/;
    return line.split(re).map(v => {
        v = v.trim();
        if (v.startsWith('"') && v.endsWith('"')) {
            return v.slice(1, -1).replace(/""/g, '"');
        }
        return v;
    });
}

export async function POST(req: NextRequest) {
    try {
        const session = await auth();
        // Basic auth check
        if (!session?.user?.email) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // We assume User is admin or has rights
        const businessId = session.user.businessId; // Might be null for Super Admin, but we can proceed

        const formData = await req.formData();
        const file = formData.get('file') as File;

        if (!file) {
            return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
        }

        const text = await file.text();
        const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');

        if (lines.length === 0) {
            return NextResponse.json({ error: 'Empty file' }, { status: 400 });
        }

        const headers = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
        const dataLines = lines.slice(1);

        const logs: string[] = [];
        let createdOrgs = 0;
        let createdCampaigns = 0;
        let updatedOrgs = 0;

        // Map column indices - Flexible matching
        const findIdx = (keywords: string[]) => headers.findIndex(h => keywords.some(k => h.includes(k)));

        const idx = {
            orgName: findIdx(['organization', 'org name', 'customer name', 'company']),
            campaignName: findIdx(['campaign', 'fundraiser name']),
            contactName: findIdx(['contact']),
            email: findIdx(['email']),
            phone: findIdx(['phone']),
            goal: findIdx(['goal', 'target']),
            startDate: findIdx(['start', 'begin']),
            endDate: findIdx(['end', 'finish'])
        };

        if (idx.orgName === -1) {
            return NextResponse.json({ error: 'CSV must contain an "Organization Name" column' }, { status: 400 });
        }

        for (const line of dataLines) {
            const cols = splitCsvLine(line);
            if (cols.length < 2) continue; // Skip empty rows

            const orgName = cols[idx.orgName]?.trim();
            if (!orgName) continue;

            const campaignName = idx.campaignName !== -1 ? cols[idx.campaignName]?.trim() : `${orgName} Fundraiser`;
            const contactName = idx.contactName !== -1 ? cols[idx.contactName]?.trim() : null;
            const email = idx.email !== -1 ? cols[idx.email]?.trim() : null;
            const phone = idx.phone !== -1 ? cols[idx.phone]?.trim() : null;
            const goal = idx.goal !== -1 ? parseFloat(cols[idx.goal]?.replace(/[^0-9.]/g, '')) : 0;

            let startDate = null;
            let endDate = null;

            if (idx.startDate !== -1 && cols[idx.startDate]) {
                try { startDate = new Date(cols[idx.startDate]); } catch (e) { }
            }
            if (idx.endDate !== -1 && cols[idx.endDate]) {
                try { endDate = new Date(cols[idx.endDate]); } catch (e) { }
            }

            // 1. Find or Create Organization (Customer)
            // Match by Name OR Email
            let customer = await prisma.customer.findFirst({
                where: {
                    OR: [
                        { name: { equals: orgName, mode: 'insensitive' } },
                        { contact_email: email && email.length > 0 ? { equals: email, mode: 'insensitive' } : undefined }
                    ],
                    // Optionally filter by businessId if strict multi-tenancy
                    // business_id: businessId 
                }
            });

            if (customer) {
                // Update basic info if missing
                const updateData: any = {};
                if (!customer.contact_email && email) updateData.contact_email = email;
                if (!customer.contact_name && contactName) updateData.contact_name = contactName;
                if (!customer.contact_phone && phone) updateData.contact_phone = phone;

                // Ensure type is correct if we found a generic customer?
                // No, respect existing type, but maybe tag?

                if (Object.keys(updateData).length > 0) {
                    await prisma.customer.update({
                        where: { id: customer.id },
                        data: updateData
                    });
                    updatedOrgs++;
                }
            } else {
                // Create new Organization
                // We use type 'fundraiser_org' (Need to check if it's enum or string, assuming string based on previous debugging)
                // Actually previous debugging showed it's likely an Enum in Schema but string in Raw.
                // Let's safe-guard: if schema uses Enum, we must use Enum value.
                // But since we can't import Enum easily in dynamic route without generating client,
                // we'll rely on Prisma Client's typings if available, or just pass string if it's string.
                // Based on `check_campaigns.js`, it expected `OrgType`.
                // We'll trust Prisma Client string literal union.

                try {
                    customer = await prisma.customer.create({
                        data: {
                            name: orgName,
                            contact_name: contactName,
                            contact_email: email,
                            contact_phone: phone,
                            type: 'fundraiser_org', // Ensure this matches Schema Enum Value!
                            status: 'LEAD',
                            business_id: businessId
                        }
                    });
                    createdOrgs++;
                } catch (e) {
                    // Fallback for enum issues?
                    console.error(`Failed to create org ${orgName}:`, e);
                    logs.push(`Failed to create Org: ${orgName}`);
                    continue;
                }
            }

            // 2. Create Campaign if not exists
            const existingCampaign = await prisma.fundraiserCampaign.findFirst({
                where: {
                    customer_id: customer.id,
                    name: { equals: campaignName, mode: 'insensitive' }
                }
            });

            if (!existingCampaign) {
                await prisma.fundraiserCampaign.create({
                    data: {
                        customer_id: customer.id,
                        name: campaignName,
                        goal_amount: goal,
                        start_date: startDate,
                        end_date: endDate,
                        status: 'Lead' // Default status
                    }
                });
                createdCampaigns++;
            }
        }

        return NextResponse.json({
            success: true,
            message: `Import complete: ${createdOrgs} New Orgs, ${updatedOrgs} Updated Orgs, ${createdCampaigns} New Campaigns.`,
            logs
        });

    } catch (e: any) {
        console.error("Fundraiser Import Error:", e);
        return NextResponse.json({ error: e.message || 'Server Error' }, { status: 500 });
    }
}
