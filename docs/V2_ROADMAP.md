# FreezerIQ V2.0 Roadmap

Future software upgrades planned for V2.0.

---

## PDF & Marketing Assets

### Server-Side PDF Generation
**Priority:** Medium · **Effort:** Medium

Replace the current client-side `html2canvas` + `jsPDF` PDF generation with a server-side approach for the Coordinator Packet and social media images.

**Current state (V1):**
- Client-side rendering via `html2canvas` → `jsPDF`
- Hidden DOM subtree uses inline hex/rgb colors to avoid Tailwind v4 `oklch()`/`lab()` incompatibility with `html2canvas`
- Works but depends on client browser font rendering and CSS support

**V2 upgrade:**
- Move to server-side PDF generation (`@react-pdf/renderer`, Puppeteer, or `pdf-lib`)
- Deterministic output regardless of client browser/OS
- Better support for advanced CSS (backdrop-filter, gradients, clip-path)
- Consistent font rendering across all coordinators
- Could pre-generate PDFs at campaign creation time for instant download

**Files affected:**
- `components/marketing/MarketingAssetGenerator.tsx` — refactor to call API route
- New: `app/api/marketing/generate-pdf/route.ts` — server-side PDF endpoint
- Remove: client-side `html2canvas` + `jsPDF` dependencies

---

*Add future V2.0 items below this line.*
