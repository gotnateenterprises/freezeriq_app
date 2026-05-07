/**
 * Drift Alerting Service — Real-time anomaly detection for the calculation engine.
 *
 * PURPOSE:
 *   Detects, logs, deduplicates, and dispatches alerts when the production
 *   calculation pipeline exhibits abnormal behavior at runtime.
 *
 * CALCULATION CONSTITUTION COMPLIANCE:
 *   LAW 5 — Reconciliation failures trigger alerts
 *   LAW 7 — Full trace context included in every alert payload
 *   LAW 8 — Critical drift can optionally halt the pipeline
 *
 * DESIGN PRINCIPLES:
 *   1. NEVER blocks normal engine operation unless explicitly configured
 *   2. Fire-and-forget transports (webhook/email) — no await on the hot path
 *   3. Rate-limited: same alert type suppressed for 5 minutes
 *   4. Structured JSON logging for every alert (always-on baseline)
 *   5. Zero schema changes, zero new env vars required
 *
 * TRANSPORT PRIORITY:
 *   Console (always) → Webhook (if DRIFT_ALERT_WEBHOOK_URL set) → Email (if configured)
 *
 * @module drift_alert
 */

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

export type DriftSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export type DriftType =
    | 'EMPTY_INGREDIENTS'
    | 'INVALID_QUANTITY'
    | 'MISSING_MULTIPLIER'
    | 'UNIT_CONVERSION_FAILURE'
    | 'RECONCILIATION_WARNING'
    | 'QUANTITY_ANOMALY'
    | 'ZERO_MULTIPLIER';

export interface DriftAlert {
    /** Alert classification */
    type: DriftType;
    /** Severity level */
    severity: DriftSeverity;
    /** Human-readable description */
    message: string;
    /** Structured context for debugging */
    context: {
        bundle_ids?: string[];
        ingredient_ids?: string[];
        ingredient_names?: string[];
        expected?: number | string;
        actual?: number | string;
        multiplier_values?: Record<string, number>;
        order_count?: number;
        ingredient_count?: number;
        [key: string]: unknown;
    };
    /** Full calculation trace (included when debug=true) */
    trace?: unknown[];
}

export interface DriftAlertPayload extends DriftAlert {
    /** ISO 8601 timestamp */
    timestamp: string;
    /** Unique alert instance ID */
    alert_id: string;
    /** System identifier */
    source: 'freezeriq_kitchen_engine';
    /** Environment hint */
    environment: string;
}

/** Configuration for drift alerting behavior */
export interface DriftAlertConfig {
    /** Webhook URL for external dispatch (Slack, Discord, Zapier, etc.) */
    webhookUrl?: string;
    /** Email recipient for critical alerts */
    emailTo?: string;
    /** If true, CRITICAL alerts throw instead of just logging */
    failOnCritical?: boolean;
    /** Rate limit window in ms (default: 5 minutes) */
    rateLimitWindowMs?: number;
    /** If true, include full trace in dispatched payloads */
    includeTrace?: boolean;
}

// ═══════════════════════════════════════════════════════════
// RATE LIMITER
// ═══════════════════════════════════════════════════════════

/** Tracks last dispatch time per alert type to prevent spam */
const _alertTimestamps: Map<string, number> = new Map();

/** Default rate limit: 5 minutes */
const DEFAULT_RATE_LIMIT_MS = 5 * 60 * 1000;

/**
 * Generates a deduplication key from alert type + severity.
 * Same type+severity within the window gets suppressed.
 */
function getDedupKey(alert: DriftAlert): string {
    return `${alert.type}:${alert.severity}`;
}

/**
 * Returns true if this alert should be suppressed (duplicate within window).
 */
function isRateLimited(alert: DriftAlert, windowMs: number): boolean {
    const key = getDedupKey(alert);
    const lastSent = _alertTimestamps.get(key);
    const now = Date.now();

    if (lastSent && (now - lastSent) < windowMs) {
        return true; // Suppress — too recent
    }

    _alertTimestamps.set(key, now);
    return false;
}

/**
 * Clears rate limit state. Useful for testing.
 * @internal
 */
