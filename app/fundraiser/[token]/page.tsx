import { Metadata, ResolvingMetadata } from 'next';
import ScoreboardClient from './ScoreboardClient';
import { prisma } from '@/lib/db';
import { resolveCanonicalSupporterUrl } from '@/lib/fundraiserCanonicalUrl';

interface Props {
    params: Promise<{ token: string }>;
}

/**
 * FR-SUPPORTER-SHARE-INTEGRITY-1 — the scoreboard points at the fundraiser, not at itself.
 *
 * The scoreboard is a progress view, not the place to order. Its share buttons used to share the
 * browser's own address and its preview text read "We've raised $0 of our $null goal" for every
 * campaign without a dollar goal (most of them), with an og:image that does not exist. It now
 * resolves the ONE canonical public fundraiser URL (lib/fundraiserCanonicalUrl.ts — the ordering
 * page, the same link the coordinator and the supporter page share) server-side, publishes it as
 * canonical/og:url, and hands it to the client for its share and order buttons.
 */
async function loadScoreboardIdentity(token: string) {
    const campaign = await prisma.fundraiserCampaign.findUnique({
        where: { public_token: token },
        select: {
            id: true,
            name: true,
            public_token: true,
            customer: {
                select: {
                    name: true,
                    business: { select: { slug: true, custom_domain: true } },
                },
            },
        },
    });
    if (!campaign) return null;
    const business = (campaign as any).customer?.business ?? null;
    const shareUrl = resolveCanonicalSupporterUrl({
        campaignId: campaign.id,
        publicToken: campaign.public_token,
        slug: business?.slug ?? null,
        customDomain: business?.custom_domain ?? null,
    });
    return { name: campaign.name, organizationName: (campaign as any).customer?.name ?? null, shareUrl };
}

export async function generateMetadata(
    { params }: Props,
    parent: ResolvingMetadata
): Promise<Metadata> {
    const { token } = await params;

    const campaign = await loadScoreboardIdentity(token);

    if (!campaign) {
        return {
            title: 'Fundraiser Not Found | FreezerIQ',
        };
    }

    const org = campaign.organizationName || 'this fundraiser';
    const description = `Support ${org}! Order freezer meal bundles to help the fundraiser reach its goal.`;
    const publicOrigin = campaign.shareUrl ? new URL(campaign.shareUrl).origin : null;

    return {
        title: `${campaign.name} | Live Scoreboard`,
        description,
        ...(campaign.shareUrl ? { alternates: { canonical: campaign.shareUrl } } : {}),
        openGraph: {
            title: `${campaign.name} - Support Now!`,
            description,
            type: 'website',
            ...(campaign.shareUrl ? { url: campaign.shareUrl } : {}),
            ...(publicOrigin ? { images: [`${publicOrigin}/freezer-chef-logo.png`] } : {}),
        },
    };
}

export default async function ScoreboardPage({ params }: Props) {
    const { token } = await params;
    const identity = await loadScoreboardIdentity(token);
    return <ScoreboardClient token={token} shareUrl={identity?.shareUrl ?? null} />;
}
