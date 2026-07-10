/**
 * printRecipe — browser-only recipe print helper.
 * Opens a small popup window with clean printable HTML and triggers window.print().
 * Respects VIEW_FINANCIALS: cost values only print when calculated_cost is non-null.
 */

function esc(str: unknown): string {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function printRecipe(recipe: any): void {
    if (!recipe) return;

    const cost: number | null = recipe.calculated_cost != null ? Number(recipe.calculated_cost) : null;
    const yieldQty: number = Number(recipe.base_yield_qty ?? 0);
    const yieldUnit: string = recipe.base_yield_unit ?? '';

    const perServing: number | null =
        cost != null && yieldQty > 0 && /serv/i.test(yieldUnit)
            ? cost / yieldQty
            : null;

    const categories: string = (recipe.categories ?? [])
        .map((c: any) => esc(c.name))
        .join(' · ');

    // ── Ingredient rows ────────────────────────────────────────────────────────
    const ingredientRows: string = (recipe.child_items ?? [])
        .map((item: any) => {
            const name = item.child_recipe
                ? `↳ ${esc(item.child_recipe.name)}`
                : esc(item.child_ingredient?.name ?? '—');
            const qty = `${esc(item.quantity)} ${esc(item.unit ?? '')}`.trim();
            return `<tr>
                <td style="padding:4px 8px 4px 0;font-size:13px;color:#374151;">${name}</td>
                <td style="padding:4px 0;font-size:13px;color:#6b7280;text-align:right;white-space:nowrap;">${qty}</td>
            </tr>`;
        })
        .join('');

    // ── Cost block (only if financials available) ──────────────────────────────
    const costBlock: string = cost != null
        ? `<div style="margin-top:16px;background:#f0fdf4;border-radius:8px;padding:12px 16px;display:flex;gap:24px;">
            <div>
                <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;">Cost / Batch</div>
                <div style="font-size:18px;font-weight:900;color:#059669;">$${Number(cost).toFixed(2)}</div>
            </div>
            ${perServing != null ? `<div>
                <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;">Cost / Serving</div>
                <div style="font-size:18px;font-weight:900;color:#059669;">$${perServing.toFixed(2)}</div>
            </div>` : ''}
        </div>`
        : '';

    // ── Instructions block ─────────────────────────────────────────────────────
    const instructionsBlock: string = recipe.instructions
        ? `<h3 style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#9ca3af;margin:20px 0 6px;">Kitchen Prep</h3>
           <p style="font-size:13px;line-height:1.7;color:#374151;white-space:pre-wrap;">${esc(recipe.instructions)}</p>`
        : '';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${esc(recipe.name)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 32px; color: #111827; }
  @media print { body { padding: 16px; } button { display:none !important; } }
  table { width: 100%; border-collapse: collapse; }
</style>
</head>
<body>
  ${categories ? `<p style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#6366f1;margin:0 0 6px;">${categories}</p>` : ''}
  <h1 style="font-size:28px;font-weight:900;margin:0 0 4px;color:#111827;">${esc(recipe.name)}</h1>
  <p style="font-size:13px;color:#6b7280;margin:0 0 16px;">
    Yield: <strong>${esc(yieldQty || '—')} ${esc(yieldUnit)}</strong>
  </p>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin-bottom:16px;" />

  <h3 style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#9ca3af;margin:0 0 8px;">Ingredients</h3>
  ${ingredientRows
        ? `<table>${ingredientRows}</table>`
        : '<p style="font-size:13px;color:#9ca3af;">No ingredients listed.</p>'
    }

  ${costBlock}
  ${instructionsBlock}

  <div style="margin-top:32px;text-align:center;">
    <button onclick="window.print()" style="background:#4f46e5;color:white;border:none;padding:10px 28px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;">
      🖨 Print
    </button>
  </div>
</body>
</html>`;

    try {
        const win = window.open('', '_blank', 'width=620,height=800,scrollbars=yes');
        if (!win) {
            // Popup blocked — no-op (browser already shows a notification to the user)
            console.warn('[printRecipe] Popup was blocked. Allow popups for this site to print recipes.');
            return;
        }
        win.document.open();
        win.document.write(html);
        win.document.close();
        // Small delay lets images/styles settle before the print dialog opens
        win.setTimeout(() => win.print(), 300);
    } catch (err) {
        console.error('[printRecipe] Failed to open print window:', err);
    }
}