export function _resetRateLimiter(): void {
    _alertTimestamps.clear();
}

// ═══════════════════════════════════════════════════════════
// ALERT COLLECTOR (batch pattern for engine integration)
// ═══════════════════════════════════════════════════════════

/**
 * Accumulates alerts during a single generateProductionRun() call.
 * Flushed once at the end — prevents interleaved dispatch during calculation.
 */
export class DriftAlertCollector {
    private alerts: DriftAlert[] = [];

    /** Add an alert to the batch */
    add(alert: DriftAlert): void {
        this.alerts.push(alert);
    }

    /** Returns all collected alerts */
    getAlerts(): readonly DriftAlert[] {
        return this.alerts;
    }

    /** Returns count of alerts at or above the given severity */
    countBySeverity(severity: DriftSeverity): number {
        const levels: Record<DriftSeverity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
        const threshold = levels[severity];
        return this.alerts.filter(a => levels[a.severity] >= threshold).length;
    }

    /** True if any CRITICAL alerts were collected */
    hasCritical(): boolean {
        return this.alerts.some(a => a.severity === 'CRITICAL');
    }

    /** True if collector has any alerts */
    hasAlerts(): boolean {
        return this.alerts.length > 0;
    }

    /** Clear all collected alerts */
    clear(): void {
        this.alerts = [];
    }
}

// ═══════════════════════════════════════════════════════════
// PAYLOAD BUILDER
// ═══════════════════════════════════════════════════════════

let _alertCounter = 0;

function buildPayload(alert: DriftAlert): DriftAlertPayload {
    _alertCounter++;
    return {
        ...alert,
        timestamp: new Date().toISOString(),
        alert_id: `drift_${Date.now()}_${_alertCounter}`,
        source: 'freezeriq_kitchen_engine',
        environment: process.env.NODE_ENV || 'development',
    };
}

// ═══════════════════════════════════════════════════════════
// TRANSPORTS
// ═══════════════════════════════════════════════════════════

/**
 * Transport 1: Structured console logging (ALWAYS active).
 * Outputs a single JSON line per alert for log aggregation.
 */
function logToConsole(payload: DriftAlertPayload): void {
    const logLine = JSON.stringify({
        level: payload.severity,
        type: payload.type,
        message: payload.message,
        alert_id: payload.alert_id,
        timestamp: payload.timestamp,
        source: payload.source,
        context: payload.context,
        // Trace excluded from console to avoid log bloat — included in webhook/email
    });

    switch (payload.severity) {
        case 'CRITICAL':
            console.error(`[DRIFT ALERT][CRITICAL] ${logLine}`);
            break;
        case 'WARNING':
            console.warn(`[DRIFT ALERT][WARNING] ${logLine}`);
            break;
        default:
            console.info(`[DRIFT ALERT][INFO] ${logLine}`);
    }
}

/**
 * Transport 2: Webhook dispatch (fire-and-forget).
 * Sends full payload as POST JSON to configured URL.
 * Failures are caught and logged — never blocks the engine.
 */
async function sendWebhook(payload: DriftAlertPayload, url: string): Promise<void> {
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000), // 5s timeout — never hang
        });
    } catch (err: any) {
        // Transport failure must never crash the engine
        console.error(`[DRIFT ALERT] Webhook dispatch failed: ${err.message}`);
    }
}

/**
 * Transport 3: Email dispatch via Resend (fire-and-forget).
 * Only for CRITICAL/WARNING severity. Uses dynamic import to avoid
 * hard dependency if Resend is not configured.
 */
