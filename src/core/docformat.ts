/**
 * Plain-text document paging convention used by the offline core.
 * Plan documents mark pages with `===== PAGE n =====`; the CitationVerifier
 * uses page segments so a right-quote-wrong-page citation still fails.
 * (Production PDFs carry real page structure via Gemini PDF ingestion —
 * deferred; this convention is the offline stand-in.)
 */

export function pageMarker(n: number): string {
  return `===== PAGE ${n} =====`;
}

/** Slice out one page's text (marker to next marker). 1-based; null if absent. */
export function pageText(doc: string, page: number): string | null {
  const start = doc.indexOf(pageMarker(page));
  if (start === -1) return null;
  const next = doc.indexOf('===== PAGE ', start + 1);
  return next === -1 ? doc.slice(start) : doc.slice(start, next);
}
