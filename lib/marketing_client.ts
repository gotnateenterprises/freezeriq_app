
export interface CampaignStats {
    sent: number;
    opened: number;
    clicked: number;
}

export interface Campaign {
    id: string;
    subject: string;
    body: string;
    channel: 'email' | 'sms';
    status: 'draft' | 'sent';
    sent_at?: string;
    audience_size: number;
    stats?: CampaignStats;
}

export interface MarketingClient {
    sendCampaign(campaign: Omit<Campaign, 'id' | 'status' | 'stats'>): Promise<{ id: string; status: 'sent' }>;
    getCampaigns(): Promise<Campaign[]>;
}

export class MockMarketingClient implements MarketingClient {
    // In-memory store for the session
    private campaigns: Campaign[] = [
        {
            id: 'camp_demo_1',
            subject: 'Founders Club: Early Access to Q2 Menu',
            body: 'Hey there! Our Q2 menu is live. Order now.',
            channel: 'email',
            status: 'sent',
            sent_at: new Date(Date.now() - 86400000 * 2).toISOString(),
            audience_size: 142,
            stats: { sent: 142, opened: 89, clicked: 45 }
        },
        {
            id: 'camp_demo_2',
            subject: 'Flash Sale: 20% Off Inventory',
            body: 'Clearance event happening this weekend.',
            channel: 'sms',
            status: 'sent',
            sent_at: new Date(Date.now() - 86400000 * 7).toISOString(),
            audience_size: 56,
            stats: { sent: 56, opened: 50, clicked: 12 }
        }
    ];

    async sendCampaign(input: Omit<Campaign, 'id' | 'status' | 'stats'>): Promise<{ id: string; status: 'sent' }> {
        console.log(`[MockMarketing] Sending ${input.channel.toUpperCase()} to ${input.audience_size} recipients...`);
        console.log(`[MockMarketing] Subject: ${input.subject}`);
        console.log(`[MockMarketing] Body: "${input.body}"`);

        // Simulate Network Delay
        await new Promise(resolve => setTimeout(resolve, 1500));

        const newCampaign: Campaign = {
            id: `camp_${Date.now()}`,
            ...input,
            status: 'sent',
            sent_at: new Date().toISOString(),
            stats: {
                sent: input.audience_size,
                opened: 0,
                clicked: 0
            }
        };

        this.campaigns.unshift(newCampaign);
        return { id: newCampaign.id, status: 'sent' };
    }

    async getCampaigns(): Promise<Campaign[]> {
        return this.campaigns;
    }
}

// Singleton Instance
export const marketingClient = new MockMarketingClient();
