// Retired: discovery reviews read Google Apps Script directly.
export const onRequestGet = () => Response.json({
  error: "This discovery feedback route is retired. Use the configured Apps Script decisions-only reader."
}, { status: 410, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
