# FreezerIQ — QuickBooks Online Integration

**Status:** QB-INVOICE-1A **ACCEPTED / CLOSED** by the owner on September 13, 2026, after a successful live Intuit sandbox proof (§4). Sandbox OAuth foundation only: no QuickBooks customers, invoices or payment sync, and Production stays disabled.
**Scope of this document:** the connector's architecture and safety properties, the environment rules, the evidence behind them, and the compliance and readiness gaps that remain before Intuit production credentials may be requested.

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

**Deliberately absent:** customer mapping, QuickBooks customer or invoice creation, invoice schema linkage, Send via QuickBooks, payment flags, tax read-back, Record Payment `quickbooks`, webhooks, reconciliation, food release. A QuickBooks connection never releases fundraiser food (Fundraiser Fulfillment Contract HARD RULE 1, §14 amendment).

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
- **What is stored:** encrypted OAuth access and refresh tokens, the encrypted QuickBooks company (realm) id, token expiry times, and the FreezerIQ user id of the admin who connected or disconnected, with timestamps. The company name is not stored.
- **Where:** FreezerIQ's database (Supabase, US) accessed by FreezerIQ's application servers (Vercel, US).
- **Why:** to let the tenant's administrator connect their own QuickBooks company to FreezerIQ.
- **Consent:** the tenant administrator authorizes on Intuit's consent screen; they can disconnect at any time in FreezerIQ Settings or inside QuickBooks.
- **Retention and deletion:** on disconnect, tokens are revoked at Intuit and deleted from storage; a disconnect record (reason, time, encrypted company id) remains until the administrator chooses "Forget company". State what happens in backups.
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
