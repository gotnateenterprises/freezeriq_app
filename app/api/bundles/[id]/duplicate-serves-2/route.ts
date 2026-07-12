import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { resolveVariantSize } from '@/lib/serving_multipliers';

/**
 * CB-1: Atomic bundle duplication with family linking.
 *
 * Creates a Serves-2 clone of an existing family/serves-5 bundle and
 * atomically links both siblings via a shared `family_id` inside a
 * single Prisma transaction.
 *
 * The client supplies ONLY the source bundle ID (from the URL path).
 * All structural data is derived server-side:
 *   - family_id is generated or reused from the source
 *   - business_id comes from the authenticated session
 *   - serving_tier normalization uses resolveVariantSize()
 *   - clone name, SKU, and tier follow BundleEditor conventions
 *
 * Security:
 *   - Source bundle must belong to the authenticated tenant's business
 *   - No client-supplied family_id, business_id, or tier is trusted
 *   - Duplicate siblings are rejected before creation
 *   - Both source update and clone creation commit or roll back together
 */

/** Normalized serves-2 tier values that indicate the bundle is already a small variant */
const SERVES_2_CANONICAL = 'serves_2';
const SERVES_5_CANONICAL = 'serves_5';

interface DuplicateResponse {
  id: string;
  name: string;
  sku: string;
  serving_tier: string;
  family_id: string;
}

