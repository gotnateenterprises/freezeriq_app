# FreezerIQ — QuickBooks Online Integration

**Status:** QB-INVOICE-1A **ACCEPTED / CLOSED** by the owner on September 13, 2026, after a successful live Intuit sandbox proof (§4). Sandbox OAuth foundation only: no QuickBooks customers, invoices or payment sync, and Production stayed disabled at that stage.
**QB-INVOICE-1B:** customer mapping + invoice-link schema foundation, with the owner's acceptance fix (one QuickBooks invoice link per invoice for life; retained connection generations) — owner Intuit sandbox acceptance PASSED on September 14, 2026 (§11.8); on the isolated branch `worktree-qb-invoice-1b`, not merged and not deployed, and its migration is not applied to Production or Preview; see §11. It creates and sends no QuickBooks invoice.
**QB-INVOICE-1C:** "Send via QuickBooks" — tenant invoice settings and a verified create → recipients → payment options → send lifecycle — implemented on the isolated branch `qb-invoice-1c`, uncommitted, awaiting owner review and Intuit sandbox acceptance; see §12. No payments, webhooks or PAID behaviour (QB-INVOICE-1D).
**QB-INVOICE-1D:** "Check QuickBooks payment" — on an admin's explicit click, FreezerIQ reads a sent invoice's QuickBooks payment and settles it through the shared settlement transition only when QuickBooks proves ONE exact full payment — owner-approved on September 21, 2026 and committed on the isolated branch `qb-invoice-1d` (from `4767422`), pushed for a Preview only, awaiting the owner's browser acceptance; not released to Production. Engineering acceptance against the Intuit sandbox passed on September 21, 2026. Code only: no migration, no new scope, no QuickBooks write, no webhook or polling; see §13.
**Production (owner-reported, September 21, 2026):** QuickBooks is enabled (`QBO_PRODUCTION_ENABLED=true`) and Freezer Chef is connected to its real QuickBooks company; its invoice settings are Ready, with card and ACH payments enabled. No FreezerIQ-created fundraiser invoice has been sent through QuickBooks yet. Preview is always disabled (§2).
**Scope of this document:** the connector's architecture and safety properties, the environment rules, the evidence behind them, and the compliance and readiness work recorded on the way to Intuit production credentials.

This is an engineering record, not a legal opinion. Nothing here claims compliance with Intuit's terms beyond the technical evidence listed. Items marked **OWNER** or **COUNSEL** need a human decision.

Platform: **FreezerIQ** (owner of the Intuit developer app). First real tenant: **Freezer Chef**.

---

## 1. What exists after QB-INVOICE-1A

| Surface | Path | Who |
|---|---|---|
| Begin OAuth | `GET /api/integrations/quickbooks/connect` | tenant ADMIN |
| OAuth callback | `GET /api/integrations/quickbooks/callback` | tenant ADMIN (same browser, same session) |
| Disconnect / forget | `POST /api/integrations/quickbooks/disconnect` `{action:'disconnect'|'forget'}` | tenant ADMIN |
| Truthful status (live CompanyInfo) | `GET /api/integrations/quickbooks/status` | tenant ADMIN |
| Settings card | `components/settings/QuickBooksConnectionCard.tsx` | rendered for ADMIN only |

Library: `lib/quickbooks/config.ts` (environment guard), `access.ts` (role gate), `intuitClient.ts` (the only code that calls Intuit), `connection.ts` (storage, refresh, disconnect, health), `oauthAttempt.ts` (single-use connect attempts), `statusView.ts` (card wording); `lib/integrationTokenCrypto.ts` (encryption at rest).

Rows in `integrations` (no migration): `provider='quickbooks'` — the tenant's connection; `provider='quickbooks_oauth_attempt'` — the tenant's one open connect attempt (a SHA-256 digest of its nonce and an expiry; deleted when completed).

**Deliberately absent in 1A** (customer mapping and the invoice-link schema arrive in QB-INVOICE-1B, §11): customer mapping, QuickBooks customer or invoice creation, invoice schema linkage, Send via QuickBooks, payment flags, tax read-back, Record Payment `quickbooks`, webhooks, reconciliation, food release. A QuickBooks connection never releases fundraiser food (Fundraiser Fulfillment Contract HARD RULE 1, §14 amendment).

### Retired legacy code

- `lib/ingestion/qbo_poller.ts` — imported the newest QuickBooks invoices (unpaid ones included) as `production_ready` Orders on every Sync Orders click. Removed from `/api/sync/orders`; the file is deleted.
- `/api/auth/qbo` and `/api/auth/qbo/callback` — fixed state `intuit-test`, hardcoded callback, plaintext tokens. Now 410 stubs; the files stay because `app/api/auth/[...nextauth]` would otherwise serve those paths.
- **Committing the quarantine:** the three deleted route files must be removed in the same commit (`git rm`) that adds `app/api/integrations/quickbooks/` and the `tests/secPublicRoute1Sweep.test.ts` allowlist edit. The sweep reads `git ls-files`, so a commit that stages the new routes but not the deletions makes it fail — never "fix" that by restoring the dead routes or their allowlist keys.
- `/api/integrations/auth/qbo/{login,callback}`, `/api/integrations/sync/qbo`, `lib/qbo.ts`, `lib/ingestion/clients/qbo_client.ts`, QBO types and mocks, `simulate_qbo.bat`, `test_qbo_import.js` — deleted.
- npm `intuit-oauth` and `node-quickbooks` (which pinned deprecated `request@2.88.0`) — uninstalled. `date-fns`, previously present only as a node-quickbooks transitive dependency, is now declared directly because three app files import it.
- Gitignored local scripts `scripts/generate_qbo_url.ts`, `scripts/simulate_qbo_invoice.ts` and `scripts/verify_connectors.ts` still reference the removed packages. They are untracked and were left in place; they fail if run.

---

## 2. Environment rules (why Preview can never connect)

Vercel Preview deployments share the **Production database**. The connector therefore decides where it may run from the deployment, before reading any credential:

| Deployment | Result |
|---|---|
| Local dev (`NODE_ENV=development`, no `VERCEL_ENV`) | enabled only with `QBO_ENVIRONMENT=sandbox`, a localhost `QBO_REDIRECT_URI`, and a non-Production database |
| Vercel Preview (`VERCEL_ENV=preview`) | **always disabled** |
| Vercel Production (`VERCEL_ENV=production`) | disabled unless `QBO_PRODUCTION_ENABLED=true` **and** `QBO_ENVIRONMENT=production` and the redirect is `https://www.freezeriqapp.com/api/integrations/quickbooks/callback` |
| Anything else (e.g. `next start` without Vercel) | disabled |

Mismatches (sandbox keys on Production, production keys locally) disable the connector. The callback URL comes from `QBO_REDIRECT_URI`, validated for exact path and host; it is never derived from the request's Host header. Variables are documented in `docs/ai/ENVIRONMENT.md`. **Never add `QBO_*` to the Vercel Preview environment.**

---

## 3. Security properties and their evidence

| Property | Mechanism | Test evidence |
|---|---|---|
| Only a tenant ADMIN, acting as themselves, may connect/disconnect/inspect | `mayManageQuickBooks`: `role === 'ADMIN'`, not View As | `qbInvoice1aFoundation`, `qbInvoice1aRoutes` (401/403, CHEF/DRIVER, view-as) |
| Least privilege | authorize URL carries exactly `scope=com.intuit.quickbooks.accounting` and five parameters | foundation + routes tests parse the generated URL |
| CSRF / replay / single use (callback) | HMAC-signed state (provider, tenant, user, nonce, 10-min exp) + nonce in an attempt cookie (below) + the attempt recorded server-side and consumed by a conditional delete as soon as a callback proves it, so it completes exactly once on any server, and a denial or malformed callback also ends it; a new connect supersedes the old attempt | the callback failure/replay matrix in `qbInvoice1aAcceptance` plus `qbInvoice1aRoutes` (superseded, doubled redirect, two instances); mutation-tested |
| CSRF (disconnect / forget) | two independent locks: the FreezerIQ session cookie is SameSite=Lax (Auth.js default, not overridden), so a cross-site POST carries no session; and the route accepts only `Content-Type: application/json`, which a cross-origin page can send only after a CORS preflight that nothing in the app approves (no `Access-Control-Allow-*` anywhere; middleware does not run on `/api`; verified live 2026-09-13: Next.js answers the preflight with `204` and `Allow: OPTIONS, POST` but no `Access-Control-Allow-Origin`, so a browser never sends the POST) | `qbInvoice1aAcceptance` Part 4 |
| Tenant from verified state, never from the query | callback ignores tenant-like query params | "query parameters cannot name the tenant" test |
| Encrypted at rest | AES-256-GCM, HKDF key from `INTEGRATION_TOKEN_KEY`, AAD bound to provider + tenant + column; access token, refresh token and realm id all sealed; reads also try keys in `INTEGRATION_TOKEN_KEY_PREVIOUS` (see "Encryption-key rotation" — rotation is an operational procedure, not automatic) | ciphertext moved between tenants/columns fails; no plaintext in rows; the key-rotation block in `qbInvoice1aAcceptance` |
| No secrets in application logs, errors or redirects | log lines and errors carry a reason code, HTTP status and `intuit_tid` only; the redirect carries only an outcome code | console captured across all flows; Intuit error bodies never surface. **Caveat:** the inbound callback URL (single-use `code`, signed `state`, `realmId`) is recorded by Vercel's request logs and the local dev server's request log. The code is spent within seconds and the state is useless without the admin's session and cookie, but the realmId is customer-identifying — note this for the App Assessment security answers |
| Realm binding | the realmId on the redirect is **verified with a read-only CompanyInfo call using the new tokens** before anything is stored (an altered realmId → `realm_unverified`); a different company is refused (`realm_mismatch`); a company live for another tenant is refused (`realm_in_use`), checked and written under a Postgres advisory lock per company so two tenants cannot both win; an expired other-tenant row does not hold a company; switching companies requires disconnect + forget | connection and route tests, including a forged realm and a two-tenant race; mutation-tested |
| Refresh rotation safe under concurrency | DB lease via compare-and-swap on the sealed refresh envelope + in-process single flight; waiters use a still-valid stored token or wait for the holder; the commit survives a transient DB error; a lost commit is reconciled (a takeover refused because of the holder's rotation is healed with the holder's token) and never overwrites a newer token | 25 concurrent requests and 4 isolated module instances → exactly one Intuit refresh; both lease-takeover interleavings, forced deterministically with gates; commit failure before/after landing; disconnect during refresh; mutation-tested |
| Disconnect stops access | revoke at Intuit (best effort) + tombstone; all later access refused | disconnect tests, including revoke failure |
| Truthful status | "connected" only after a live read-only CompanyInfo call for the stored realm; HTTP 200 Fault is not success | health tests |

**Refresh facts relied on (Intuit OAuth docs/FAQ, verified 2026-09-13):** access tokens last 60 minutes; a refresh within about 24 hours usually returns the same refresh-token value, and once a different value is returned the previous one is dead (no grace period is documented); refreshing twice with the same token returns `invalid_grant` and may invalidate it; tokens expire after 100 days unused and at a 5-year hard limit (reported only when the `x-include-refresh-token-hard-expires-in: true` header is sent, which the connector does). On an API 401 the connector refreshes once and retries once; it never loops.

