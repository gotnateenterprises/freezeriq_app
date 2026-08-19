/**
 * CB-2: Coordinator Bundle Selection API
 *
 * GET  /api/coordinator/[token]/bundle-selection
 *   Returns the coordinator's approved candidate families and current selection state.
 *
 * POST /api/coordinator/[token]/bundle-selection
 *   Accepts the coordinator's family-ID selection, validates it against the candidate
 *   pool, and activates both Serves-5 and Serves-2 bundle variants in a single
 *   Serializable transaction.
 *
 * ACCESS MODEL:
 *   Token-based — no auth session required. The coordinator's portal_token is the
 *   sole authenticator. Every request re-derives the owning business from:
 *     portal_token → FundraiserCampaign → Customer → Business
 *   No client-supplied business ID, tenant ID, campaign ID, or bundle ID is trusted.
 *
 * PAYMENT BOUNDARY:
 *   This route processes no payments. Coordinators collect money externally.
 *   Never add Stripe or Square to this file.
 *
 * LOCKED FILES:
 *   This file is a new sibling of the locked app/api/coordinator/[token]/route.ts.
 *   That file is NOT modified.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import {
  resolveCoordinatorCampaignById,
  isCampaignClosed,
  isCanonicalFamilyTier,
  isCanonicalServes2Tier,
  loadCandidateFamilies,
  extractSelectedFamilyIds,
  familySetsEqual,
  dateToIso,
  type BundleSelectionGetResponse,
  type BundleSelectionNotRequired,
} from '@/lib/campaignBundleSelection';
import { requireCoordinatorSession } from '@/lib/coordinatorSession';
import { lockCampaignSelection } from '@/lib/campaignSelectionLock';
import {
  BUNDLE_SELECTION_LOCKED_MESSAGE,
  checkCoordinatorSetup,
  isSetupRefusal,
  type CoordinatorSetupValues,
} from '@/lib/coordinatorSetup';

// ── Concurrency config ───────────────────────────────────────────────────────

/** Maximum number of Serializable transaction attempts before giving up */
const MAX_TX_ATTEMPTS = 3;

/**
 * Prisma error code for serialization failures (write conflicts under Serializable).
 * Prisma surfaces PostgreSQL's serialization_failure (40001) as P2034.
 */
