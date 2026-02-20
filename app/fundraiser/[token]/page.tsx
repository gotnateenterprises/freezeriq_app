import { Metadata, ResolvingMetadata } from 'next';
import ScoreboardClient from './ScoreboardClient';
import { prisma } from '@/lib/db';

interface Props {
    params: Promise<{ token: string }>;
}

export async function generateMetadata(
    { params }: Props,
    parent: ResolvingMetadata
): Promise<Metadata> {
    const { token } = await params;

    const campaign = await prisma.fundraiserCampaign.findUnique({
        id: undefined, // Prisma fix if fields are missing? No, should be public_token: token
        where: { public_token: token },
        include: {
            customer: {
                select: { name: true }
            }
        }
    });

    if (!campaign) {
        return {
            title: 'Fundraiser Not Found | FreezerIQ',
        };
    }

    const description = `Support ${(campaign as any).customer.name}'s fundraiser! We've raised $${campaign.total_sales || 0} of our $${campaign.goal_amount} goal.`;

    return {
        title: `${campaign.name} | Live Scoreboard`,
        description,
        openGraph: {
            title: `${campaign.name} - Support Now!`,
            description,
            type: 'website',
            images: ['/images/fundraiser-og-default.png'], // We'll need a default OG image
        },
    };
}

export default async function ScoreboardPage({ params }: Props) {
    const { token } = await params;
    return <ScoreboardClient token={token} />;
}
