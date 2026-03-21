import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

// GET: Fetch all available templates (Global + Business Specific)
export async function GET(req: Request) {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const businessId = session.user.businessId;

    try {
        const templates = await prisma.documentTemplate.findMany({
            where: {
                OR: [
                    { isGlobal: true },
                    { business_id: businessId }
                ]
            },
            orderBy: { name: 'asc' }
        });

        // If no templates exist yet in DB, return defaults but mapped to look like DB objects
        if (templates.length === 0) {
            return NextResponse.json([
                {
                    id: 'tmpl_basic_agreement',
                    name: 'Fundraiser Agreement (Standard)',
                    type: 'Agreement',
                    category: 'Contract',
                    content: `
                        <div style="padding: 40px; font-family: sans-serif; max-width: 800px; margin: 0 auto;">
                            <h1 style="text-align: center; color: #333;">Fundraiser Agreement</h1>
                            <hr style="border: 1px solid #eee; margin: 20px 0;" />
                            <p><strong>Date:</strong> {{Date}}</p>
                            <p><strong>Organization:</strong> {{OrganizationName}}</p>
                            <p><strong>Contact:</strong> {{ContactName}} ({{ContactEmail}})</p>
                            
                            <h3>1. Agreement Terms</h3>
                            <p>This agreement confirms that <strong>{{OrganizationName}}</strong> will participate in the Freezer Chef fundraising program.</p>
                            
                            <h3>2. Campaign Goal</h3>
                            <p>The target goal for this campaign is <strong>{{GoalAmount}}</strong>.</p>
                            
                            <h3>3. Delivery</h3>
                            <p>Orders will be delivered to: <br/> {{DeliveryAddress}}</p>

                            <h3>4. Menu Selection</h3>
                            <p>The following recipes will be offered in this fundraiser:</p>
                            
                            <div style="display: flex; gap: 20px; margin-top: 10px;">
                                <div style="flex: 1; background: #f9fafb; padding: 15px; border-radius: 8px; border: 1px solid #eee;">
                                    <p style="margin-top: 0; font-weight: bold; color: #333;">Family Bundle</p>
                                    <div style="font-size: 14px;">{{Bundle1Recipes}}</div>
                                </div>
                                <div style="flex: 1; background: #f9fafb; padding: 15px; border-radius: 8px; border: 1px solid #eee;">
                                    <p style="margin-top: 0; font-weight: bold; color: #333;">Two-Person Bundle</p>
                                    <div style="font-size: 14px;">{{Bundle2Recipes}}</div>
                                </div>
                            </div>
                            
                            <br/><br/>
                            <div style="display: flex; justify-content: space-between; margin-top: 50px;">
                                <div>
                                    <div style="border-bottom: 1px solid #000; width: 200px; height: 1px; margin-bottom: 10px;"></div>
                                    <p>Authorized Signature</p>
                                </div>
                                <div>
                                    <div style="border-bottom: 1px solid #000; width: 200px; height: 1px; margin-bottom: 10px;"></div>
                                    <p>Date</p>
                                </div>
                            </div>
                        </div>
                    `,
                    isGlobal: true
                },
                {
                    id: 'tmpl_fundraiser_pitch',
                    name: 'Fundraiser Sales Overview',
                    type: 'Marketing',
                    category: 'Sales',
                    content: `
                        <div style="font-family: sans-serif; max-width: 800px; margin: 0 auto; color: #333; line-height: 1.6;">
                            <!-- ... existing content ... -->
                        </div>
                    `,
                    isGlobal: true
                },
                {
                    id: 'tmpl_fc_flyer_2026',
                    name: 'Freezer Chef Flyer (2026)',
                    type: 'Marketing',
                    category: 'Sales',
                    content: `
                        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 800px; margin: 0 auto; color: #000; line-height: 1.5;">

                            <h1 style="text-align: center; color: #1e3a8a; font-size: 28px; margin-bottom: 20px;">Please Join Us for A Freezer Chef Fundraiser!</h1>

                            <div style="display: flex; gap: 20px; align-items: start; margin-bottom: 20px;">
                                <div style="flex: 1;">
                                    <p style="margin-bottom: 15px;">
                                        At Freezer Chef, we bring over 10 years of experience in freezer meal preparation to your table—taking the stress out of dinnertime and replace it with comforting, crave-worthy flavors your whole family will love. Our freezer-ready meals are handcrafted with care and packed with nostalgia—from hearty casseroles and slow-simmered soups to warm, oven-baked favorites and cozy crockpot classics.
                                    </p>
                                    <p style="margin-bottom: 15px;">
                                        Whether you're feeding a hungry crew or stocking up for busy weeknights, we make it easy to serve up real food that feels like a warm hug. Each dish is flash-frozen at peak freshness, ready when you are, and bursting with flavor in every bite. For more information about Freezer Chef, please visit their website: <strong><a href="https://myfreezerchef.com" style="color: #2563eb;">myfreezerchef.com</a></strong>
                                    </p>
                                </div>
                            </div>

                            <div style="background: #f0f9ff; border: 2px solid #bae6fd; padding: 20px; border-radius: 12px; margin-bottom: 30px;">
                                <p style="margin: 5px 0;"><strong>📅 DATE:</strong> {{FundraiserDelivery}} Pickup at {{FundraiserDeliveryTime}}</p>
                                <p style="margin: 5px 0;"><strong>📍 WHERE:</strong> {{FundraiserPickup}}</p>
                                <br/>
                                <p style="margin: 5px 0;"><strong>💰 COST:</strong></p>
                                <p style="margin: 5px 0 0 20px;">Serves 2 = \${{Bundle1Price}} / 5 meals that feed 2</p>
                                <p style="margin: 5px 0 0 20px;">Serves 5 = \${{Bundle2Price}} / 5 meals that feed 5</p>
                            </div>

                            <div style="display: flex; gap: 30px; margin-bottom: 40px;">
                                <!-- Bundle 1 -->
                                <div style="flex: 1;">
                                    <h3 style="color: #1e3a8a; border-bottom: 2px solid #1e3a8a; padding-bottom: 5px; margin-bottom: 15px;">Set 1 – Family Friendly</h3>
                                    <div style="font-weight: bold; color: #334155;">
                                        {{Bundle1Recipes}}
                                    </div>
                                </div>
                                <!-- Bundle 2 -->
                                <div style="flex: 1;">
                                    <h3 style="color: #047857; border-bottom: 2px solid #047857; padding-bottom: 5px; margin-bottom: 15px;">Set 2 – Keto/GF</h3>
                                    <div style="font-weight: bold; color: #334155;">
                                        {{Bundle2Recipes}}
                                    </div>
                                </div>
                            </div>

                            <div style="border-top: 2px dashed #94a3b8; padding-top: 20px; margin-top: 40px;">
                                <p style="font-weight: bold; text-align: center; margin-bottom: 20px;">
                                    To order your meals, please fill out the bottom & return to {{ContactName}} along with your payment. <br/>
                                    All checks must be made to {{ChecksPayableTo}} <br/>
                                    Orders due: {{FundraiserDeadline}}, by {{FundraiserDeadlineTime}}
                                </p>

                                <div style="background: #fff; border: 1px solid #cbd5e1; padding: 20px; border-radius: 4px;">
                                    <div style="margin-bottom: 15px;">
                                        Name: ____________________________________________________________________________________
                                    </div>
                                    <div style="margin-bottom: 25px;">
                                        Phone: _______________________________________ &nbsp;&nbsp; Email: ______________________________________
                                    </div>

                                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px;">
                                        <div>
                                            <strong>Serves 2</strong> __________ <br/><br/>
                                            Set 1 ______ &nbsp;&nbsp; Set 2 ________
                                        </div>
                                        <div>
                                            <strong>Serves 5</strong> __________ <br/><br/>
                                            Set 1 ______ &nbsp;&nbsp; Set 2 ________
                                        </div>
                                    </div>

                                    <div style="text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 10px;">
                                        Office Use Only: &nbsp;&nbsp; Paid Date: ____________ &nbsp;&nbsp; Payment Type: ___________ &nbsp;&nbsp; Ck # _______
                                    </div>
                                </div>
                            </div>

                        </div>
                    `,
                    isGlobal: true
                }
            ]);
        }

        return NextResponse.json(templates);

    } catch (e) {
        console.error("Error fetching templates", e);
        return NextResponse.json({ error: "Failed to fetch templates" }, { status: 500 });
    }
}

// POST: Create a new Custom Template (Manager+)
export async function POST(req: Request) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { name, content, category, isGlobal } = body;

    // Only Super Admin can create Global templates
    if (isGlobal && !(session.user as any).isSuperAdmin) {
        return NextResponse.json({ error: 'Only Super Admins can create global templates' }, { status: 403 });
    }

    try {
        const template = await prisma.documentTemplate.create({
            data: {
                name,
                content,
                category,
                isGlobal: !!isGlobal,
                business_id: isGlobal ? null : session.user.businessId
            }
        });
        return NextResponse.json(template);
    } catch (e) {
        console.error("Error creating template", e);
        return NextResponse.json({ error: "Failed to create template" }, { status: 500 });
    }
}