const PRISMA_SERIALIZATION_ERROR = 'P2034';

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: Request): Promise<NextResponse> {
  try {
    // FR-COORD-SEC-1B: authority comes from the session cookie, never a URL.
    const guard = await requireCoordinatorSession(req);
    if (!guard.ok) return guard.response as NextResponse;
    const campaignId = guard.campaignId;

    // 1. Resolve token → campaign → business
    const campaign = await resolveCoordinatorCampaignById(campaignId);
    if (!campaign) {
      return NextResponse.json(
        { error: 'Invalid coordinator link' },
        { status: 404 }
      );
    }

    // 2. Reject closed/completed/archived campaigns
    if (isCampaignClosed(campaign)) {
      return NextResponse.json(
        { error: 'This campaign is no longer accepting bundle selections' },
        { status: 410 }
      );
    }

    // 3. Not-required: legacy campaign with no candidate pool
    if (campaign.bundle_selection_status === 'not_required') {
      const response: BundleSelectionNotRequired = {
        selectionRequired: false,
        message:
          'This campaign does not use coordinator bundle selection. All active bundles are available.',
      };
      return NextResponse.json(response);
    }

    // 4. Only pending and selected states are valid for GET
    if (
      campaign.bundle_selection_status !== 'pending' &&
      campaign.bundle_selection_status !== 'selected'
    ) {
      // Unexpected status — return a safe error
      return NextResponse.json(
        { error: 'Invalid coordinator link' },
        { status: 404 }
      );
    }

    // 5. Load candidate families (tenant-scoped, family_id validated, no fuzzy matching)
    const candidateFamilies = await loadCandidateFamilies(campaign.id, campaign.businessId);

    // 6. If already selected, extract the selected family IDs from active rows
    const selectedFamilyIds =
      campaign.bundle_selection_status === 'selected'
        ? await extractSelectedFamilyIds(campaign.id)
        : [];

    const selectionStatus = campaign.bundle_selection_status as 'pending' | 'selected';

    // ── FR-FLOW-3: the setup context the coordinator needs ─────────────────
    //
    // Locked values are sent so the form can SHOW them, not so it can send them
    // back: the POST accepts no date, deadline, share or limit at all. Also
    // reports whether ordering has begun, so the UI can explain the lock rather
    // than presenting controls that will be refused.
    const setup = await prisma.fundraiserCampaign.findUnique({
      where: { id: campaign.id },
      select: {
        delivery_date: true,
        end_date: true,
        checks_payable: true,
        pickup_location: true,
        delivery_time: true,
        payment_instructions: true,
        external_payment_link: true,
        customer: {
          select: {
            name: true,
          },
        },
      },
    }).catch(() => null);

    const liveOrders = await prisma.order.count({
      where: { campaign_id: campaign.id, canceled_at: null },
    });

    const response: BundleSelectionGetResponse & Record<string, unknown> = {
      selectionRequired: true,
      campaign: {
        id: campaign.id,
        name: campaign.name,
        selectionStatus,
        selectionLimit: campaign.bundle_selection_limit,
        selectedAt: dateToIso(campaign.bundle_selection_at),
      },
      candidateFamilies,
      selectedFamilyIds,
      // Read-only tenant authority, for display.
      locked: {
        organizationName: setup?.customer?.name ?? null,
        deliveryDate: dateToIso(setup?.delivery_date ?? null),
        orderDeadline: dateToIso(setup?.end_date ?? null),
      },
      // Coordinator-editable logistics, current values.
      setup: {
        checksPayable: setup?.checks_payable ?? null,
        pickupLocation: setup?.pickup_location ?? null,
        deliveryTime: setup?.delivery_time ?? null,
        paymentInstructions: setup?.payment_instructions ?? null,
        paymentLink: setup?.external_payment_link ?? null,
      },
      // True once a supporter has ordered: bundle choices are then locked.
      ordersStarted: liveOrders > 0,
    };

    return NextResponse.json(response);
  } catch (err: unknown) {
    console.error('[bundle-selection GET] Unexpected error:', err);
    return NextResponse.json(
      { error: 'An unexpected error occurred' },
      { status: 500 }
    );
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(req: Request): Promise<NextResponse> {
  try {
    // FR-COORD-SEC-1B: authority comes from the session cookie, never a URL.
    const guard = await requireCoordinatorSession(req);
    if (!guard.ok) return guard.response as NextResponse;
    const campaignId = guard.campaignId;

    // 1. Parse and validate request body
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const rawBody = body as Record<string, unknown>;
    const { familyIds: rawFamilyIds } = rawBody;

    if (!Array.isArray(rawFamilyIds)) {
      return NextResponse.json(
        { error: 'familyIds must be a non-empty array of strings' },
        { status: 400 }
      );
    }

    // Validate each element is a non-empty string
    if (!rawFamilyIds.every((id): id is string => typeof id === 'string' && id.trim().length > 0)) {
      return NextResponse.json(
        { error: 'familyIds must be a non-empty array of strings' },
        { status: 400 }
      );
    }

    const familyIds = rawFamilyIds as string[];

    // Reject duplicate family IDs in the submission
    const uniqueFamilyIds = [...new Set(familyIds)];
    if (uniqueFamilyIds.length !== familyIds.length) {
      return NextResponse.json(
        { error: 'Duplicate family IDs are not allowed' },
        { status: 400 }
      );
    }

    // ── FR-FLOW-3: the coordinator's logistics, validated before any write ──
    //
    // Absent entirely when the client sends none, which keeps every pre-FR-FLOW-3
    // caller working. Present-but-invalid is refused here rather than inside the
    // transaction, so a bad payment link costs no database work.
    const sentSetup = ['checksPayable', 'pickupLocation', 'deliveryTime', 'paymentInstructions', 'paymentLink']
      .some((k) => rawBody[k] !== undefined);
    let setupValues: CoordinatorSetupValues | null = null;
    if (sentSetup) {
      const setup = checkCoordinatorSetup({
        checksPayable: rawBody.checksPayable,
        pickupLocation: rawBody.pickupLocation,
        deliveryTime: rawBody.deliveryTime,
        paymentInstructions: rawBody.paymentInstructions,
        paymentLink: rawBody.paymentLink,
      });
      if (isSetupRefusal(setup)) {
        return NextResponse.json({ error: setup.error, code: setup.code }, { status: 400 });
      }
      setupValues = setup.values;
    }

    if (familyIds.length === 0) {
      return NextResponse.json(
        { error: 'familyIds must be a non-empty array of strings' },
        { status: 400 }
      );
    }

    // 2. Pre-transaction: resolve token → campaign → business
    const campaign = await resolveCoordinatorCampaignById(campaignId);
    if (!campaign) {
      return NextResponse.json(
        { error: 'Invalid coordinator link' },
        { status: 404 }
      );
    }

    // 3. Reject closed campaigns
    if (isCampaignClosed(campaign)) {
      return NextResponse.json(
        { error: 'This campaign is no longer accepting bundle selections' },
        { status: 410 }
      );
    }

    // 4. Reject not-required campaigns
    if (campaign.bundle_selection_status === 'not_required') {
      return NextResponse.json(
        { error: 'This campaign does not use bundle selection' },
        { status: 400 }
      );
    }

    // 5. Pre-transaction selection-count gate
    const selectionLimit = campaign.bundle_selection_limit;
    if (familyIds.length !== selectionLimit) {
      return NextResponse.json(
        {
          error: `Choose exactly ${selectionLimit} bundle ${selectionLimit === 1 ? 'family' : 'families'}`,
        },
        { status: 400 }
      );
    }

    // 6. Attempt the activation transaction with bounded retries for serialization conflicts
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_TX_ATTEMPTS; attempt++) {
      try {
        const result = await runActivationTransaction(
          campaign.id,
          campaign.businessId,
          familyIds,
          setupValues
        );
        return result;
      } catch (err: unknown) {
        // Check for Prisma serialization conflict (P2034)
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code: string }).code === PRISMA_SERIALIZATION_ERROR &&
          attempt < MAX_TX_ATTEMPTS
        ) {
          lastError = err;
          console.warn(
            `[bundle-selection POST] Serialization conflict on attempt ${attempt}, retrying...`
          );
          continue;
        }
        // Re-throw — handled below
        throw err;
      }
    }

    // All retry attempts exhausted due to serialization conflicts
    console.error('[bundle-selection POST] All transaction attempts failed:', lastError);
    return NextResponse.json(
      { error: 'Bundle selection has already been submitted' },
      { status: 409 }
    );
  } catch (err: unknown) {
    console.error('[bundle-selection POST] Unexpected error:', err);
    return NextResponse.json(
      { error: 'An unexpected error occurred' },
      { status: 500 }
    );
  }
}