**Revocation caution (from Intuit's documented behaviour):** revoking any token removes FreezerIQ's access to that QuickBooks **company**. The connector therefore revokes in exactly one place: an admin's disconnect of the token currently stored for that tenant. It **never** revokes a grant it refuses to store, and never revokes a refresh result it does not store — including a refresh that completes after an admin disconnect or a Forget (that late token is discarded and expires unused; revoking it could cut off another tenant that connected the same company in the meantime).

**Refused or abandoned grants — known V1 limitation.** Safe selective revocation cannot be proven for any rejected case, so none is revoked:

| Case | Grant at Intuit? | Why revoking is not provably safe |
|---|---|---|
| User cancels (`access_denied`) | none — no code is exchanged | nothing to revoke |
| `realm_in_use` — company live for another tenant | yes | revocation would disconnect that tenant |
| `realm_mismatch` — tenant bound to a different company | yes | no *readable* FreezerIQ row holds that company live at the instant of the check — but unreadable rows cannot be compared, and a grant another tenant has already exchanged but not yet brought to the lock is invisible, so even a revoke inside the lock is not provably safe; in Development the same app is also shared with local tooling (the MCP server via `localhost:8000`) |
| `realm_unverified` — tokens do not reach the named company | yes | the tokens' real company is unknown and may be another tenant's |
| `verification_failed` — QuickBooks unreachable | yes | the company could not be confirmed |
| `reconnect_blocked` — existing row unreadable | yes | the stored company is unknown and may be the same one |
| `conflict` — a concurrent write for this tenant won | yes | that write may have stored a grant for the same company |
| exchange succeeded, database write failed | yes | the company was never bound; same uncertainty |
| a refresh finished after an admin disconnect or Forget | yes (the late refreshed token) | another tenant may have connected that company after the disconnect |

Consequence: QuickBooks may continue to list FreezerIQ under that company's connected apps. FreezerIQ stores nothing from the refused grant, so nothing can use it, and Intuit expires an unused refresh token after its rolling window (about 100 days). The company's admin can remove FreezerIQ there at any time. Security and tenant isolation take priority over this cleanup.

**V1 realm rule (owner ruling, September 13, 2026 — locked for V1, enforced):** one FreezerIQ tenant has at most one QuickBooks company connection (one `integrations` row, primary key `(business_id, provider)`). Switching companies is explicit: disconnect → Forget company → connect. A different company is refused while connected (`realm_mismatch`), after a disconnect, and after Intuit revocation or expiry, until Forget; Forget is refused while connected. Reconnecting the **same** company is allowed unless the stored row cannot be read (`reconnect_blocked` — the card then offers only Forget, and Connect refuses before sending the admin to Intuit) or that company has since become live for another tenant (`realm_in_use`). The same ruling locks the reverse direction: one QuickBooks Online company may be actively connected to only one FreezerIQ tenant at a time (`realm_in_use`). Shared QuickBooks companies across tenants are not supported in V1 and are not to be designed for.

**OAuth attempt cookie (`quickbooks_oauth_nonce`):**

| Attribute | Value | Why |
|---|---|---|
| HttpOnly | always | scripts cannot read or plant it |
| Secure | when the configured redirect URI is https — always in Production (the Production redirect must be https); off for `http://localhost` development, where a Secure cookie could not be stored | |
| SameSite | Lax | Intuit returns the browser with a cross-site top-level GET; a Strict cookie would not be sent and every callback would fail |
| Path | `/api/integrations/quickbooks/callback` | sent only to the callback |
| Max-Age | 600 seconds | equals the state's expiry and the server-side attempt's expiry |
| Cleared | Max-Age=0 with the same attributes exactly when the attempt stops being usable: the callback spent it (any outcome after the state, session and cookie matched) or proved it already used, superseded or expired | a request that cannot prove the attempt — no session, another browser, a stray or hostile navigation, a bad state — leaves the cookie alone so it cannot break the admin's real callback |

Not setting the cookie on Preview: connect is refused before any cookie or attempt exists.

**Encryption-key rotation (operational procedure, V1):** the code reads with the current key and then each key in `INTEGRATION_TOKEN_KEY_PREVIOUS`, and writes with the current key. Nothing re-encrypts stored rows by itself.
1. Deploy `INTEGRATION_TOKEN_KEY=<new>` **together with** `INTEGRATION_TOKEN_KEY_PREVIOUS=<old>`. Replacing the key without the previous entry makes every stored connection unreadable at once ("reconnect required"; each tenant must Forget and reconnect).
2. A row moves to the new key only when the connector rewrites its access_token column: connect or reconnect, a successful refresh (including lost-commit reconciliation), and any tombstone written while the key set is in place — an admin disconnect, or a refresh that Intuit refuses (revoked / refresh_lost) or that finds the refresh token expired. The refresh lease claim and a failed-refresh release write refresh_token only: a transient failure restores the original ciphertext, an ambiguous one (timeout, lost response) re-seals just that column, leaving a mixed row. Idle connections, transient refresh failures and rows already disconnected before the rotation still need the old key.
3. The ciphertext has no key identifier, so confirm with a read-only check that every `provider='quickbooks'` row opens with the new key alone — or have those tenants reconnect (or Forget old disconnected rows) — **before** removing `INTEGRATION_TOKEN_KEY_PREVIOUS`.
4. Only then remove the old key.
5. **Never roll back or re-promote a deployment created before the key change** while rows may be under the new key: that build knows only the old key, shows those rows as "reconnection required", invites a Forget that deletes a connection which would work again after rolling forward, and cannot see them in the one-company check. If a rollback is needed, redeploy the older commit with both `INTEGRATION_TOKEN_KEY=<new>` and `INTEGRATION_TOKEN_KEY_PREVIOUS=<old>`, and ask admins not to use Forget until the correct build is serving. The per-company lock key is derived from the current key, so two deployments with different current keys should not serve connects at the same time.

Key format: 32+ characters with no commas or newlines (a key containing either is refused, because it could never be listed in `INTEGRATION_TOKEN_KEY_PREVIOUS`); at most 4 previous keys are read.
Encryption-key rotation is unrelated to Intuit's refresh-token rotation.

**Ambiguous refreshes:** if a refresh reaches Intuit but its response cannot be read (timeout, dropped connection), the connector marks the envelope; if the next refresh is refused, the connection is recorded as `refresh_lost` (our side lost the rotated token) rather than `revoked`. The refresh timeout is 30 seconds, and a response missing `expires_in` keeps its tokens (default 60 minutes) rather than discarding them.

**Residual risks (accepted for V1, documented):**
- A refresh holder that dies after Intuit rotated the token, before storing it, loses that token; the next refresh is refused and the tenant must reconnect. This is inherent to rotating refresh tokens.
- A refresh lease is taken over only if its holder stalls for more than 60 seconds (Intuit calls time out at 30 seconds); if that happens, the reconciliation above restores the holder's token.
- One tenant → at most one company is enforced by the database (primary key). The reverse — a QuickBooks company live for at most one FreezerIQ tenant (`realm_in_use`) — is enforced by the connector under a lock, not by a database constraint (the realm is encrypted, so the database cannot compare it); a unique blind index would need a migration. **Owner ruling (September 13, 2026):** locked for V1 — a QuickBooks company may be actively connected to only one FreezerIQ tenant at a time; the `realm_in_use` protection stays, and shared companies are not supported (this affects, for example, franchise locations or a staging tenant sharing one QuickBooks company).
- `GET /api/integrations/quickbooks/connect` is a link (like the Stripe and Square connect routes), so a page on another site can navigate a signed-in admin's browser to it. That restarts the admin's own connect: it supersedes an attempt that was in progress (that callback then answers `invalid_state`) and shows an Intuit consent screen the admin did not ask for. Nothing is connected unless the admin approves it, it is always bound to the admin's own tenant, and no data is exposed; a stray navigation to the *callback* URL no longer disrupts an attempt at all.
- Health checks make one read-only CompanyInfo call per Settings view. In Production these count toward Intuit's Builder-tier CorePlus allowance (500,000/month).

---

## 4. Local sandbox proof — runbook (owner-performed)

**Result: completed September 13, 2026.** The owner ran the steps below against Intuit's U.S. sandbox; the outcome was then verified read-only from the local database and Production.
- Connect succeeded, and the Settings card showed Connected on the strength of a live read-only CompanyInfo call.
- Disconnect succeeded (the card showed Disconnected with Reconnect / Forget company), and reconnecting the **same** sandbox company succeeded.
- Local database: exactly one `quickbooks` row for the tenant, and no leftover connect attempts. The access token, refresh token and realm id are stored as v1 AES-GCM ciphertext that opens only with the configured key and only for that tenant. No plaintext copy of any of them exists anywhere in the database, no other tenant holds the company, and the stored credentials are the post-reconnect grant. The connector's health check made only CompanyInfo reads and wrote nothing.
- Production was untouched: no QuickBooks state in the Production database, no QuickBooks variables in the Vercel environments, and the Production deployment unchanged. The real Freezer Chef QuickBooks company was **not** connected.
- Owner acceptance of QB-INVOICE-1A: September 13, 2026.

The steps are kept for re-running the proof.

(Acceptance: see `tests/qbInvoice1aAcceptance.test.ts` for the cookie, callback-matrix, CSRF, refused-grant, realm-rule and key-rotation evidence behind §3.)

Nothing below uses real Freezer Chef data or Production credentials.

1. In the Intuit Developer portal (FreezerIQ app → Development → Redirect URIs), **add** `http://localhost:3000/api/integrations/quickbooks/callback`. Keep the OAuth Playground and `http://localhost:8000/callback` entries.
2. In `.env.development.local` (gitignored; never paste values into chat, code or commits) add:
   `QBO_ENVIRONMENT=sandbox`, `QBO_CLIENT_ID=<Development client id>`, `QBO_CLIENT_SECRET=<Development client secret>`, `QBO_REDIRECT_URI=http://localhost:3000/api/integrations/quickbooks/callback`, `INTEGRATION_TOKEN_KEY=<new random value, 32+ characters, no commas or newlines>`.
   `DATABASE_URL` in that file must remain the **local** database (the dev server refuses to start against Production).
3. Start the local dev server, sign in as a local tenant ADMIN, open **Settings → Integrations → QuickBooks Online** (the card shows a "Sandbox" badge).
4. Click **Connect to QuickBooks**, sign in to Intuit, choose the **US sandbox company**, and authorize.
   (The dev server terminal will print the callback request line, including its one-time code, state and sandbox realmId. That is expected for sandbox; don't paste that terminal output anywhere.)
5. Expected: redirect to `/settings?quickbooks=connected`, then the card shows **✓ Connected · <sandbox company name>** — produced by a live read-only CompanyInfo call.
6. Click **Disconnect from QuickBooks** → card shows **Disconnected**. Click **Reconnect to QuickBooks** and authorize the same sandbox company → **Connected** again.
7. A read-only verification script can then show, from the local database without printing any secret, that there is exactly one `quickbooks` row for the tenant, that every sensitive column is `v1.` ciphertext, and that the stored realm decrypts to the realm Intuit returned.

---

## 5. Intuit Developer Terms (As of October 14, 2025) — technical review

Source: https://developer.intuit.com/app/developer/qbo/docs/legal-agreements/intuit-terms-of-service-for-intuit-developer-services. Research verified 2026-09-13. Section numbers are as published.

| Obligation | Section | Status in this phase | Gap / action |
|---|---|---|---|
| Accurate developer/app info; legal entity | §4.1, §4.2, §6.1, §8.3 | — | **OWNER:** enroll under FreezerIQ's legal entity; keep App Details, URLs and policies accurate; notify Intuit of changes to how User Data is stored (§8.3) |
| Credential confidentiality | §4.2, §2.1, §14, Security Requirements | client secret and key only in env; tokens and realm AES-GCM sealed; nothing logged | Store Production secrets as Vercel *sensitive* variables, Production scope only; limit team access |
| Authorized use only | §2.2, §3.1 | reads CompanyInfo only | Never mirror, back up or bulk-extract QuickBooks data |
| User consent + clear disclosure | §12.2 | Intuit's consent screen used unmodified; who connected and when is recorded inside the sealed envelope | **COUNSEL:** privacy policy QuickBooks section (see §6); decide whether a separate written-consent record is required |
| Data minimization | §12.2, §3.1, Security Requirements | only the tokens, realm id, expiry times and the authorizing user id are stored; the company name is displayed, not stored | Keep each future stored field tied to a feature |
| Stop processing on revocation | §12.2 | invalid_grant → tombstone, all access stops; admin disconnect revokes and stops | Handle an Intuit-side disconnect (Disconnect URL page — see §8) |
| Secure deletion on request | §12.2, §21 | "Forget company" deletes the row | **OWNER/COUNSEL:** a deletion procedure covering database backups/point-in-time recovery; no deadline is stated |
| Security safeguards | §13.1, §13.2, Security Requirements | HTTPS, no-store, httpOnly cookies, 302 redirects from the callback, CSRF protection | Write a security and incident policy |
| 24-hour Security Incident notice | §13.4–§13.7 | — | **OWNER:** incident runbook with a 24-hour clock. Report via https://help.developer.intuit.com/s/contactsupport and send formal notice per §20.7 (Intuit Inc., c/o CSC, 251 Little Falls Drive, Wilmington, DE 19808). "Security Incident" includes availability or integrity compromises at service providers (Vercel, Supabase) |
| Auditability / records | §6.1, §6.2, §11.5 | minimal connect/disconnect audit inside the sealed envelope | A general tenant audit log would need a migration; plan it before production. Intuit may test and audit at any time (§6.2). Intuit's publishing page says all apps undergo an annual security review, so plan for one even as a private app |
| Support responsibility | §6.3, §8.6 | — | **OWNER:** public support/contact route (none exists; `/support` and `/contact` return 404) |
| Confidentiality | §14 | — | Keep Intuit review materials and credentials out of public repos and artifacts (the GitHub repo is public) |
| Branding | §9.1, §9.2, naming guidelines | wording "Connect to QuickBooks" / "Disconnect from QuickBooks", "QuickBooks" never abbreviated, no Intuit logo | **OWNER:** use Intuit's official Connect to QuickBooks button graphics before production. **COUNSEL:** whether the route path segment `quickbooks` in the Production callback URL is acceptable under §9.2 ("URLs or domains") |
| Subprocessors | §12.2, §16 | tokens reach only Vercel (runtime) and Supabase (database) | **OWNER:** data processing agreements on file for Vercel and Supabase; keep QuickBooks data out of analytics, email and AI vendors |
| AI / LLM (NIST) | §11.7, §12.2 | no AI processing of QuickBooks data | See §7 |
| Sandbox limited to non-live data | §7.2 | sandbox only; no real tenant data | Never load real customer or fundraiser data into a sandbox company |
| Discretionary production approval | §8.1, §8.5 | Production disabled by default | Plan no timeline; the product must work with QuickBooks unavailable |

---

## 6. Privacy policy / EULA — factual disclosure checklist

The current `/legal/privacy` page (about 160 words; its "Last Updated" renders today's date on every view) and `/legal/eula` (app-store boilerplate) do **not** cover QuickBooks. **Do not publish new policy text without owner/counsel approval.**

Exact technical data flows the disclosure must describe:
- **What is accessed:** QuickBooks Online Accounting API under `com.intuit.quickbooks.accounting`. In QB-INVOICE-1A the only data read is CompanyInfo (company name and country, used for display and health checks). Later phases will create customers and invoices.
- **What is stored:** encrypted OAuth access and refresh tokens, the encrypted QuickBooks company (realm) id, token expiry times, and the FreezerIQ user id of the admin who connected or disconnected, with timestamps. QB-INVOICE-1A stores no company name. From QB-INVOICE-1B (§11), each connection generation also stores the environment, the company name QuickBooks reported, and the authorizing admin's user id and time; link tables store QuickBooks customer and invoice ids.
- **Where:** FreezerIQ's database (Supabase, US) accessed by FreezerIQ's application servers (Vercel, US).
- **Why:** to let the tenant's administrator connect their own QuickBooks company to FreezerIQ.
- **Consent:** the tenant administrator authorizes on Intuit's consent screen; they can disconnect at any time in FreezerIQ Settings or inside QuickBooks.
- **Retention and deletion:** on disconnect, tokens are revoked at Intuit and deleted from storage; a disconnect record (reason, time, encrypted company id) remains until the administrator chooses "Forget company". From QB-INVOICE-1B, Forget also deletes customer links, and Historical QuickBooks connection generations referenced by invoice history survive Disconnect and Forget for accounting/audit continuity, subject to the applicable data-retention and deletion policy. (Technically, Forget ends every generation without deleting its record.) State what happens in backups.
- **Required statements:** that FreezerIQ does not process data on Intuit's behalf; the independent-controller position (§12.4); privacy rights and a real contact address; FreezerIQ's legal entity name and address; a stable "last updated" date.
- **EULA:** replace app-store boilerplate with terms for the FreezerIQ web service before App Assessment; Intuit reviews the EULA URL.
- Both pages must stay **public** (not behind a login); Intuit's production App Details require the EULA and privacy policy URLs.
- Any FreezerIQ material that mentions Intuit or QuickBooks (marketing, help pages) needs Intuit's trademark notice ("Intuit and QuickBooks are registered trademarks of Intuit Inc. Used with permission."); the only permitted relationship phrases are "Member of the Intuit Developer Program" / "Member: Intuit Developer Program".

---

## 7. AI / MCP boundary

- Production FreezerIQ talks to QuickBooks only through this deterministic REST integration (`lib/quickbooks/intuitClient.ts`).
- No production accounting action may depend on an LLM choosing an MCP tool or API call.
- Intuit's QuickBooks Online MCP server (github.com/intuit/quickbooks-online-mcp-server) may be used by developers **only against sandbox companies with test data**, through the separately registered `http://localhost:8000/callback`. It is not part of FreezerIQ's code, build or deployment, and none of its code is copied.
- Real tenant QuickBooks data must not be sent to any AI or LLM service for convenience. Any future AI use of Intuit User Data needs a separate review against §11.7 (NIST — the AI Risk Management Framework is the likely reference, not named in the terms), §12.2 (purpose, consent, written third-party agreements) and Intuit's Responsible AI Principles, and must never use that data for model training.

---

## 8. Intuit app settings — plan (do not submit the App Assessment yet)

| Setting | Proposed value | Status |
|---|---|---|
| Development redirect URIs | OAuth Playground; `http://localhost:8000/callback` (MCP tooling); `http://localhost:3000/api/integrations/quickbooks/callback` | the third one to be added by the owner |
| Production redirect URI | `https://www.freezeriqapp.com/api/integrations/quickbooks/callback` | later; subject to the §9.2 path question |
| Launch URL | `https://www.freezeriqapp.com/login` | exists |
| Connect/Reconnect URL (field available since 2026-02-24; Intuit says it "will be" mandatory, and the Publish-your-app page lists it among URLs required before production credentials) | `https://www.freezeriqapp.com/settings` (signs the admin in, then shows Reconnect) | route exists; confirm acceptable |
| Disconnect URL | a public static page saying the QuickBooks company was disconnected, with reconnect steps; Intuit may append `?realmId=` | **GAP** — minimal follow-up: one static page, no data access, no state change (an unauthenticated hit with a realmId must never modify a connection) |
| Support / contact | a public page with a real contact route | **GAP** |
| Host domain | `www.freezeriqapp.com` | — |
| Accepted connections | United States | set |
| Categories / regulated industries | as set; "None of the above" | **OWNER:** reconfirm before any Payments API use (Payments API apps are automatically "Payments/Money Movement") |
| Scopes | accounting only | scopes can be added but never removed; do not add payments |

---

## 9. Geolocation / hosting declaration (Vercel)

- **What Intuit asks:** the country or countries where the app is hosted. The current app-settings documentation marks the IP address as **optional**. Older portal versions (through about 2024–early 2025) required an IP or range; only the live signed-in form can confirm today's behaviour. Intuit support has described declared IPs as monitoring/flagging information, not an allowlist.
- **Enforcement:** no Intuit documentation describes source-IP allowlisting of Accounting API or OAuth calls.
- **What FreezerIQ has:** Vercel Functions with dynamic, shared egress IPs (no fixed IP by default); functions default to `iad1` (Washington, D.C., US) and the repo sets no region override; the Production database is Supabase in AWS us-east-1 (US).
- **Static egress IP required?** Not on current evidence. Vercel Static IPs exist (Pro/Enterprise, $100/month per project plus data transfer, applies to every environment including Preview) — **not purchased, not recommended now.**
- **Owner actions:** (1) open the Intuit portal's Geolocation / "regions where your app is hosted" field and check whether the IP is optional; (2) confirm in Vercel Project Settings → Functions that the region is US; (3) declare **United States** and leave the IP blank if allowed; (4) if an IP is forced, ask Intuit support before considering any paid Vercel feature. Do not enter a home IP, a DNS-resolved IP, an observed function IP, or an invented range. Update the declaration if hosting changes (§6.1).

---

## 10. Third-party license inventory (QuickBooks integration)

| Component | Version | License | Distributed with FreezerIQ | Modified | NOTICE | Attribution |
|---|---|---|---|---|---|---|
| `intuit-oauth` (Intuit oauth-jsclient) | 4.2.2 | Apache-2.0 | **Removed** in QB-INVOICE-1A | no | none upstream | none needed now |
| `node-quickbooks` | 2.0.47 | ISC (package.json only; no license text) | **Removed** | no | none | none needed now |
| `request` (via node-quickbooks) | 2.88.0 (deprecated) | Apache-2.0 | **Removed** | no | none | — |
| 82 further transitive packages (winston, csrf, query-string, request's subtree…) | — | 64 MIT (+1 legacy-declared MIT), 5 Apache-2.0, 4 ISC, 3 BSD-3-Clause, BSD-2-Clause, MIT OR Apache-2.0, AFL-2.1 OR BSD-3-Clause, Unlicense; no copyleft | **Removed** | no | none | — |
| `date-fns` | 2.30.0 | MIT | yes (unchanged code; now a declared dependency) | no | none | MIT notice ships in the package |
| Intuit QuickBooks Online MCP server | n/a | ambiguous: LICENSE file Apache-2.0, package.json/README MIT | **no** — developer tooling only | n/a | none upstream | — |
| Intuit sample code / SDKs | n/a | — | **no** | n/a | — | — |
| FreezerIQ QuickBooks connector (`lib/quickbooks/*`, `lib/integrationTokenCrypto.ts`) | — | FreezerIQ's own code | yes | — | — | — |

The connector is an independent implementation of Intuit's published HTTP endpoints. No Intuit or node-quickbooks source was copied (repository and history scan found no Intuit copyright headers or Apache license text outside `package-lock.json`). Apache-2.0 §4 obligations therefore do not attach to FreezerIQ's code. If Intuit code is ever copied, its LICENSE, NOTICE (none exists today) and copyright headers must be preserved and modified files marked. Apache-2.0 §6 grants no trademark rights: use of "Intuit" and "QuickBooks" rests on Intuit's developer terms and naming guidelines, not on any code license. Intuit's official button graphics are Intuit assets and must not be redistributed outside the app.

---

## 11. QB-INVOICE-1B — customer mapping and invoice-link foundation

**Status:** owner Intuit sandbox acceptance **PASSED** on September 14, 2026 (§11.8). Isolated branch `worktree-qb-invoice-1b` (from `f8073eb`), **not merged, not deployed**. Its migration has been applied to disposable local databases and, with owner authorization, to the owner's local development database (§11.9) — **not** to Production or Preview. It does **not** create or send QuickBooks invoices. The owner's acceptance fix (September 13, 2026) is included: the invoice-link lifetime rule, retained connection generations, and the V1 recording contract (§11.2, §11.5).

### 11.1 What it adds

| Surface | Path | Who |
|---|---|---|
| Organization's QuickBooks customer — state | `GET /api/integrations/quickbooks/customers/[customerId]` | tenant ADMIN |
| Link an exact match / create a customer | `POST` same path, `{"action":"link","confirmation"}` or `{"action":"create","confirmation","attemptId"}` (application/json only) | tenant ADMIN |
| Card on the organization page (Overview tab) — the organization profile `/fundraisers/[id]` that Customer CRM → Organizations opens (added by QB-ORG-LINK-1), and `/customers/[id]` | `components/crm/QuickBooksCustomerLinkCard.tsx` (one component, one route) | renders only for an ADMIN, and nothing when QuickBooks is disabled |

Library: `lib/quickbooks/customerLinks.ts` (mapping service), `lib/quickbooks/connectionGenerations.ts` (connection generations and the generation lock), `lib/quickbooks/customerLinkView.ts` (card wording), `lib/quickbooks/invoiceLinks.ts` (invoice-link primitives — **no caller in 1B**), and three Customer functions in `lib/quickbooks/intuitClient.ts`.

Tables (migration `20260913120000_qb_invoice_1b_quickbooks_links`, additive): `quickbooks_connections` (generations), `quickbooks_customer_links`, `quickbooks_invoice_links`, plus a unique index `invoices (business_id, id)`.

### 11.2 Connection generations (owner rulings, September 13, 2026)

A QuickBooks customer or invoice id means something only inside one QuickBooks company. Links are therefore bound to a **connection generation**: one lifetime of the tenant's `integrations(business_id, 'quickbooks')` row, recorded in `quickbooks_connections` the first time a connected tenant opens the mapping. **No realm fingerprint is stored** (owner ruling); nothing derived from the realm or a token leaves the encrypted `integrations` columns.

| Event | Generation | Customer links | Invoice links |
|---|---|---|---|
| Token refresh | unchanged | kept | kept |
| Disconnect | unchanged, still live | kept (unusable while disconnected) | kept |
| Reconnect the **same** company after Disconnect | unchanged | kept, usable again | kept |
| Reconnect a **different** company without Forget | refused by QB-INVOICE-1A (`realm_mismatch`) | — | — |
| **Forget** | **ended**: Postgres sets `live_business_id`/`live_provider` to NULL; the record is **kept** | **deleted** by Postgres | kept unchanged, still referencing the ended generation |
| Connect after Forget — any company, the same one included | a **new** generation | none: every organization needs a new ADMIN confirmation | earlier links stay history; their invoices can never be linked again |

**Evidence on each generation** (non-secret, written once): environment (`sandbox`/`production`), the company name QuickBooks reported when the generation was recorded, the FreezerIQ admin whose authorization was in force and when (QB-INVOICE-1A's audit), and the creation time. At most one generation per tenant is live (unique index; a NULL-safe CHECK keeps the live pair consistent). No code updates or deletes a generation (scope test), and Postgres refuses to delete one directly while an invoice link references it (`ON DELETE RESTRICT`).

**Retention:** Historical QuickBooks connection generations referenced by invoice history survive Disconnect and Forget for accounting/audit continuity, subject to the applicable data-retention and deletion policy. Technically, Forget ends every generation without deleting its record, whether or not invoice history references it; this describes behaviour, not a retention period.

**Race safety.** Every write bound to a generation — recording one, writing a customer link, reserving an invoice link — runs in a transaction that holds `FOR SHARE` on the tenant's integrations row (refresh, Disconnect, reconnect and Forget all write that row, so they wait; proven on real Postgres) and re-reads the stored connection under that lock: it must still be connected to the same company as the access token the request used. Realm ids are compared in memory only. In addition:
- a customer link's foreign key references the generation's **live** key `(live_business_id, live_provider, id)`, so the database itself refuses a link to an ended generation;
- a refreshed access token that reaches a different company is never used, and a generation is never recorded against a company other than the token's;
- a create dialog whose generation ended while it re-evaluated sends no create to QuickBooks.

**Not enforced by the database:** immutability of a generation's evidence columns and of an invoice link's identity columns rests on code and scope tests, not a trigger (the repository has no trigger precedent). A trigger can be added later if the owner wants database-level immutability.

### 11.3 Customer mapping rules (owner-locked) and how they are enforced

| Rule | Enforcement |
|---|---|
| A valid stored link wins | a stored link is read by id; if QuickBooks reports an active, top-level customer, the name search never runs |
| Otherwise exact DisplayName, inactive included | two queries (default active + `Active = false`); Intuit's `=` ignores case, so exactness is checked byte for byte in code |
| Never email, never fuzzy | the query names only DisplayName; the organization is read for id and name only |
| Case-only difference | reported as "resolution required"; never linked, never offered for creation |
| Explicit ADMIN confirmation | every action carries an opaque confirmation bound to generation + organization + organization name + candidate + existing link; any change makes it stale (409) and returns the new state |
| Inactive, deleted, merged or missing customer | a **stored link** to such a customer is terminal in V1 (owner rule, sandbox acceptance 2026-09-14): "relink required", no name lookup, **no Create and no Link** — the stored link takes precedence, is never replaced or deleted, and is resolved in QuickBooks (a future explicit relink workflow may be designed separately); with no stored link, an exact inactive match — or an inactive customer named exactly "<name> (deleted)" (owner ruling B, 2026-09-14; no other suffix, no fuzzy match, never linked) — blocks linking and creating |
| Sub-customer or project | not linkable as an organization |
| Never rename or update a QuickBooks customer | the client has no update path (no sparse update, no SyncToken) |
| Minimal create | `POST /customer` body is exactly `{"DisplayName": <organization name>}` |
| Name QuickBooks cannot take verbatim | leading/trailing space, `:`, tab, newline, backslash, control characters or more than 100 characters → reported; FreezerIQ never alters the name |
| Vendor/employee already holds the name | QuickBooks Fault 6240 with no customer of that name → `rejected / name_in_use` |
| One QuickBooks customer per organization; one organization per customer within a generation | unique indexes; racing requests leave one row |
| A forgotten company's mapping is never reused | Forget deletes every customer link; a link can only reference the live generation (foreign key); the old confirmation is stale |
| Tenant from the session; company from the verified connection | route input names neither; organization ownership re-checked; composite foreign keys keep a link inside its tenant |

The responses and the card show organization and QuickBooks display names only — never a token, realm id, generation id or raw QuickBooks id.

### 11.4 Idempotency and ambiguous results

- **Double-submit:** `attemptId` is fresh per confirmation dialog, and the Intuit `requestid` is derived from it. Two submissions of one dialog that both reach QuickBooks get Intuit's original answer, so only one customer is created.
- **Two dialogs racing:** the second create hits QuickBooks' DisplayName uniqueness (6240) and is shown the new state. It is never auto-linked.
- **Response lost after QuickBooks processed the create:** outcome `unknown` (202), and nothing is linked. The next look shows an exact match, which still needs a link confirmation.
- **A repeated confirmation after its twin already linked:** answered `linked`, but only when the stored link is exactly what that confirmation described.
- **Recording a generation** is idempotent: concurrent first views leave one generation.

### 11.5 Invoice-link foundation (no behaviour in 1B)

`quickbooks_invoice_links` stores identifiers and audit metadata only: `invoice_id`, `connection_id` (the generation), `request_id` (reserved before any future QuickBooks request), `qbo_invoice_id` (recorded once), `qbo_linked_at`, `created_by`, `created_at`. It has no amount, tax, status or payment column. The primitives read the invoice's id alone and never write the invoice, so they cannot change `status`, `total_amount` or `paid_at`, or release food.

**Lifetime rule (owner ruling).** A FreezerIQ invoice has at most **one** QuickBooks invoice link in its whole lifetime: `UNIQUE (invoice_id)`, across every generation. Disconnect, Forget, a new generation or reconnecting the same company never makes the invoice eligible for a second link. The service answers `already_linked` without writing, and the database refuses a direct insert. Moving an invoice to other books would need a future, explicit repair workflow (not designed).

**History.** A link references its generation `(business_id, connection_id)` with `ON DELETE RESTRICT`, and Forget never deletes generations. After Forget, `getQuickBooksInvoiceLink` still returns the link with its generation's evidence and `live: false`. A QuickBooks id is still recorded on its own generation if the tenant forgot the connection while the create was in flight.

**Constraints:**
- unique `invoice_id`, and unique `(connection_id, qbo_invoice_id)` — one FreezerIQ invoice per QuickBooks invoice inside a generation;
- a NULL-safe CHECK that `qbo_invoice_id` and `qbo_linked_at` are set together;
- `ON DELETE NO ACTION` to invoices: an invoice with a QuickBooks counterpart cannot be deleted on its own. The existing tenant invoice DELETE route would then fail — **a QB-INVOICE-1C decision**.

**Company-level uniqueness across generations is deliberately not a database key.** Without a realm fingerprint the database cannot know whether two generations are the same company, so `(connection_id, qbo_invoice_id)` is the strongest honest key. **V1 recording contract for QB-INVOICE-1C (owner ruling):**
1. reserve under the live generation, passing the realm of the access token that will send the create (verified under the lock);
2. send the create with the reservation's `request_id` as Intuit's `requestid`, using a token for that same company;
3. record **only** the `Id` from that create response or its `requestid` replay — never an id from a query or search, typed by a person, or matched.

Every recorded id is then created by exactly one reservation, so one QuickBooks invoice can never be attached to two FreezerIQ invoices in any generation. No invoice query, search or read exists in 1B, and no route or UI accepts a QuickBooks invoice id (scope tests). **Any future feature that links pre-existing QuickBooks invoices requires a new owner-approved cross-generation uniqueness design.**

**Hard tenant delete (no product flow does this), verified on real Postgres:**
- While an organization has a QuickBooks customer link, the delete is refused: the link's organization FK is `ON UPDATE NO ACTION` against the SET NULL a tenant delete performs.
- After Forget, the delete succeeds and removes the tenant's generations, invoices and invoice links together.
- `fundraiser_organization_contacts` already makes the same class of delete fail.

### 11.6 Intuit API calls introduced

| Call | Purpose |
|---|---|
| `GET /v3/company/{realm}/query?query=select * from Customer where DisplayName = '…' maxresults 20` | exact-name lookup, active |
| same, `… and Active = false …` | exact-name lookup, inactive |
| same, `… DisplayName = '<name> (deleted)' and Active = false …` | only when nothing matches exactly: an inactive customer with exactly that name blocks Create (owner ruling B) |
| `GET /v3/company/{realm}/customer/{id}` | validate a stored link (Fault 610 = missing) |
| `POST /v3/company/{realm}/customer?requestid=…` with `{"DisplayName"}` | create, only after an explicit confirmation |
| `GET /v3/company/{realm}/companyinfo/{realm}` (QB-INVOICE-1A's read-only call) | once per generation, to record the company name as audit evidence |

All calls use `minorversion=75`, and a Fault is honoured even on HTTP 200. **No invoice, payment, send or webhook call exists.** The OAuth scope is unchanged: `com.intuit.quickbooks.accounting`.

**Intuit behaviour that is NOT verified from official docs and must be checked in the sandbox (§11.8):**
- ~~whether a deleted/merged customer's API `DisplayName` gains a ` (deleted)` suffix~~ — **verified in the sandbox (2026-09-14):** "Make inactive" deactivated the customer and renamed it "<name> (deleted)". An exact-name search therefore no longer finds it, which is why a stored link to it is terminal (§11.3);
- whether an inactive customer's name still blocks creating a new customer with that name (after the rename, likely not — unverified);
- whether DisplayName uniqueness ignores case;
- how long a `requestid` is remembered.

The code fails closed for each.

### 11.7 Migration and release procedure

The migration is additive:
- no column on an existing table changes;
- no row is written, and nothing is backfilled — existing Production records get no generation, link or guess;
- the only change to an existing table is a unique index that cannot fail.

**Validated on disposable local databases only (after the acceptance fix):**
- a fresh database took all 26 migrations and reported status up to date, with the delete rules as designed: generation ← integrations SET NULL; customer links ← integrations CASCADE; customer links → live generation; invoice links → generation RESTRICT;
- migrations → schema drift is identical to `f8073eb`'s pre-existing drift, and no drift line names a 1B object;
- a `pg_dump` copy of the local data was brought to `f8073eb` and then migrated: every row of eight existing tables was unchanged, and the new tables were empty;
- re-running the SQL only reports "already exists" on the eight plain constraints;
- the down SQL restores the exact prior state, and redeploying afterwards is clean;
- the real-Postgres suite (`tests/qbInvoice1bRealDb.test.ts`) passed on the fresh database: acceptance steps 1–10, the generation lock, the CHECKs, and the tenant-delete behaviour;
- re-run on the final candidate at closeout (September 14, 2026, after the Acceptance C fix and owner ruling B): all 26 migrations from zero; every installed constraint compared with its exact expected definition; a copy restored from the pre-1B local backup, with synthetic invoices added, kept all 63 existing tables byte-identical through the migration; after the rollback its schema dump was identical to the pre-1B schema, and redeploying was clean; the real-Postgres suite passed 10/10 on both databases.

**Preview shares the Production database, and `npm run build` never migrates.** Procedure, each step only with explicit owner authorization:
1. Owner review and sandbox acceptance (passed September 14, 2026); commit on the isolated branch `worktree-qb-invoice-1b`. Merging into the release branch is a separate owner-authorized step.
2. Before the code is promoted, apply the migration to the Production database with `prisma migrate deploy`, run by the owner (or with explicit authorization) against the Production URL. It is safe before the code, because nothing existing reads the new tables. Confirm `_prisma_migrations` lists `20260913120000_qb_invoice_1b_quickbooks_links` as finished.
3. Deploy. Even if the code reached Preview or Production first, the new routes answer `disabled` before touching the database there (QuickBooks was disabled in both at the time), and the card renders nothing.
4. Rollback of code alone needs nothing: old code ignores the new tables. Reversing the migration destroys generations and links, so it is only for a database where no QuickBooks invoice link exists and only with an owner decision:

```sql
BEGIN;
DROP TABLE "quickbooks_invoice_links";
DROP TABLE "quickbooks_customer_links";
DROP TABLE "quickbooks_connections";
DROP TYPE "QuickBooksCustomerLinkSource";
DROP INDEX "invoices_business_id_id_key";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20260913120000_qb_invoice_1b_quickbooks_links';
COMMIT;
```

### 11.8 Owner sandbox acceptance runbook (performed September 14, 2026 — PASSED)

Sandbox company only. **Never the real Freezer Chef company.**

**Result (September 14, 2026):** steps 1–6 were performed with the owner against the sandbox company and PASSED — an exact existing customer was linked (`existing`); a case-only name difference was blocked; an inactive linked customer showed a terminal **Relink required** with only Check again, and reactivating that same customer made the stored link valid again with no relink; one FreezerIQ-created customer (`created`, DisplayName only) was linked. Step 5 first exposed a defect — Create was offered for the inactive linked customer — which was fixed and retested before continuing, and owner ruling B was added (§11.3). Step 7 (Disconnect → Forget → reconnect) was not performed live; the real-Postgres suite proves it (§11.7). Step 8: the " (deleted)" rename is recorded in §11.6. No QuickBooks invoice was created, and no Production or Preview database was touched.

1. Apply the migration to your **local** development database only, following §11.9 exactly.
2. Start the local dev server from the 1B worktree, sign in as a local tenant ADMIN, and confirm Settings shows QuickBooks **Connected** (sandbox).
3. In the Intuit sandbox company, note one existing customer's exact display name (e.g. one of the sample customers). In local FreezerIQ, open an organization whose name matches it **exactly**. The organization card shows "QuickBooks has a customer named exactly …". Confirm the link, then check the card shows **Linked**.
4. Open an organization whose name differs from that customer only in letter case: the card must say "resolution required", with no link or create button.
5. Make that sandbox customer **inactive** in QuickBooks (it becomes "<name> (deleted)"), then **Check again** on the linked organization: the card must show **Relink required** with **no Create and no Link** — only Check again. Reactivate it afterwards only when told to.
6. Optionally create **one** clearly identified test customer: create a local organization named e.g. `QB1B Sandbox Test Org`, click **Create QuickBooks customer**, confirm the exact name, and check that the sandbox company now has one customer with that name, no email, and a link on the card.
7. Disconnect, then Forget, then connect the same sandbox company again: the card must show the organization as **unlinked** (never Linked) until you confirm again.
8. Record any difference from §11.6's unverified facts (the " (deleted)" suffix, and whether inactive names block creation).

### 11.9 Local database procedure (performed with owner authorization, September 14, 2026)

Target: the owner's local Postgres database `freezer_iq` on `127.0.0.1:5432` — nothing else. Before QB-INVOICE-1B it had 22 of `f8073eb`'s 25 migrations; missing were `20260905000000_ops6b_order_delivery_handoff`, `20260909000000_coord_manual_email_1b_order_email` and `20260912000000_fr_supporter_payment_status_1_order_paid`. It has had all 26 since September 14, 2026 (a pre-migration backup is kept outside the repository).

The 1B worktree has no `.env` files, so Prisma reads only the two variables set below. **Never use `.env.local`**: it targets the Production database, which Preview shares. Run everything in one PowerShell session.

**Step 0 — bind the session to the local database and refuse anything else.** No command here prints a credential.

```powershell
$checkout = '<path to the QB-INVOICE-1B checkout>'
$primary = '<path to the primary checkout that holds .env.development.local>'
cd $checkout
$line = (Select-String -Path (Join-Path $primary '.env.development.local') -Pattern '^DATABASE_URL=' | Select-Object -First 1).Line
$env:DATABASE_URL = ($line -replace '^DATABASE_URL=', '').Trim('"')
$env:DIRECT_URL = $env:DATABASE_URL
$u = [Uri]$env:DATABASE_URL
if (@('127.0.0.1', 'localhost') -notcontains $u.Host -or $u.AbsolutePath -ne '/freezer_iq') { Remove-Item Env:DATABASE_URL, Env:DIRECT_URL; throw 'STOP: not the local freezer_iq database' }
$pgUri = $env:DATABASE_URL.Split('?')[0]
$bin = 'C:\Program Files\PostgreSQL\16\bin'
"target: host=$($u.Host) port=$($u.Port) database=$($u.AbsolutePath.TrimStart('/'))"
```

It must print `target: host=127.0.0.1 port=5432 database=freezer_iq`. On any other output, stop.

**Step 1 — backup, then read the current state (read-only).**

```powershell
& "$bin\pg_dump.exe" -Fc -f "$env:USERPROFILE\freezer_iq_before_qb1b.dump" $pgUri
& "$bin\psql.exe" -X -d $pgUri -c "BEGIN READ ONLY; SELECT COUNT(*) AS applied FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL; COMMIT;"
```

Expected: `applied = 22`.

**Step 2 — bring the database to the `f8073eb` baseline** with `f8073eb`'s own schema and migrations, not the 1B ones:

```powershell
$base = Join-Path $env:TEMP 'freezeriq_f8073eb_prisma'
Remove-Item -Recurse -Force $base, "$base.zip" -ErrorAction SilentlyContinue
git -C $checkout archive --format=zip -o "$base.zip" f8073eb40745c1199613d37625b4214bfdc7567f prisma
Expand-Archive "$base.zip" -DestinationPath $base
npx prisma migrate status --schema "$base\prisma\schema.prisma"
npx prisma migrate deploy --schema "$base\prisma\schema.prisma"
```

`migrate status` must list exactly the three missing migrations above. After `deploy`, `applied` (the Step 1 query) must be 25.

**Step 3 — apply QB-INVOICE-1B.**

```powershell
npx prisma migrate status
npx prisma migrate deploy
```

`migrate status` must list exactly one pending migration: `20260913120000_qb_invoice_1b_quickbooks_links`. After `deploy`, check:

```powershell
& "$bin\psql.exe" -X -d $pgUri -c "BEGIN READ ONLY; SELECT COUNT(*) AS applied FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL; SELECT (SELECT COUNT(*) FROM quickbooks_connections) AS generations, (SELECT COUNT(*) FROM quickbooks_customer_links) AS customer_links, (SELECT COUNT(*) FROM quickbooks_invoice_links) AS invoice_links; COMMIT;"
npx prisma migrate status
```

Expected: `applied = 26`, `0 | 0 | 0`, and "Database schema is up to date!". The existing sandbox connection gets its first generation only when an organization's QuickBooks card is first opened.

**Step 4 — prove no Production or Preview database was touched, and clean up.**
- Every command ran with the variables Step 0 verified as `127.0.0.1/freezer_iq`. Production and Preview use the Supabase pooler host (`aws-1-us-east-1.pooler.supabase.com`), which this procedure never reads.
- A read-only Production gate (Production `_prisma_migrations` must **not** list `20260913120000_qb_invoice_1b_quickbooks_links`, and no `quickbooks_%` table exists) confirms it independently.

```powershell
Remove-Item Env:DATABASE_URL, Env:DIRECT_URL
Remove-Item -Recurse -Force $base, "$base.zip"
```

**Undo (local only):** restore `$env:USERPROFILE\freezer_iq_before_qb1b.dump` with `pg_restore --clean`, or, before any link exists, run the §11.7 down SQL against `$pgUri`.

---

## 12. QB-INVOICE-1C — Send via QuickBooks

**Status:** implemented on the isolated branch `qb-invoice-1c` (from `7d17fc8`), uncommitted, awaiting owner review and Intuit **sandbox** acceptance (§12.12). Not deployed; the migration is not applied to Production, Preview or the owner's local database. QuickBooks stays disabled in Preview (§2); Production was enabled later by a separate owner step (see the status lines at the top).

### 12.1 What it adds

| Surface | Path | Who |
|---|---|---|
| Invoice settings (read / save / create one helper item) | `GET` / `PUT` / `POST {action:'create_item'}` `/api/integrations/quickbooks/invoice-settings` | tenant ADMIN |
| Send via QuickBooks (state / send / resume / check delivery / send again) | `GET` / `POST {action:'send'|'resume'|'check_delivery'|'resend'}` `/api/integrations/quickbooks/invoices/[invoiceId]` | tenant ADMIN |
| Settings card | `components/settings/QuickBooksInvoiceSettingsCard.tsx` (below the connection card, same ADMIN gate) | ADMIN only |
| Review / status dialog | `components/invoices/QuickBooksInvoiceSendDialog.tsx`, opened from the "QuickBooks" row action of a fundraiser invoice on `/invoices` | ADMIN only, not View As |

Library (`lib/quickbooks/`): `invoicePayload.ts` (the invoice to create, pure), `invoiceContract.ts` (read-back contract, pure), `invoiceSettings.ts` (tenant mapping), `invoiceSend.ts` (the lifecycle), `invoiceRecipients.ts`, `invoiceLock.ts` (what a QuickBooks invoice locks elsewhere), `invoiceSendView.ts` and `invoiceSettingsView.ts` (wording, pure), `liveConnection.ts` (moved unchanged out of `customerLinks.ts`); invoice and setup calls in `intuitClient.ts` (§12.8).

Schema (one additive migration, `20260915170000_qb_invoice_1c_invoice_send`): `quickbooks_invoice_settings`, `quickbooks_invoice_sends`, enum `QuickBooksInvoiceSendStatus`, and a unique index on `quickbooks_invoice_links (business_id, invoice_id)` (cannot fail: `invoice_id` is already unique). The invoice link's `request_id` is now **derived** from the invoice (`qbinv-` + 40 hex of SHA-256), so every attempt in the invoice's lifetime uses the same Intuit `requestid`.

Nothing happens at fundraiser close. A QuickBooks invoice is created only by the explicit "Send via QuickBooks" click.

### 12.2 The QuickBooks invoice (owner-locked content)

FreezerIQ owns every number; QuickBooks only holds them. **QuickBooks `TotalAmt` must equal `Invoice.total_amount` to the cent**, or nothing is sent.

- **Bundle lines** — one per stored invoice line, PRE-tax: description = bundle name + size ("Family Friendly — Serves 5"; a name that already states its size is kept), the stored quantity and unit price, the tenant's one generic sales item, `TaxCodeRef NON`. Never one QuickBooks item per bundle.
- **Organization share** — one visible NEGATIVE line "Organization fundraiser share — 20%" at minus the exact stored share, on the tenant's share item. Never applied to tax.
- **Supporter tax** — one ordinary NON line "Sales tax collected from supporters — 1%" carrying the exact frozen `Invoice.tax_amount`, on the tenant's tax item. Omitted when zero. Never QuickBooks sales tax (`TxnTaxDetail`), never rebuilt from a rate. A `TAX_EXEMPT` invoice carries the memo "Tax exempt — documentation on file." (and may not carry tax).
- **Header** — the organization's linked QuickBooks customer, the tenant-local date (`Business.timezone`), the tenant's term (QuickBooks derives DueDate), a private note naming the FreezerIQ invoice. No DocNumber: QuickBooks assigns it and FreezerIQ stores it; the QuickBooks `Id` (on the link) is authoritative.
- **Hard gate** — refused unless every line's quantity × price is a whole cent equal to its total, and bundles − share + tax equals the total. The owner's rounding fixture (7 × $62.50 + 2 × $60.00 = $557.50; share $111.50; tax $5.59 frozen per order at 1%) plans and reads back as **$451.59**.

### 12.3 Tenant mapping (owner rules)

Only the tenant's OWN QuickBooks objects, filtered by purpose on the server and re-verified from QuickBooks before every send (items can be re-pointed in QuickBooks at any time):

| Role | Item | Account it must post to |
|---|---|---|
| Fundraiser sales | active Service / NonInventory | Income: SalesOfProductIncome, ServiceFeeIncome or OtherPrimaryIncome |
| Organization share | active Service / NonInventory | Income: **DiscountsRefundsGiven** (contra-revenue) only |
| Supporter tax | active Service / NonInventory | Other Current Liability, **not** QuickBooks' own GlobalTaxPayable (QuickBooks refuses it, Fault 6430) |
| Payment terms | active **STANDARD** term | QuickBooks derives DueDate = invoice date + due days |

- **Share as an expense/commission is not offered.** The sandbox accepted it, but Intuit documents neither an expense account on an item's IncomeAccountRef nor on a DiscountAccountRef, and the owner ruled that undocumented mappings are not offered as guaranteed functionality. Carried forward for an owner decision.
- **Company settings that block sending** (each re-read before a send): not a US company; a company-wide sales-form **CC** or **BCC** (QuickBooks would copy it onto every invoice unreviewed); custom transaction numbers (QuickBooks would not number the invoice); multicurrency or a non-USD home currency. Notices only: online payments inactive; company copy emails.
- **Online payment options** (card, ACH) may be chosen only while the company has online payments active, and are applied only after the invoice's amounts and recipients are verified. PayPal and Affirm are never enabled.
- **Helper items.** "Create one in QuickBooks…" creates exactly ONE non-taxable Service item with a fixed name ("FreezerIQ Fundraiser Sales", "Organization Fundraiser Share", "Sales Tax Collected from Supporters") on an eligible account, only with a confirmation bound to that role, account and name, under a requestid. FreezerIQ never creates an account.
- **Opaque keys.** Every option reaches the browser as a 32-hex key derived from the live generation; no raw QuickBooks id, realm, connection id or token is ever returned.
- **Bound to the live generation.** Forget deletes the settings (CASCADE); a new generation starts unconfigured.
- **Recipients.** Suggested primary recipient: the campaign's assigned coordinator, else the organization's contact on file (`lib/campaignCoordinatorContact.ts`); the tenant reviews and may override it. Optional CCs (up to five, comma-separated, 100 characters — QuickBooks keeps "a@x, b@y" exactly, verified in the accounting spike), prefilled from the settings' optional default CC. Never a BCC.

### 12.4 Lifecycle, idempotency and concurrency

`quickbooks_invoice_sends.status`: `reserved → created → recipients_set → payment_options_set → sent`, or `needs_review`.

1. **Gate** (§12.3 plus: live connection for the expected company, the organization linked to an active non-sub customer, invoice still DRAFT and reconciling). The GET returns a **review token** — a hash of the exact create body, the read-back expectation and the payment options. A click whose token no longer matches (money, lines, customer, mapping, date or options changed) is `stale` and sends nothing.
2. **Reserve** the invoice's one link (QB-INVOICE-1B) and create the lifecycle row, which stores the REVIEW: mapping ids, invoice date, recipients, payment options, and a hash binding them.
3. **Create** unsent (no recipient, `EmailStatus NotSet`, all four payment flags explicitly false) with the derived requestid; record the returned `Id` on the link immediately. A lost answer is replayed once at once with the same requestid, then only by a later attempt within 10 minutes of the first; after that the lifecycle stops for review.
4. **Recipients** update (all four flags restated false) → read back.
5. **Payment options** update (tenant flags, recipients restated) → read back; skipped when none.
6. **Send** → read back → **mark SENT**.

- **The review is the authorization.** Resume and "send again" rebuild the create body and expectation from the STORED review plus the CURRENT FreezerIQ invoice, re-verify the stored mapping in QuickBooks, and refuse on any difference — so a later settings change neither breaks nor silently alters an invoice already in QuickBooks.
- **Lease.** A compare-and-set lease (`lease_id`, 2 minutes) lets one request drive a lifecycle; a double click answers `in_progress`. Every QuickBooks write is preceded by a lease-renewing write, so a request whose lease expired cannot reach QuickBooks.
- **Never a second QuickBooks invoice:** UNIQUE `invoice_id` on the link and on the lifecycle, the derived requestid, the record-once link. No QuickBooks invoice is ever searched for or matched.
- **Paused vs stopped.** QuickBooks unreachable, throttled, a stale SyncToken, or an unconfirmed update/send keep the status with a problem code; **Resume** continues from the last verified step after reading QuickBooks again. A failed read-back, a refused create or update, a missing invoice, or an unexpected send stop the lifecycle in `needs_review`: nothing further is sent, the FreezerIQ invoice is not marked SENT, and the same QuickBooks invoice is kept. `needs_review` is terminal, with ONE narrow exception — the create-stage **recheck** (§14.2).

### 12.5 Read-back contract (`invoiceContract.ts`)

Every read-back must show, in integer cents: the same `Id` and a present, unchanged DocNumber; customer, USD, invoice date, term and derived due date; the memo when required; only item lines plus QuickBooks' subtotal line; per line the item, the **posting account (`ItemAccountRef`)**, description, quantity, whole-cent unit price and amount, `NON`; bundles = pre-tax sales, tax line = frozen tax, share line = −share; **QuickBooks' own tax did not affect the total** — its `TotalTax` is zero or absent and every native tax line is worth zero, while a transaction tax code and zero-value automated tax lines are accepted as the metadata they are, and unreadable tax detail fails closed (§14.1); TotalAmt = FreezerIQ total; Balance = total (unpaid); lines sum to TotalAmt. Then per stage:

| Stage | Delivery checks |
|---|---|
| `created` | NotSet, no DeliveryInfo, no e-invoice status, no BillEmail / CC / BCC, all four flags `false` (an absent flag is not false) |
| `recipients` | unsent; BillEmail and CC exactly as reviewed; no BCC; all four flags still `false` |
| `payment_options` | unsent; recipients exact; flags exactly the tenant's options |
| `sent` | recipients exact; flags exactly the tenant's options; EmailSent; DeliveryInfo type Email with a time no earlier than the request (2-minute clock tolerance). A DeliveryErrorType is reported, not a failure |

### 12.6 QuickBooks auto-send and the explicit Send

- **Branch B (auto-send).** If the read-back after the payment-options update shows `EmailSent`, QuickBooks emailed the invoice itself (its documented autosend condition includes card/ACH enabled on the invoice). FreezerIQ does NOT call Send: it verifies the `sent` contract (recipients, money, DeliveryInfo) and records it as the send with `auto_sent = true`.
- **Branch A.** Still `NotSet` → verify `payment_options` → `POST /invoice/{id}/send` (no body, no `sendTo`) → verify the response AND a fresh read-back as `sent` → mark SENT.
- `EmailSent` seen anywhere else is accepted only with evidence: after FreezerIQ's own Send request (answer lost), or with card/ACH applied (a delayed auto-send). Otherwise it is `unexpected_email_status` → needs review.
- A refused or throttled Send sent nothing; the SAME invoice is sent on Resume.

### 12.7 SENT, delivery follow-up, resend and immutability

- **SENT** means QuickBooks reports it emailed the invoice — not delivered, not paid. The lifecycle `sent` row and the FreezerIQ invoice `DRAFT → SENT` are written in ONE transaction, conditional on DRAFT; if the invoice left DRAFT meanwhile, both roll back and the lifecycle stops for review with the send evidence kept. This is the only FreezerIQ invoice write QuickBooks code makes; it never writes PAID, payment facts, orders or fulfillment.
- **Check delivery** reads the invoice and records `DeliveryErrorType` (e.g. Undeliverable). It never changes the FreezerIQ invoice — PAID stays PAID.
- **Send again** (same QuickBooks invoice): only while the FreezerIQ invoice is still SENT (never PAID) and the QuickBooks invoice still matches what was sent (for example, not paid or edited in QuickBooks). Corrected recipients are written with all four flags restated, verified, then Send is verified. A CC already on the QuickBooks invoice cannot be removed in V1 (an update that omits it keeps it).
- **Locks elsewhere** (`invoiceLock.ts`), from the moment the link is reserved: `DELETE /api/tenant/invoices` answers 409 (the database refuses too: link and lifecycle reference the invoice); the generic `PUT` refuses a status or organization change (money on a fundraiser invoice is already frozen; due date and payment method stay editable); the FreezerIQ invoice email route answers 409 so the organization receives one invoice under one number. The invoices list hides Email and Delete for such invoices and shows "QuickBooks #DocNumber · emailed / in progress / needs review". Recording a payment (INV-D) is unchanged.

### 12.8 Intuit API calls introduced

| Call | Purpose |
|---|---|
| `GET /preferences` | company CC/BCC presence, online payments, custom numbering, currency |
| `GET /query?query=select * from Account maxresults 1000` (and `Item`, `Term maxresults 200`) | settings options |
| `GET /account/{id}`, `/item/{id}`, `/term/{id}` | re-verify a mapping before each send |
| `POST /item?requestid=…` `{Name, Type:Service, Taxable:false, IncomeAccountRef}` | confirmed helper item only |
| `POST /invoice?requestid=qbinv-…` | the unsent create |
| `GET /invoice/{id}` | every read-back, by the id FreezerIQ's own create returned |
| `POST /invoice?requestid=qbupd-…` sparse `{Id, SyncToken, BillEmail, BillEmailCc?, 4 flags}` | recipients / payment options |
| `POST /invoice/{id}/send` (octet-stream, no body) | the explicit send |

All with `minorversion=75`; a Fault is honoured on HTTP 200; Fault codes are kept, Intuit's messages never. No payment, void, delete, query-by-invoice, webhook or Payments-scope call exists. The OAuth scope is unchanged.

### 12.9 Not in QB-INVOICE-1C

No payment webhook, polling, automatic PAID, Payments API, card/ACH handling in FreezerIQ, or fulfillment release (QB-INVOICE-1D and later). No void / repair workflow for a stopped lifecycle beyond the create-stage recheck added later (§14.2), and none for correcting an invoice after it is in QuickBooks. No expense/commission share mapping. No non-US, non-USD or custom-numbering companies. No linking of pre-existing QuickBooks invoices.

### 12.10 Tests and evidence (September 15, 2026, local)

- New suites: `qbInvoice1cPayload`, `qbInvoice1cContract`, `qbInvoice1cIntuitClient`, `qbInvoice1cSettings`, `qbInvoice1cSendLifecycle`, `qbInvoice1cRoutes`, `qbInvoice1cInvoiceLocks`, `qbInvoice1cViews`, `qbInvoice1cScope` — all passing over doubles as strict as the sandbox (`tests/helpers/quickbooksInvoiceFakes.ts`: omitted flags re-default true, ItemAccountRef follows the item, requestid replay, 5010/610/2380, autosend, lost responses, tampering).
- `qbInvoice1cRealDb` (opt-in `QB1C_DB_URL`) and `qbInvoice1bRealDb` passed 17/17 on a fresh disposable local database that took all 27 migrations; the 1C foreign keys and 14 CHECK constraints were confirmed from `pg_constraint`, and migrations → schema drift contains no 1C object (the 35 unrelated pre-existing drift statements are unchanged). The disposable database was dropped.
- Updated for 1C: `qbInvoice1aLegacyQuarantine`, `qbInvoice1bScope`, `qbInvoice1bInvoiceLinks` (derived request id), and the migration ledgers (`frAcceptance2A2Dashboard`, `coordManualEmail1b`, `ops6b3DeliveryLabelAuthority`, `frRebook2PreviousSupporters`, `coordPolish1`, `coordShareCenterPolish2`).
- Full Jest: the only failures are the 6 suites / 5 tests that fail identically on a clean `7d17fc8` checkout.

### 12.11 Migration and release procedure

Additive: two new tables, one enum, one unique index on the 1B link table; no existing column or row changes; nothing backfilled. Existing code never reads the new tables, so the migration is safe BEFORE the code — and must precede it, because the new invoices list query selects the lifecycle. Each step only with explicit owner authorization: owner review → sandbox acceptance (§12.12) → commit on `qb-invoice-1c` → Production migration (`prisma migrate deploy` against the direct session URL, confirm `20260915170000_qb_invoice_1c_invoice_send` finished) → release. QuickBooks remains disabled in Preview; enabling it in Production was a separate, owner-approved step (see the status lines at the top). Reversal (only while `quickbooks_invoice_sends` and `quickbooks_invoice_settings` are empty, with an owner decision):

```sql
BEGIN;
DROP TABLE "quickbooks_invoice_sends";
DROP TABLE "quickbooks_invoice_settings";
DROP TYPE "QuickBooksInvoiceSendStatus";
DROP INDEX "quickbooks_invoice_links_business_id_invoice_id_key";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20260915170000_qb_invoice_1c_invoice_send';
COMMIT;
```

Rolling back the CODE after invoices were sent through QuickBooks is not neutral: older code would again allow deleting, re-pointing or emailing those invoices. Keep the locks deployed once any lifecycle row exists.

### 12.12 Owner sandbox acceptance runbook (PREPARED — not yet performed)

**Sandbox company only (Sandbox Company US). Never the real Freezer Chef company.** Use only artificial data: names prefixed `FreezerIQ 1C Acceptance -`, and recipient/CC addresses at `example.com` (they cannot be delivered, which exercises the delivery follow-up). Do not touch the two accepted 1B sandbox customers or the spike artifacts. The sandbox has no online payments, so Branch B (auto-send) cannot occur there — it is proven by tests only and must be re-checked in the first payments-enabled acceptance, which needs its own owner approval.

1. **Local database.** Apply the 1C migration to the local `freezer_iq` database only, with §11.9's Step 0 guard and a fresh `pg_dump` backup first; `migrate status` must list exactly `20260915170000_qb_invoice_1c_invoice_send` as pending; afterwards `applied = 27` and both new tables empty.
2. **Start** the local dev server from the `qb-invoice-1c` worktree (sandbox keys, localhost redirect); sign in as a local tenant ADMIN; Settings shows QuickBooks **Connected** (Sandbox).
3. **Mapping.** In Settings → QuickBooks invoice settings: confirm no blocker (if a company CC/BCC is set in the sandbox, the card must block — remove it in QuickBooks and Check again). Create or choose: a sales item on a sales income account, a share item on Discounts/Refunds Given, a tax item on a non-system liability account, and Net 15. Confirm the expense (commission) item and GlobalTaxPayable accounts are NOT offered. Save → "Ready to send invoices through QuickBooks".
4. **Customer.** Create a local organization `FreezerIQ 1C Acceptance - Test Org` with an `@example.com` contact email, and link or create its QuickBooks customer with the 1B card.
5. **Invoice.** Close out an artificial local campaign for that organization so a DRAFT fundraiser invoice exists (ideally the $451.59 rounding shape). Open **/invoices** → QuickBooks. Review: lines, −share, tax, total, dates, suggested recipient. Nothing exists in QuickBooks yet (check the sandbox).
6. **Stale review.** Leave the dialog open, change the invoice's settings (e.g. pick another term), then click Send: it must say the invoice changed and send nothing. Restore the settings and reopen.
7. **Send** to `acceptance-coordinator@example.com` with CC `acceptance-district@example.com, acceptance-treasurer@example.com`. Expect "Sent via QuickBooks — invoice <DocNumber>".
8. **Verify in QuickBooks:** one invoice, that DocNumber, customer, Net 15 due date, four lines (two bundles NON, −share, tax), TotalAmt equal to FreezerIQ's total, no sales tax, BillEmail and CC exactly as entered, online payment options off, "Sent" email status. In FreezerIQ the invoice shows SENT and "QuickBooks #… · emailed"; Email and Delete are gone from its row.
9. **No duplicates.** Click Send again / reopen: the dialog shows the sent state; the sandbox still has ONE invoice.
10. **Delivery follow-up.** Wait 2–3 minutes, click **Check delivery**: expect "delivery problem (Undeliverable)". Record whether QuickBooks reports it. The FreezerIQ invoice status must not change.
11. **Send again** to `acceptance-fixed@example.com` (same CCs): the same QuickBooks invoice gets the new recipient and a new delivery time; send count 2; still one invoice. Record whether DeliveryTime updates and whether DeliveryErrorType clears.
12. **Locks.** Via the API or UI: delete the invoice (409), change its organization or status by editing (409), email it through FreezerIQ (409).
13. **Stop.** Do not record a payment in QuickBooks, do not enable online payments, and do not connect any real company. Report differences from §12.4–§12.7 before QB-INVOICE-1D is considered.

---

## 13. QB-INVOICE-1D — Check QuickBooks payment

**Status:** owner-approved on September 21, 2026 and committed on the isolated branch `qb-invoice-1d` (from `4767422`); pushed for a Preview only, awaiting the owner's browser acceptance; not released to Production. Code only — no migration, no new dependency, no new OAuth scope, no QuickBooks write. Engineering acceptance against the Intuit **sandbox** passed on September 21, 2026 (§13.9). QuickBooks is always disabled in Preview (§2), so a Preview proves the build and rendering only. Production has QuickBooks enabled with Freezer Chef connected (status lines at the top), so once released the check is live for any invoice sent through QuickBooks.

### 13.1 What it adds

| Surface | Path | Who |
|---|---|---|
| Check QuickBooks payment | `POST {action:'check_payment'}` `/api/integrations/quickbooks/invoices/[invoiceId]` | tenant ADMIN (`mayManageQuickBooks`, the same gate as send / resume / check delivery) |
| Button | "Check QuickBooks payment" in the QuickBooks dialog, separate from "Check delivery"; offered only while the FreezerIQ invoice is SENT | ADMIN only |
| Method label | a verified settlement reads "QuickBooks Payments" on `/invoices` (`settlementMethodLabel`) | — |

Library: `lib/quickbooks/invoicePayment.ts` (classification, the evidence rule, settlement); two read-only calls in `intuitClient.ts` (§13.7); `loadSentReview` in `invoiceSend.ts`, which re-derives the invoice FreezerIQ sent from the STORED review with the same planner and review hash that resume and send-again use; contract stage `payment` in `invoiceContract.ts` (every identity, line and money check, without "unpaid" and without delivery checks). `lib/invoiceSettlementTransition.ts` is the conditional PAID transition, moved unchanged out of the settle route so both ways of being paid run the same one (Fundraiser Fulfillment Contract §5.1).

Nothing is automatic: no webhook, no polling, no cron, no check on page load. QuickBooks is read only when an admin clicks.

### 13.2 What counts as paid (the evidence rule)

A QuickBooks `Balance` of 0 is never proof by itself — a credit memo, a write-off or a journal entry zeroes it too. FreezerIQ marks the invoice paid only when ALL of these hold, in integer cents:

1. The FreezerIQ invoice is SENT. PAID answers `already_paid` without contacting QuickBooks; any other status is blocked.
2. The connection is live and is the generation the invoice was sent under, and the stored review still matches the current FreezerIQ invoice (`changed_since_review` otherwise).
3. The QuickBooks invoice, read by its own Id, still matches what FreezerIQ sent: Id, DocNumber, customer, dates, lines, amounts, total.
4. Its Balance is 0. Equal to the total is `not_paid`; between is `partially_paid`; anything else is a review.
5. Its `LinkedTxn` lists only `Payment` entries, and exactly ONE distinct Payment.
6. That Payment, read by its own Id — never searched for — has: the same Id; the invoice's customer; USD; exactly one line linking exactly one transaction, this invoice (`TxnType` `Invoice`); nothing unapplied; a line amount and a `TotalAmt` each equal to the invoice total; a `TxnDate` that is a real calendar day, not before 2020-01-01 and not more than one day in the future.

Why the Payment itself must be read (each observed in the sandbox, §13.9): a credit memo applied to an invoice appears on the invoice as ONE linked "Payment" — only the Payment shows its `TotalAmt` of 0 and a second line linking the CreditMemo; an overpayment's leftover is later auto-applied by QuickBooks to the customer's next invoice, adding a second invoice line to the SAME Payment; a voided Payment keeps its Id with `TotalAmt` 0 and no lines.

### 13.3 Answers

| Outcome | HTTP | Meaning | Writes |
|---|---|---|---|
| `paid` | 200 | the rule held; settled now | the settlement (§13.4) |
| `already_paid` | 200 | FreezerIQ already records PAID, by any method | none — QuickBooks not contacted |
| `not_paid` | 200 | QuickBooks balance equals the total | none |
| `partially_paid` | 200 | 0 < balance < total; the balance due is shown | none |
| `needs_review` + reason | 409 | QuickBooks shows something the rule does not accept | none |
| `blocked` + blocker | 409, or 503 for not connected / reconnect required | not sent through QuickBooks, not a campaign invoice, lifecycle unreadable, sent under another connection, customer not linked | none |
| `unavailable` | 503 | QuickBooks unreachable, throttled, refused, or malformed | none |

Review reasons: `changed_since_review`, `invoice_status_changed`, `qbo_invoice_missing`, `qbo_invoice_changed`, `balance_inconsistent`, `payment_evidence_unreadable`, `no_payment_evidence`, `unsupported_linked_transaction`, `multiple_payments`, `payment_missing`, `payment_not_for_this_invoice`, `payment_customer_mismatch`, `payment_currency_mismatch`, `payment_includes_other_transactions`, `payment_unapplied_amount`, `payment_amount_mismatch`, `payment_date_invalid` — each worded for the admin in `invoiceSendView.ts`. A review records nothing; where the money did arrive, the admin records it by hand (Record Payment). Failures are logged with the sanitized `intuitErrorDetail` (kind, HTTP status, fault codes, `intuit_tid`) — never a token, realm id, body or amount.

### 13.4 Settlement

- Through `settleInvoiceInTransaction`, **from SENT only**: `payment_method = 'quickbooks'`; `paid_at` = the Payment's `TxnDate` at 12:00 UTC (the calendar-day convention Record Payment uses); `payment_reference` = `QuickBooks payment <Id> · invoice #<DocNumber>`. No schema change: the Payment Id and invoice number are the durable evidence.
- The transition's winner-only branch is the one fundraiser release (the campaign's held orders → `production_ready`), exactly as for Record Payment; loyalty accrual stays paused. A double click, two concurrent checks, or a check racing a human's Record Payment settle and release once between them; the loser reports what is stored.
- The check writes no amount, no lifecycle row, no link, no order directly, and nothing in QuickBooks.

### 13.5 What a person can and cannot do

- Record Payment still offers only Square and Check (`SETTLEMENT_PAYMENT_METHODS` unchanged) and answers 400 to `quickbooks`. No dialog offers "QuickBooks" as a hand-entered method, and the generic invoice routes cannot write PAID at all (INV-A / INV-D).
- **Undo Payment refuses a verified settlement** (409, `verified_settlement`), checked before anything else by a method-agnostic rule (`isVerifiedSettlement`: PAID, a payment date, a verified method). A human's Check or Square record is undoable as before.
- Nothing un-pays automatically. A later refund, void, deletion or edit in QuickBooks does not change a PAID FreezerIQ invoice, and nothing puts released food back on hold. Correct the payment in QuickBooks first; reversing a verified settlement inside FreezerIQ is a later, owner-approved phase.

### 13.6 Known limits (V1)

- **ACH returns and refunds are invisible.** A QuickBooks Payment has no status: an ACH payment later returned by the bank, or a refund, does not change the Payment's `TotalAmt` or its link. The dialog says so before the click.
- **Only one full payment settles automatically.** Partial, several payments, credits, adjustments, overpayments and voids are shown, not recorded.
- **Point in time.** A check reflects QuickBooks at that moment, and QuickBooks can later reshape a Payment (auto-applied leftovers). A settled invoice is never re-checked.
- **AutoApplyCredit.** When QuickBooks' "automatically apply credits" is on (the sandbox default), a customer's unapplied payment or credit is applied to their next NEW invoice as it is created — observed in the sandbox (§13.9). For 1C such an invoice fails its `created` read-back (Balance ≠ total) and stops in `needs_review` before anything is emailed; for 1D it reads as partially paid or as a review. Check an organization's open QuickBooks credits before sending.
- **The Payment Id is visible** in the stored reference on the invoice row. It is not a secret; no token, realm id or company name is stored.

### 13.7 Intuit API calls introduced

| Call | Purpose |
|---|---|
| `GET /invoice/{id}` | the QuickBooks invoice FreezerIQ created, by its stored Id, with `Balance` and `LinkedTxn` |
| `GET /payment/{id}` | the ONE Payment that invoice links, by its own Id |

Both with `minorversion=75`, honouring a Fault on HTTP 200. No query, no search of Payment history, no Payments API, no write of any kind. The OAuth scope is still exactly `com.intuit.quickbooks.accounting`.

### 13.8 Tests

- New suites: `qbInvoice1dPaymentEvidence` (28), `qbInvoice1dPaymentCheck` (43), `qbInvoice1dRoute` (8), `qbInvoice1dSettlement` (7), `qbInvoice1dScope` (15). Fixtures use only shapes the sandbox returned (§13.9). Mutation proof: accepting any Payment, accepting several Payments, releasing for a losing request, and settling from any outstanding status each make the suites fail.
- Updated: `invDSettlementTruth` and `ops3FundraiserBatchProduction` (the transition moved), the `qbInvoice1aLegacyQuarantine`, `qbInvoice1bScope` and `qbInvoice1cScope` censuses, the `coordPolish1` / `coordShareCenterPolish2` working-tree ledgers, and `tests/helpers/quickbooksInvoiceFakes.ts` (Payment reads, credit memos, voids, a strict settlement write).
- Gates (September 21, 2026, local): full Jest 5,590 passing — the only failures are the 7 suites / 6 tests that fail identically on a fresh checkout of `4767422` (CRLF line endings and parked-schema assumptions); `tsc --noEmit` clean; `next build` exit 0 (191 pages) against a disposable migrated database; no dependency change.

### 13.9 Sandbox acceptance (Claude-run, September 21, 2026 — PASSED)

Sandbox company only; artificial data (`FreezerIQ 1C Acceptance -` and `FreezerIQ 1D Spike -` names). The harness and evidence live in the session scratchpad, outside git.

- **Spike, before any code.** Five sandbox invoices, six Payments (one later voided) and one credit memo established the shapes: an unpaid invoice returns `LinkedTxn: []`; a Payment appears on the invoice as `{TxnId, TxnType: 'Payment'}`; a Payment carries `Line[].Amount`, `Line[].LinkedTxn[{TxnId, TxnType: 'Invoice'}]`, `UnappliedAmt`, `CustomerRef`, `CurrencyRef` and `TxnDate`, and has no status field.
- **End to end through the candidate's code and the local database**, on the $451.59 fundraiser invoice the 1C acceptance sent through QuickBooks:
  1. Unpaid → `not_paid`: one Intuit call (`GET /invoice/{id}`); 69 of 69 local tables unchanged.
  2. The one sandbox write: a $451.59 Payment dated the day before the check, one line linking the invoice, under a `requestid`. QuickBooks then showed `Balance` 451.59 → 0 and one `LinkedTxn` of type `Payment`; the Payment showed `UnappliedAmt` 0.
  3. Check → `paid`: two Intuit calls (`GET /invoice/{id}`, `GET /payment/{id}`), no QuickBooks write, no token refresh. Locally only `invoices` changed: PAID, `quickbooks`, `paid_at` = the Payment's date at 12:00 UTC (deliberately not the day of the check), reference `QuickBooks payment <Id> · invoice #<DocNumber>`. The acceptance campaign has no orders, so the release matched none.
  4. Check again → `already_paid`: zero Intuit calls, zero local changes.
- **Real shapes through the 1D reads and rules:** two Payments → `multiple_payments`; a credit memo → `payment_includes_other_transactions`; an overpayment whose $50 leftover QuickBooks auto-applied to the customer's next invoice → `payment_includes_other_transactions`; that next invoice ($50 auto-applied, its own $100 Payment voided) → `partially_paid`, $50 due; one clean Payment → accepted. The clean Payment held against another invoice, another customer, or a total 1¢ lower → refused each time.
- **The moved transition on real Postgres** (a disposable, freshly migrated database, dropped afterwards): 22 of 22 checks — the winner releases exactly its campaign's held fundraiser orders (never a canceled order, another business's order, a non-fundraiser order or another campaign's); a replay changes nothing; SENT-only refuses an OVERDUE invoice that Record Payment's statuses still settle; a PAID source is refused before any write; the ordinary branch still promotes its own order; no loyalty row is written. In a real row-lock race, Record Payment arriving while a verified check held the row waited about 450 ms, re-read, and matched nothing — one settlement, one release.

Sandbox artifacts are left in place. The local acceptance invoice is now PAID via QuickBooks and, by design, cannot be undone in the app.

### 13.10 Release procedure

Code only, no migration, so it may deploy in any order relative to the database. Each step only with explicit owner authorization: owner review → commit on `qb-invoice-1d` → Preview → owner browser acceptance → release. QuickBooks is always disabled in Preview. In Production it is enabled with Freezer Chef connected, so the release makes the check available to Freezer Chef's admin for invoices sent through QuickBooks (none had been sent as of September 21, 2026).

Rolling the CODE back after a verified settlement exists is safe for the data but not neutral: the older settle route knows only the legacy rule, so it would again let a person Undo that settlement, and the invoices list would print the raw method `quickbooks`.

### 13.11 Not in QB-INVOICE-1D

Webhooks, polling or scheduled checks; partial or multi-payment settlement; credits, write-offs, refunds, voids or ACH returns; automatic un-pay or fulfilment rollback; card/ACH fees; deposits and bank reconciliation; the Payments API; any QuickBooks write.

---

## 14. QB-QBO-TAX-RESUME — Automated Sales Tax compatibility and the create-stage recheck

Candidate, September 22, 2026. Built on the released Production baseline `ec3d695` (QB-ORG-LINK-1). Code only: no migration, no schema change, no new dependency, no new Intuit call and no change to the OAuth scope.

**Why.** Freezer Chef's real QuickBooks company (Automated Sales Tax active, Illinois Department of Revenue, custom rates Tax Exempt 0% and Food 1%) stamps its own tax metadata onto every invoice — a transaction tax code, and in companies with their own rates a zero-value tax line — even on an invoice FreezerIQ creates with wholly non-taxable (`NON`) lines and no tax detail of its own. The 1C sandbox company uses legacy sales tax and returns a bare `TxnTaxDetail {TotalTax: 0}`, so the contract had been written as "QuickBooks holds NO tax metadata". The first real invoice (QuickBooks **#1026**) was created correctly, read back, and refused by that check alone: the money was right — total, every line and the balance passed — and the lifecycle stopped in `needs_review` with the QuickBooks invoice kept, which is exactly what it is designed to do when a check fails.

### 14.1 The tax invariant, corrected

The invariant is **QuickBooks' own tax did not affect this invoice's money** — not "QuickBooks has no tax metadata". The check is named for it: `quickbooks_tax_did_not_affect_total` (it replaces `no_quickbooks_tax`; a `problem_detail` recorded before this release still reads `no_quickbooks_tax`).

| QuickBooks returns | Result |
|---|---|
| no `TxnTaxDetail` at all | PASS |
| `TotalTax` 0, no tax lines | PASS |
| `TotalTax` 0 + `TxnTaxCodeRef` (Automated Sales Tax) | PASS |
| `TotalTax` 0 + one or more zero-value tax lines | PASS |
| `TotalTax` ≠ 0 | FAIL |
| zero `TotalTax` but any tax line amount ≠ 0 | FAIL |
| a tax amount that is not a whole number of cents | FAIL |
| tax detail that cannot be read (not an object, a non-numeric `TotalTax`, `TaxLine` not a list, a line whose `Amount` is not a number) | FAIL — closed, never read as "no tax" |

FreezerIQ remains authoritative for fundraiser tax and keeps carrying it as its own line against the tenant's mapped tax item; every other check is unchanged, so a native tax that moved the money still fails `total_equals_freezeriq_total` and `lines_sum_to_total` as well. Every comparison is in integer cents.

**Snapshot change** (`intuitClient.ts`): the allowlisted invoice snapshot now carries `taxLineAmounts` (each native tax line's amount, `null` when QuickBooks did not state it as a number) in place of `taxLineCount`, plus `taxDetailReadable`. `txnTaxCodeId` is unchanged and is used for diagnosis only. No raw payload is kept, and the tax facts are read only by the contract layer.

### 14.2 The create-stage recheck (the ONE repair)

`needs_review` stays terminal, with one exception: a lifecycle the **create-stage read-back** stopped on an invoice QuickBooks had already accepted. `recheckQuickBooksInvoiceCreate` is permitted only when ALL of these hold:

1. lifecycle status is `needs_review`;
2. its problem is `verification_failed_created`;
3. a durable invoice link exists;
4. the link already holds a `qbo_invoice_id`;
5. `create_requested_at` proves the create was dispatched;
6. the FreezerIQ invoice is still DRAFT;
7. `send_count` is 0 and `sent_at` is null;
8. the link belongs to the CURRENT live connection generation;
9. the caller passes `mayManageQuickBooks` (tenant ADMIN, as themselves, never View As).

It then takes the lease and does exactly one thing: **read the same QuickBooks invoice and re-run the complete create-stage contract.**

- **It matches** → the SAME lifecycle row returns to `created` (doc number, sync token, verification time recorded, the problem cleared) and the lease is released. Nothing is emailed: the owner finishes with the existing **Resume**, which continues through recipients → payment options → send exactly as before, from the stored review — Due-on-Receipt term, card and ACH as reviewed, the same QuickBooks invoice.
- **It does not match** → the lifecycle stays `needs_review`, now recording what failed this time. Nothing is sent.

**It can never create a QuickBooks invoice.** An existing `qbo_invoice_id` is a precondition checked before the lease; the repair body calls only the read; the session is marked `noCreate` and the create step throws `CreateForbiddenError` on such a session before touching the requestid or the body. Source-level and behavioural tests both prove it. A recheck issues no QuickBooks write of any kind.

**Product surface.** The stopped-send dialog offers one deliberate action, **"Recheck QuickBooks invoice"**, and only for this cause; every other stopped send offers nothing, and there is no general-purpose force-resume. The dialog says what it does: FreezerIQ re-reads the SAME QuickBooks invoice, no new invoice is created, nothing is emailed by the recheck, a match continues the normal send workflow (finished with Resume), and otherwise it stays stopped. `POST {"action":"recheck"}` on the invoice route, under the same guard as every other action.

### 14.3 Tests and evidence

`tests/qbInvoice1cContract.test.ts` (the zero-tax matrix, including a tax-exempt $0 invoice and the fail-closed shapes), `tests/qbInvoice1cIntuitClient.test.ts` (the snapshot's tax facts), `tests/qbInvoiceRecheck.test.ts` (eligibility, idempotency, concurrency, "no create", "no send", and an end-to-end send against a company that returns zero-value automated tax metadata), `tests/qbInvoice1cScope.test.ts` (source-level proof that the repair cannot create), `tests/qbInvoice1cViews.test.ts` (the wording and the single button) and `tests/qbInvoice1cRoutes.test.ts` (401 / 403 / 404 / 503 for the new action).

The fixtures are documented **representative Automated Sales Tax zero-tax patterns** in the `TaxLine` shape the Intuit Accounting API documents — not a captured Production payload. Production invoice #1026 was NOT read, refreshed, edited, sent, voided or deleted while this was built.

### 14.4 Acceptance for invoice #1026 (after release)

The lifecycle for that invoice is stopped at the create stage with the QuickBooks invoice recorded (QuickBooks id 319, DocNumber 1026), `send_count` 0, the FreezerIQ invoice still DRAFT — all nine conditions hold. After release the owner opens that invoice, chooses **Recheck QuickBooks invoice**, and expects: the same invoice re-read, the contract passing, the send returning to its post-create step, then **Resume** to finish it — invoice **#1026**, never a #1027.

### 14.5 Not in QB-QBO-TAX-RESUME

No change to what FreezerIQ sends (still `NON` lines and no tax detail), to the money rules, to 1C's stages or 1D's payment check; no repair for any other stopped state; no editing of a QuickBooks invoice; no reading or changing of a company's sales-tax setup.

---
