import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

export async function POST() {
    try {
        const session = await auth();
        // Only allow Super Admins or specifically authorized users to seed global resources
        // For simplicity during development, we allow any authenticated admin
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const resources = [
            {
                title: "🔑 How to get a Gemini API Key",
                description: "Step-by-step guide to enable AI content generation (Recipe Descriptions & Photos).",
                type: "FAQ",
                category: "Settings & AI",
                content: `
### Step 1: Visit Google AI Studio
Go to [aistudio.google.com](https://aistudio.google.com/) and sign in with your Google Account.

### Step 2: Create API Key
Click on **"Get API Key"** in the top left sidebar. Then click **"Create API key in new project"**.

### Step 3: Copy & Save
Copy the generated key (it starts with \`AIza...\`). Go to **Settings > AI Content** in FreezerIQ and paste it into the Gemini field.

### Testing your key
Once saved, go to any Recipe and click **"✨ AI Generate"** to see it in action!
                `,
                order: 1
            },
            {
                title: "📅 Google Calendar Setup",
                description: "Fixing 403 errors and sharing your production calendar.",
                type: "FAQ",
                category: "Logistics",
                content: `
### Resolving "403 Forbidden" Errors
If you see a 403 error on your calendar, follow these steps:

1. **Open Google Calendar** on your computer.
2. In the left sidebar, find your calendar and click **Settings and Sharing**.
3. Under **Access permissions for events**, check the box for **"Make available to public"**.
4. Set the dropdown to **"See all event details"**.
5. Copy the **"Public URL to this calendar"** or **"Calendar ID"** and paste it into FreezerIQ Settings.

*Note: You can use a dedicated business calendar to keep your personal events private.*
                `,
                order: 2
            },
            {
                title: "📸 AI Photo Grab vs. Upload",
                description: "Best practices for making your storefront look premium.",
                type: "SOP",
                category: "Culinary",
                content: `
### Option 1: AI Auto-Grab (Fastest)
Use the **"Auto-Grab"** button in the Recipe Editor to search the web and AI-generate a photo that matches your recipe name. This is perfect for standard meals like "Lasagna" or "Chicken Enchiladas".

### Option 2: Custom Upload (Premium)
For a truly premium look, we recommend taking a photo of your actual cooked meal.
- Use natural lighting (near a window).
- Plate the food on a clean, simple white dish.
- Upload directly using the **"Upload"** button.

*Tip: A mix of AI for speed and custom photos for your 'Signature' meals works best.*
                `,
                order: 3
            },
            {
                title: "📣 Fundraising Promotion",
                description: "How to download and use social media toolkit for your organizations.",
                type: "SOP",
                category: "Marketing",
                content: `
### Accessing Graphics
Go to **Fundraisers > Promotion Tools**. You can download pre-filled graphics with the organization's name and goals already embedded.

### Best Practices
1. **Send the Secret Link**: Give the "Coordinator Portal" link to your organization lead.
2. **Flyer Distribution**: Print the automated PDF flyer and have them send it home with students/members.
3. **Weekly Updates**: Use the "Live Scoreboard" link in email updates to create friendly competition.
                `,
                order: 4
            },
            {
                title: "⚖️ Managing Recipe Scales",
                description: "Scaling recipes for 'Family Friendly' (serves 4-6) vs 'Regular' (serves 2).",
                type: "SOP",
                category: "Culinary",
                content: `
### The "Duplicate as Serves 2" Feature
If you have a standard Family-sized recipe, use the **"Duplicate as Small"** button. This automatically:
- Halves all ingredient quantities.
- Updates the Yield and Name.
- Preserves your instructions.

### Batching for Production
When starting a Production Run, you can specify exactly how many of each "Size" you are prepping. The Shopping List will combine all requirements automatically.
                `,
                order: 5
            },
            {
                title: "🏷️ Smarter Label Printing",
                description: "Connecting instructions to the right box sizes.",
                type: "SOP",
                category: "Logistics",
                content: `
### Setup Instructions
In the **Label Designer**, you can create different "Templates" for Trays vs. Bags.

### Batch Printing
When you finish a **Production Run**, click **"Print Labels"**. The system will scan all assigned recipes and generate a single PDF with the exact number of labels needed for every unit prepped.
                `,
                order: 6
            },
            {
                title: "🤝 Coordinator Portal 101",
                description: "Empowering your fundraising partners to do the busy work.",
                type: "SOP",
                category: "CRM",
                content: `
### What is the Coordinator Portal?
It's a "Lite" version of the dashboard for your hosts. They can:
- Enter manual/paper orders.
- View a leaderboard of top sellers.
- Download their specific marketing assets.

### How to Invite a Coordinator
Go to the **Fundraiser CRM**, open the organization, and click **"Copy Secret Portal Link"**. Send this to them via email or text.
                `,
                order: 7
            },
            {
                title: "☁️ Cloud Sync & Backups",
                description: "Keeping your data safe with automated OneDrive sync.",
                type: "SOP",
                category: "Settings",
                content: `
### Automated Backups
FreezerIQ saves a local copy of your database every time you click "Save".

### For Off-site Safety
1. Find your **backups/** folder in the app directory.
2. Right-click and choose **"Always keep on this device"** (if using OneDrive).
3. Ensure OneDrive is signed in and syncing.

*This ensures that even if your computer is lost, your recipes and customer list are safe in the cloud.*
                `,
                order: 8
            }
        ];

        // Seed global resources (business_id remains null)
        for (const res of resources) {
            await prisma.trainingResource.upsert({
                where: {
                    // We use title as a unique constraint for seeding
                    id: `seed-${res.order}`
                },
                update: {
                    ...res,
                    type: res.type as any,
                    isActive: true
                },
                create: {
                    id: `seed-${res.order}`,
                    ...res,
                    type: res.type as any,
                    isActive: true
                }
            });
        }

        return NextResponse.json({ success: true, seededCount: resources.length });
    } catch (error: any) {
        console.error("[Seed API] Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