// ── Activation transaction ────────────────────────────────────────────────────

/**
 * Executes the full bundle selection activation inside a Serializable transaction.
 *
 * Transaction sequence (per CB-2 spec):
 *  1.  Re-read the campaign and customer/business chain inside the transaction.
 *  2.  Reconfirm tenant ownership.
 *  3.  Reconfirm campaign is not closed.
 *  4.  Re-read bundle_selection_status and bundle_selection_limit.
 *  5.  Handle already-selected state (idempotency / conflict).
 *  6.  Require status === "pending" for a new activation.
 *  7.  Load candidate CampaignBundle rows inside the transaction.
 *  8.  Confirm every submitted familyId is present in the candidate pool.
 *  9.  Resolve both active bundle variants per family (Serves-5 + Serves-2).
 * 10.  Validate each variant: correct tier, active, same tenant.
 * 11.  Delete stale active CampaignBundle rows (defensive cleanup only).
 * 12.  Preserve all candidate rows.
 * 13.  Insert two active CampaignBundle rows per family with deterministic positions.
 * 14.  Update campaign status and timestamp.
 * 15.  Write CoordinatorActionEvent.
 * 16.  Return the activated selection.
 *
 * Throws on validation failure (caller converts to HTTP response).
 * Throws Prisma P2034 on serialization conflict (caller retries).
 */
