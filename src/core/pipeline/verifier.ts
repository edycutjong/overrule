/**
 * CitationVerifier — the fail-closed gate (COMPLEXITY §1 CITE node, §5
 * hallucination-catch metric; invariant I2). Deterministic byte-match:
 * every quoted clause must appear byte-for-byte in the cited source document,
 * AND inside the cited page segment. Any failure ⇒ the draft cannot ship.
 *
 * (Production adds a second-model judge pass on top; the byte-match core is
 * the part that can never be argued with.)
 */
import { hashCanonical } from '../canonical';
import { pageText } from '../docformat';
import type { AppealDraft, CitationReceipt, Clock } from '../types';

export interface DocStore {
  getDoc(docId: string): string | null;
}

export function makeDocStore(docs: Record<string, string>): DocStore {
  return { getDoc: (id) => docs[id] ?? null };
}

export function verifyCitations(draft: AppealDraft, docs: DocStore, clock: Clock): CitationReceipt {
  const failures: CitationReceipt['failures'] = [];
  draft.citations.forEach((c, index) => {
    if (!c.quote || c.quote.trim().length === 0) {
      failures.push({ index, reason: 'empty quote' });
      return;
    }
    const doc = docs.getDoc(c.doc_id);
    if (doc === null) {
      failures.push({ index, reason: `source document ${c.doc_id} not found` });
      return;
    }
    if (!doc.includes(c.quote)) {
      failures.push({ index, reason: `quote not present byte-for-byte in ${c.doc_id}` });
      return;
    }
    const page = pageText(doc, c.page);
    if (page === null) {
      failures.push({ index, reason: `page ${c.page} does not exist in ${c.doc_id}` });
      return;
    }
    if (!page.includes(c.quote)) {
      failures.push({ index, reason: `quote exists in ${c.doc_id} but not on cited page ${c.page}` });
    }
  });

  return {
    draft_hash: hashCanonical({ body: draft.body, citations: draft.citations }),
    checked: draft.citations.length,
    pass: failures.length === 0,
    failures,
    ts: clock.now(),
  };
}
