
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
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

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
        let createdCount = 0;
        let updatedCount = 0;

        // Map column indices
        const idx = {
            firstName: headers.indexOf('first name'),
            lastName: headers.indexOf('last name'),
            email: headers.indexOf('email address'),
            phone: headers.indexOf('phone number'),
            street: headers.indexOf('street address'),
            city: headers.indexOf('city'),
            state: headers.indexOf('state'),
            zip: headers.indexOf('postal code'),
            squareId: headers.indexOf('square customer id'),
            reference: headers.indexOf('reference')
        };

        for (const line of dataLines) {
            const cols = splitCsvLine(line);
            if (cols.length < 2) continue;

            const fName = idx.firstName !== -1 ? cols[idx.firstName] : '';
            const lName = idx.lastName !== -1 ? cols[idx.lastName] : '';
            const fullName = `${fName} ${lName}`.trim() || 'Imported Customer';
            const email = idx.email !== -1 ? cols[idx.email]?.trim() : null;
            const phone = idx.phone !== -1 ? cols[idx.phone]?.trim() : null;
            const squareId = idx.squareId !== -1 ? cols[idx.squareId]?.trim() : null;
            const reference = idx.reference !== -1 ? cols[idx.reference]?.trim() : null;

            // Use Square ID or Email as external identifier
            const externalId = squareId || reference || email;
            if (!externalId && !fullName) continue;

            // Build address
            const addrParts = [];
            if (idx.street !== -1 && cols[idx.street]) addrParts.push(cols[idx.street]);
            if (idx.city !== -1 && cols[idx.city]) addrParts.push(cols[idx.city]);
            if (idx.state !== -1 && cols[idx.state]) addrParts.push(cols[idx.state]);
            if (idx.zip !== -1 && cols[idx.zip]) addrParts.push(cols[idx.zip]);
            const address = addrParts.join(', ');

            // Upsert Logic
            // First check by external_id
            let existing = null;
            if (externalId) {
                existing = await prisma.customer.findFirst({
                    where: {
                        business_id: businessId,
                        OR: [
                            { external_id: externalId },
                            { contact_email: email && email.length > 0 ? email : undefined }
                        ]
                    }
                });
            }

            if (existing) {
                await prisma.customer.update({
                    where: { id: existing.id },
                    data: {
                        name: fullName,
                        contact_name: fullName,
                        contact_email: email,
                        contact_phone: phone,
                        delivery_address: address,
                        external_id: externalId,
                        source: 'Square CSV'
                    }
                });
                updatedCount++;
            } else {
                await prisma.customer.create({
                    data: {
                        business_id: businessId,
                        name: fullName,
                        contact_name: fullName,
                        contact_email: email,
                        contact_phone: phone,
                        delivery_address: address,
                        external_id: externalId,
                        source: 'Square CSV',
                        status: 'LEAD'
                    }
                });
                createdCount++;
            }
        }

        return NextResponse.json({
            success: true,
            message: `Imported ${createdCount} new, Updated ${updatedCount} customers.`,
            logs: [`Successfully processed ${dataLines.length} rows.`]
        });

    } catch (e: any) {
        console.error("Customer Upload Error:", e);
        return NextResponse.json({ error: e.message || 'Server Error' }, { status: 500 });
    }
}