async function sendEmail(payload: DriftAlertPayload, to: string): Promise<void> {
    try {
        const apiKey = process.env.RESEND_API_KEY;
        if (!apiKey) {
            console.warn('[DRIFT ALERT] Email transport skipped: RESEND_API_KEY not set');
            return;
        }

        const { Resend } = await import('resend');
        const resend = new Resend(apiKey);

        const severityEmoji = payload.severity === 'CRITICAL' ? '🚨' : '⚠️';
        const subject = `${severityEmoji} FreezerIQ Drift Alert: ${payload.type}`;

        await resend.emails.send({
            from: 'FreezerIQ Alerts <alerts@freezeriq.com>',
            to,
            subject,
            html: `
                <h2>${severityEmoji} Calculation Drift Detected</h2>
                <table style="border-collapse:collapse;font-family:monospace;font-size:13px;">
                    <tr><td style="padding:4px 12px;font-weight:bold;">Type</td><td>${payload.type}</td></tr>
                    <tr><td style="padding:4px 12px;font-weight:bold;">Severity</td><td>${payload.severity}</td></tr>
                    <tr><td style="padding:4px 12px;font-weight:bold;">Time</td><td>${payload.timestamp}</td></tr>
                    <tr><td style="padding:4px 12px;font-weight:bold;">Alert ID</td><td>${payload.alert_id}</td></tr>
                    <tr><td style="padding:4px 12px;font-weight:bold;">Environment</td><td>${payload.environment}</td></tr>
                </table>
                <h3>Message</h3>
                <p style="font-family:monospace;background:#f5f5f5;padding:12px;border-radius:4px;">${payload.message}</p>
                <h3>Context</h3>
                <pre style="background:#f5f5f5;padding:12px;border-radius:4px;overflow-x:auto;">${JSON.stringify(payload.context, null, 2)}</pre>
                ${payload.trace ? `<h3>Trace (${(payload.trace as any[]).length} entries)</h3><pre style="background:#f5f5f5;padding:12px;border-radius:4px;overflow-x:auto;max-height:400px;">${JSON.stringify(payload.trace, null, 2)}</pre>` : ''}
            `,
        });
    } catch (err: any) {
        // Transport failure must never crash the engine
        console.error(`[DRIFT ALERT] Email dispatch failed: ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════════════
// MAIN DISPATCH FUNCTION
// ═══════════════════════════════════════════════════════════

/**
 * Dispatches a single drift alert through all configured transports.
 *
 * Rate-limited: same type+severity suppressed within the configured window.
 * Console logging always fires. Webhook and email are fire-and-forget.
 *
 * @returns The built payload (useful for testing/inspection)
 */
export function triggerDriftAlert(
    alert: DriftAlert,
    config: DriftAlertConfig = {}
): DriftAlertPayload | null {
    const windowMs = config.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_MS;

    // Rate limit check (CRITICAL alerts are never suppressed)
    if (alert.severity !== 'CRITICAL' && isRateLimited(alert, windowMs)) {
        return null; // Suppressed
    }

    // Strip trace if not configured to include it
    const alertWithTrace = config.includeTrace
        ? alert
        : { ...alert, trace: undefined };

    const payload = buildPayload(alertWithTrace);

    // Transport 1: Console (always)
    logToConsole(payload);

    // Transport 2: Webhook (if configured)
    const webhookUrl = config.webhookUrl || process.env.DRIFT_ALERT_WEBHOOK_URL;
    if (webhookUrl) {
        // Fire-and-forget — do NOT await on the hot path
        sendWebhook(payload, webhookUrl).catch(() => { /* already logged internally */ });
    }

    // Transport 3: Email (CRITICAL/WARNING only, if configured)
    const emailTo = config.emailTo || process.env.DRIFT_ALERT_EMAIL_TO;
    if (emailTo && (alert.severity === 'CRITICAL' || alert.severity === 'WARNING')) {
        sendEmail(payload, emailTo).catch(() => { /* already logged internally */ });
    }

    return payload;
}

// ═══════════════════════════════════════════════════════════
// BATCH FLUSH — used by KitchenEngine
// ═══════════════════════════════════════════════════════════

/**
 * Flushes all collected alerts through the dispatch pipeline.
 * Called once at the end of generateProductionRun().
 *
 * @returns Array of dispatched payloads (null entries = suppressed)
 */
export function flushDriftAlerts(
    collector: DriftAlertCollector,
    config: DriftAlertConfig = {}
): DriftAlertPayload[] {
    const payloads: DriftAlertPayload[] = [];

    for (const alert of collector.getAlerts()) {
        const result = triggerDriftAlert(alert, config);
        if (result) {
            payloads.push(result);
        }
    }

    collector.clear();
    return payloads;
}

// ═══════════════════════════════════════════════════════════
// ALERT FACTORY HELPERS
// ═══════════════════════════════════════════════════════════

/** Orders exist but no ingredients were produced */
export function alertEmptyIngredients(
    orderCount: number,
    bundleIds: string[],
    trace?: unknown[]
): DriftAlert {
    return {
        type: 'EMPTY_INGREDIENTS',
        severity: 'CRITICAL',
        message:
            `${orderCount} order(s) produced 0 ingredients. ` +
            `Bundles: ${bundleIds.join(', ')}. ` +
            `Possible causes: empty bundles, missing recipes, or corrupt data.`,
        context: {
            order_count: orderCount,
            bundle_ids: bundleIds,
            ingredient_count: 0,
        },
        trace,
    };
}

/** Ingredient has NaN, Infinity, or negative quantity */
export function alertInvalidQuantity(
    ingredientName: string,
    ingredientId: string,
    qty: number,
    trace?: unknown[]
): DriftAlert {
    return {
        type: 'INVALID_QUANTITY',
        severity: 'CRITICAL',
        message:
            `Ingredient "${ingredientName}" (${ingredientId}) has invalid quantity: ${qty}. ` +
            `This indicates a broken multiplier chain or corrupt recipe data.`,
        context: {
            ingredient_ids: [ingredientId],
            ingredient_names: [ingredientName],
            actual: qty,
            expected: 'positive finite number',
        },
        trace,
    };
}

/** Serving multiplier is undefined, zero, or invalid */
export function alertMissingMultiplier(
    variantSize: string,
    bundleId: string,
    trace?: unknown[]
): DriftAlert {
    return {
        type: 'MISSING_MULTIPLIER',
        severity: 'CRITICAL',
        message:
            `Serving multiplier for variant "${variantSize}" on bundle "${bundleId}" ` +
            `resolved to an invalid value. Multiplier chain is broken.`,
        context: {
            bundle_ids: [bundleId],
            multiplier_values: { [variantSize]: 0 },
        },
        trace,
    };
}

/** Unit conversion failed for an ingredient */
export function alertUnitConversionFailure(
    ingredientName: string,
    fromUnit: string,
    toUnit: string,
    errorMessage: string,
    trace?: unknown[]
): DriftAlert {
    return {
        type: 'UNIT_CONVERSION_FAILURE',
        severity: 'WARNING',
        message:
            `Unit conversion failed for "${ingredientName}": ${fromUnit} → ${toUnit}. ` +
            `Error: ${errorMessage}`,
        context: {
            ingredient_names: [ingredientName],
            expected: `${fromUnit} → ${toUnit}`,
            actual: 'conversion impossible',
        },
        trace,
    };
}

/** Bundles had no trace entries (not processed) */
export function alertReconciliationWarning(
    unprocessedBundleIds: string[],
    totalOrders: number,
    trace?: unknown[]
): DriftAlert {
    return {
        type: 'RECONCILIATION_WARNING',
        severity: 'WARNING',
        message:
            `${unprocessedBundleIds.length} of ${totalOrders} order(s) had no trace entries. ` +
            `Bundle IDs: ${unprocessedBundleIds.join(', ')}. ` +
            `These orders may not have been included in the production manifest.`,
        context: {
            bundle_ids: unprocessedBundleIds,
            order_count: totalOrders,
        },
        trace,
    };
}

/** Zero-quantity multiplier detected in trace */
export function alertZeroMultiplier(
    bundleId: string,
    recipeId: string,
    finalMultiplier: number,
    trace?: unknown[]
): DriftAlert {
    return {
        type: 'ZERO_MULTIPLIER',
        severity: 'WARNING',
        message:
            `Zero effective multiplier detected for bundle "${bundleId}", ` +
            `recipe "${recipeId}". Final multiplier: ${finalMultiplier}. ` +
            `This will produce zero ingredient quantities.`,
        context: {
            bundle_ids: [bundleId],
            multiplier_values: { final: finalMultiplier },
        },
        trace,
    };
}