async function runActivationTransaction(
  campaignId: string,
  expectedBusinessId: string,
  familyIds: string[],
  /**
   * FR-FLOW-3 logistics. Null when the caller sent none — a pre-FR-FLOW-3 client
   * that submits only familyIds keeps working and leaves the logistics columns
   * exactly as they were.
   */
  setupValues: CoordinatorSetupValues | null
): Promise<NextResponse> {
  return await prisma.$transaction(
    async (tx) => {
      // ── Step 0: take the shared selection lock, FIRST ─────────────────────
      //
      // FR-FLOW-3. Reselection is legal only while the campaign has no supporter
      // orders, which makes it a check-then-write; public order creation is the
      // write that invalidates the check. Serializable alone does not help here,
      // because the order path runs at READ COMMITTED and therefore never joins
      // PostgreSQL's SSI dependency graph. This advisory lock is honoured at
      // every isolation level, and app/api/public/order/route.ts takes the SAME
      // lock, so exactly one of the two reaches its decision first.
      //
      // It must be the first statement: taken later, the two paths still queue,
      // but each is already holding a snapshot from before the other committed —
      // which is the bug rather than the fix.
      await lockCampaignSelection(tx, campaignId);

      // ── Step 1-4: Re-read campaign and reconfirm ownership ────────────────

      const freshCampaign = await tx.fundraiserCampaign.findUnique({
        where: { id: campaignId },
        select: {
          id: true,
          name: true,
          status: true,
          closed_at: true,
          bundle_selection_status: true,
          bundle_selection_at: true,
          bundle_selection_limit: true,
          customer: {
            select: {
              business_id: true,
            },
          },
        },
      });

      if (!freshCampaign || !freshCampaign.customer.business_id) {
        return NextResponse.json(
          { error: 'Invalid coordinator link' },
          { status: 404 }
        );
      }

      // Reconfirm tenant ownership — business must match what was resolved pre-transaction
      if (freshCampaign.customer.business_id !== expectedBusinessId) {
        return NextResponse.json(
          { error: 'Invalid coordinator link' },
          { status: 404 }
        );
      }

      const businessId = freshCampaign.customer.business_id;

      // Reconfirm campaign is not closed
      if (isCampaignClosed(freshCampaign)) {
        return NextResponse.json(
          { error: 'This campaign is no longer accepting bundle selections' },
          { status: 410 }
        );
      }

      const currentStatus = freshCampaign.bundle_selection_status;
      const selectionLimit = freshCampaign.bundle_selection_limit;

      // ── Step 4b: the first-order lock ─────────────────────────────────────
      //
      // FR-FLOW-3. The first non-cancelled supporter order is what freezes the
      // coordinator's choices: once somebody has bought a specific bundle, the
      // set of things on sale is no longer the coordinator's to change. Counted
      // INSIDE the transaction and AFTER the lock above, so no order can appear
      // between this count and the write it authorises.
      //
      // `canceled_at: null` is the owner's contract for a real order. It is
      // deliberately narrower than CB-6's tenant reset, which blocks on ANY
      // persisted order row including cancelled ones — a tenant correcting a
      // mistake is a different, audited action from a coordinator revising their
      // own setup.
      const liveOrderCount = await tx.order.count({
        where: { campaign_id: campaignId, canceled_at: null },
      });
      const ordersHaveStarted = liveOrderCount > 0;

      // ── Step 5: Handle already-selected (idempotency / reselection) ───────

      if (currentStatus === 'selected') {
        // Derive which family IDs were previously selected from active rows
        const activeRows = await tx.campaignBundle.findMany({
          where: { campaign_id: campaignId, state: 'active' },
          select: {
            bundle: {
              select: {
                family_id: true,
                serving_tier: true,
              },
            },
          },
        });

        const existingFamilyIds: string[] = [];
        const seenFamilies = new Set<string>();
        for (const row of activeRows) {
          const fid = row.bundle.family_id;
          if (fid && !seenFamilies.has(fid) && isCanonicalFamilyTier(row.bundle.serving_tier)) {
            seenFamilies.add(fid);
            existingFamilyIds.push(fid);
          }
        }

        if (familySetsEqual(existingFamilyIds, familyIds)) {
          // Identical submission — idempotent success
          return NextResponse.json({
            status: 'selected',
            alreadySelected: true,
            campaign: {
              id: freshCampaign.id,
              name: freshCampaign.name,
              selectionStatus: 'selected',
              selectionLimit,
              selectedAt: dateToIso(freshCampaign.bundle_selection_at),
            },
            selectedFamilyIds: existingFamilyIds,
          });
        }

        // ── FR-FLOW-3: a DIFFERENT submission after selection ──────────────
        //
        // Previously this was refused outright, which made a coordinator's first
        // submission irreversible even seconds later with nobody having ordered.
        // The owner contract is narrower than "never": revision is allowed right
        // up until the first supporter order, and forbidden from that moment on.
        if (ordersHaveStarted) {
          return NextResponse.json(
            { error: BUNDLE_SELECTION_LOCKED_MESSAGE, code: 'orders_started' },
            { status: 409 }
          );
        }
        // Fall through: no orders yet, so this is a legal reselection and is
        // handled by exactly the same activation path as a first submission.
      }

      // ── Step 6: Require a state this activation may write ─────────────────
      //
      // 'pending'  — the first submission.
      // 'selected' — a reselection, reachable only by falling through the block
      //              above, which returns before here whenever an order exists.
      // Anything else ('not_required', or a value a future writer invents) is
      // refused rather than guessed at.
      if (currentStatus !== 'pending' && currentStatus !== 'selected') {
        return NextResponse.json(
          { error: 'Bundle selection has already been submitted' },
          { status: 409 }
        );
      }

      // Belt and braces: the fall-through above is the only path that reaches
      // here with 'selected', and it is guarded by ordersHaveStarted. Asserting
      // it again here means a future edit that reorders those blocks fails
      // closed instead of silently permitting a post-order reselection.
      if (ordersHaveStarted && currentStatus === 'selected') {
        return NextResponse.json(
          { error: BUNDLE_SELECTION_LOCKED_MESSAGE, code: 'orders_started' },
          { status: 409 }
        );
      }

      // Reconfirm selection count (re-read limit inside transaction)
      if (familyIds.length !== selectionLimit) {
        return NextResponse.json(
          {
            error: `Choose exactly ${selectionLimit} bundle ${selectionLimit === 1 ? 'family' : 'families'}`,
          },
          { status: 400 }
        );
      }

      // ── Step 7: Load candidate rows inside the transaction ────────────────

      const candidateRows = await tx.campaignBundle.findMany({
        where: {
          campaign_id: campaignId,
          state: 'candidate',
        },
        select: {
          bundle: {
            select: {
              id: true,
              name: true,
              sku: true,
              family_id: true,
              serving_tier: true,
              business_id: true,
              is_active: true,
            },
          },
        },
      });

      // Build a map of family_id → serves_5 bundle for candidate lookup
      const candidateFamilyMap = new Map<
        string,
        {
          id: string;
          name: string;
          sku: string | null;
          family_id: string;
          serving_tier: string;
          business_id: string | null;
          is_active: boolean;
        }
      >();

      for (const row of candidateRows) {
        const b = row.bundle;
        // Extract family_id to a local const so TypeScript narrows it to `string`.
        // The `b` object retains `family_id: string | null` from Prisma even after
        // the truthiness check, so we reconstruct the stored value with the narrowed field.
        const familyId = b.family_id;
        if (
          familyId &&
          b.business_id === businessId &&
          isCanonicalFamilyTier(b.serving_tier)
        ) {
          candidateFamilyMap.set(familyId, { ...b, family_id: familyId });
        }
      }

      // ── Step 8: Confirm every submitted familyId is in the candidate pool ──

      for (const fid of familyIds) {
        if (!candidateFamilyMap.has(fid)) {
          return NextResponse.json(
            { error: 'One or more selected families are unavailable' },
            { status: 400 }
          );
        }
      }

      // ── Step 9-10: Resolve and validate both variants per family ──────────

      // Batch-load all Serves-2 siblings for the submitted family IDs
      const serves2Bundles = await tx.bundle.findMany({
        where: {
          business_id: businessId,
          family_id: { in: familyIds },
          is_active: true,
        },
        select: {
          id: true,
          name: true,
          family_id: true,
          serving_tier: true,
          business_id: true,
          is_active: true,
        },
      });

      // Group serves_2 siblings by family_id
      const serves2ByFamily = new Map<
        string,
        Array<{
          id: string;
          name: string;
          family_id: string | null;
          serving_tier: string;
          business_id: string | null;
          is_active: boolean;
        }>
      >();

      for (const b of serves2Bundles) {
        if (!isCanonicalServes2Tier(b.serving_tier)) continue;
        if (!b.family_id) continue;
        if (b.business_id !== businessId) continue;
        const list = serves2ByFamily.get(b.family_id) ?? [];
        list.push(b);
        serves2ByFamily.set(b.family_id, list);
      }

      // Validate every submitted family has exactly one active serves_2 sibling
      interface FamilyPair {
        familyId: string;
        serves5Id: string;
        serves2Id: string;
      }

      const validatedPairs: FamilyPair[] = [];

      for (const fid of familyIds) {
        const serves5Bundle = candidateFamilyMap.get(fid);
        if (!serves5Bundle) {
          // Already checked above but be defensive inside the transaction
          return NextResponse.json(
            { error: 'One or more selected families are unavailable' },
            { status: 400 }
          );
        }

        // Verify serves_5 is still active
        if (!serves5Bundle.is_active) {
          return NextResponse.json(
            { error: 'One or more selected families are unavailable' },
            { status: 400 }
          );
        }

        const siblings = serves2ByFamily.get(fid) ?? [];

        if (siblings.length === 0) {
          return NextResponse.json(
            { error: 'One or more selected families are unavailable' },
            { status: 400 }
          );
        }

        if (siblings.length > 1) {
          // Ambiguous family structure
          return NextResponse.json(
            { error: 'One or more selected families are unavailable' },
            { status: 400 }
          );
        }

        const serves2Bundle = siblings[0];

        // Cross-tenant guard (belt and suspenders — query already filters by businessId)
        if (serves2Bundle.business_id !== businessId) {
          return NextResponse.json(
            { error: 'One or more selected families are unavailable' },
            { status: 400 }
          );
        }

        validatedPairs.push({
          familyId: fid,
          serves5Id: serves5Bundle.id,
          serves2Id: serves2Bundle.id,
        });
      }

      // ── Step 11: Delete stale active rows (defensive cleanup only) ─────────
      // Candidate rows are NOT deleted — they must remain preserved.

      await tx.campaignBundle.deleteMany({
        where: {
          campaign_id: campaignId,
          state: 'active',
        },
      });

      // ── Step 13: Insert two active CampaignBundle rows per family ──────────
      // Deterministic positions based on submitted family order:
      //   family[0] → serves_5 pos=0, serves_2 pos=1
      //   family[1] → serves_5 pos=2, serves_2 pos=3

      const activatedBundleIds: string[] = [];

      for (let i = 0; i < validatedPairs.length; i++) {
        const pair = validatedPairs[i];
        const basePosition = i * 2;

        await tx.campaignBundle.create({
          data: {
            campaign_id: campaignId,
            bundle_id: pair.serves5Id,
            state: 'active',
            position: basePosition,
          },
        });

        await tx.campaignBundle.create({
          data: {
            campaign_id: campaignId,
            bundle_id: pair.serves2Id,
            state: 'active',
            position: basePosition + 1,
          },
        });

        activatedBundleIds.push(pair.serves5Id, pair.serves2Id);
      }

      // ── Step 14: Update campaign status and timestamp ─────────────────────

      const now = new Date();

      await tx.fundraiserCampaign.update({
        where: { id: campaignId },
        data: {
          bundle_selection_status: 'selected',
          bundle_selection_at: now,
          // FR-FLOW-3: the coordinator's logistics, written in the SAME
          // transaction as the activation. Setup is one decision — a campaign
          // must never go live carrying half of it. Only these five keys are
          // spread; delivery_date, end_date, org_share_percent and
          // bundle_selection_limit are tenant authority and are not present in
          // `setupValues` at all, so no request body can reach them.
          ...(setupValues ?? {}),
        },
      });

      // ── Step 15: Write CoordinatorActionEvent ─────────────────────────────

      await tx.coordinatorActionEvent.create({
        data: {
          campaign_id: campaignId,
          action_type: 'bundles_selected',
          source: null,
          metadata: {
            actorType: 'coordinator',
            actorId: null,
            channel: 'coordinator_portal',
            selectedFamilyIds: familyIds,
            activatedBundleIds,
            selectionLimit,
            selectedAt: now.toISOString(),
          },
        },
      });

      // ── Step 16: Return the activated selection ───────────────────────────

      return NextResponse.json({
        status: 'selected',
        alreadySelected: false,
        campaign: {
          id: freshCampaign.id,
          name: freshCampaign.name,
          selectionStatus: 'selected',
          selectionLimit,
          selectedAt: now.toISOString(),
        },
        selectedFamilyIds: familyIds,
        activatedBundleIds,
      });
    },
    {
      // ── FR-FLOW-3: READ COMMITTED, deliberately, and not a downgrade ────────
      //
      // CB-2 chose Serializable to stop two coordinator submissions interleaving.
      // The advisory lock taken as this transaction's first statement now does
      // that job directly and strictly: no two selection mutations for one
      // campaign can overlap at all, whatever isolation level either is using.
      //
      // Serializable actively BREAKS the first-order check. A SERIALIZABLE
      // transaction takes its snapshot at its first query — which is the lock
      // acquisition, evaluated BEFORE it blocks. So a reselection that waits for
      // a supporter order to commit then counts orders against a snapshot from
      // before that order existed, sees zero, and proceeds to replace the bundles
      // the order was just placed against. Postgres does not catch it either: SSI
      // only arbitrates between transactions that are ALL serializable, and the
      // public order path runs at READ COMMITTED.
      //
      // Under READ COMMITTED each statement takes a fresh snapshot, so the count
      // after the lock reflects everything committed before it. This was found by
      // tests/frFlow3Concurrency.test.ts, which reproduced both transactions
      // committing against real PostgreSQL.
      isolationLevel: 'ReadCommitted',
      // Timeout: 15 s — generous for a coordinated activation write, defensive ceiling
      timeout: 15000,
    }
  );
}