interface ErrorResponse {
  error: string;
  code?: string;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<DuplicateResponse | ErrorResponse>> {
  // ── 1. Authenticate the tenant user ─────────────────────────────────────
  const session = await auth();
  if (!session?.user?.businessId) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  const businessId: string = session.user.businessId;
  const { id: sourceId } = await params;

  try {
    // ── 2. Load and validate the source bundle ──────────────────────────
    const source = await prisma.bundle.findUnique({
      where: { id: sourceId },
      include: {
        contents: {
          orderBy: { position: 'asc' },
          include: {
            recipe: { select: { id: true, name: true } }
          }
        }
      }
    });

    if (!source) {
      return NextResponse.json(
        { error: 'Source bundle not found' },
        { status: 404 }
      );
    }

    // ── 3. Reject if source does not belong to the tenant ───────────────
    if (source.business_id !== businessId) {
      return NextResponse.json(
        { error: 'Forbidden' },
        { status: 403 }
      );
    }

    // ── 4. Normalize the source tier and reject if already serves-2 ─────
    const normalizedSourceTier = resolveVariantSize(source.serving_tier);

    if (normalizedSourceTier === SERVES_2_CANONICAL) {
      return NextResponse.json(
        {
          error: 'Cannot duplicate: this bundle is already a Serves 2 variant.',
          code: 'ALREADY_SERVES_2'
        },
        { status: 409 }
      );
    }

    // ── 5. Check for existing Serves-2 sibling ──────────────────────────
    // Two detection strategies to catch both linked and unlinked siblings:
    //
    // Strategy A: If source has family_id, check for any bundle with the
    // same family_id that normalizes to serves_2.
    //
    // Strategy B: Deterministic SKU convention — check for {sku}-S2.
    // This catches pairs created before CB-1 landed (no family_id yet).

    const derivedSku = `${source.sku}-S2`;

    // Find candidates that MIGHT be the serves-2 sibling
    const siblingCandidates = await prisma.bundle.findMany({
      where: {
        business_id: businessId,
        OR: [
          // Strategy A: same family_id (when source has one)
          ...(source.family_id
            ? [{ family_id: source.family_id, id: { not: sourceId } }]
            : []),
          // Strategy B: deterministic SKU
          { sku: derivedSku }
        ]
      },
      select: {
        id: true,
        name: true,
        sku: true,
        serving_tier: true,
        family_id: true,
        is_active: true
      }
    });

    // Filter to only actual serves-2 siblings
    const existingServes2 = siblingCandidates.filter(
      (c) => resolveVariantSize(c.serving_tier) === SERVES_2_CANONICAL
    );

    if (existingServes2.length > 0) {
      const existing = existingServes2[0];
      return NextResponse.json(
        {
          error: `A Serves 2 sibling already exists: "${existing.name}" (${existing.sku}).`,
          code: 'DUPLICATE_SIBLING'
        },
        { status: 409 }
      );
    }

    // ── 6. Check for ambiguous family structures ────────────────────────
    // If source has a family_id, verify there isn't another serves-5 bundle
    // sharing it (which would mean something is structurally wrong).
    if (source.family_id) {
      const familySiblings = siblingCandidates.filter(
        (c) => c.family_id === source.family_id && c.id !== sourceId
      );
      const serves5Siblings = familySiblings.filter(
        (c) => resolveVariantSize(c.serving_tier) === SERVES_5_CANONICAL
      );
      if (serves5Siblings.length > 0) {
        return NextResponse.json(
          {
            error: 'Ambiguous family structure: another family-size bundle shares this family ID.',
            code: 'AMBIGUOUS_FAMILY'
          },
          { status: 409 }
        );
      }
    }

    // ── 7. Check for SKU collision ──────────────────────────────────────
    const skuExists = await prisma.bundle.findUnique({
      where: { sku: derivedSku },
      select: { id: true }
    });

    if (skuExists) {
      return NextResponse.json(
        {
          error: `SKU "${derivedSku}" is already in use by another bundle.`,
          code: 'SKU_CONFLICT'
        },
        { status: 409 }
      );
    }

    // ── 8. Derive the family_id ─────────────────────────────────────────
    const familyId: string = source.family_id ?? crypto.randomUUID();

    // ── 9. Map recipe contents to Serves-2 versions ─────────────────────
    // Follow BundleEditor convention: look for "{recipeName} (Serves 2)"
    // within the same business. Fall back to the original recipe if not found.
    const cloneContents: Array<{ recipe_id: string; position: number; quantity: number }> = [];

    for (let i = 0; i < source.contents.length; i++) {
      const content = source.contents[i];
      const targetName = `${content.recipe.name} (Serves 2)`;

      // Search for a matching Serves-2 recipe in the same business
      const serves2Recipe = await prisma.recipe.findFirst({
        where: {
          business_id: businessId,
          name: { equals: targetName, mode: 'insensitive' }
        },
        select: { id: true }
      });

      cloneContents.push({
        recipe_id: serves2Recipe ? serves2Recipe.id : content.recipe_id,
        position: content.position ?? i,
        quantity: Number(content.quantity) || 1
      });
    }

    // ── 10. Execute the atomic transaction ───────────────────────────────
    // Both the source family_id update and clone creation commit or roll
    // back together. No partial-link state is possible.

    const clone = await prisma.$transaction(async (tx) => {
      // 10a. Update source bundle's family_id (only if null)
      if (!source.family_id) {
        await tx.bundle.update({
          where: { id: sourceId },
          data: { family_id: familyId }
        });
      }

      // 10b. Create the Serves-2 clone with the same family_id
      const newBundle = await tx.bundle.create({
        data: {
          name: `${source.name} (Serves 2)`,
          sku: derivedSku,
          description: source.description,
          serving_tier: SERVES_2_CANONICAL,
          is_active: true,
          show_on_storefront: source.show_on_storefront,
          order_cutoff_date: source.order_cutoff_date,
          price: source.price,
          catalog_id: source.catalog_id,
          image_url: source.image_url,
          business_id: businessId,
          family_id: familyId,
        }
      });

      // 10c. Create the clone's contents
      if (cloneContents.length > 0) {
        await tx.bundleContent.createMany({
          data: cloneContents.map((c) => ({
            bundle_id: newBundle.id,
            recipe_id: c.recipe_id,
            position: c.position,
            quantity: c.quantity
          }))
        });
      }

      return newBundle;
    });

    // ── 11. Return the newly created bundle ──────────────────────────────
    return NextResponse.json({
      id: clone.id,
      name: clone.name,
      sku: clone.sku,
      serving_tier: clone.serving_tier,
      family_id: familyId
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    // Handle Prisma unique constraint violations
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: string }).code === 'P2002'
    ) {
      return NextResponse.json(
        {
          error: 'A bundle with that SKU already exists.',
          code: 'SKU_CONFLICT'
        },
        { status: 409 }
      );
    }

    console.error('[duplicate-serves-2] Transaction failed:', message);
    return NextResponse.json(
      { error: 'Failed to create Serves 2 clone.' },
      { status: 500 }
    );
  }
}
