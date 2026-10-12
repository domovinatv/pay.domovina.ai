import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { buildReceiptPdf, wrapText, type PdfInput } from '../src/receipts/client/pdf';

/// The receipt PDF is built in the browser (no print dialog): same pure
/// function here over the same fonts.
const fontDir = join(__dirname, '..', 'src', 'receipts', 'client', 'fonts');
const fonts = {
  regular: new Uint8Array(readFileSync(join(fontDir, 'inter-400.ttf'))),
  semibold: new Uint8Array(readFileSync(join(fontDir, 'inter-600.ttf'))),
};

function input(rows: number): PdfInput {
  const payments = Array.from({ length: rows }, (_, i) => ({
    kind: (i === rows - 1 ? 'direct' : 'lazy') as 'direct' | 'lazy',
    order_id: `order-${i}`,
    tx_hash: `0x${String(i % 10).repeat(64)}`,
    amount_cents: 100 + i,
    placed_at: '2026-10-12T10:00:00Z',
    target_address: `0x${'4f'.repeat(20)}`,
    anchor: i % 2 ? { seq: 1, chain_head: `0x${'ab'.repeat(32)}`, ots_bitcoin: true } : null,
  }));
  const receipt = {
    version: 'mpt-receipt-v1',
    sid: 'r183ns4pcpn659hd2z3xtaqiwq',
    status: 'issued',
    intent: { label: 'Članarina — Lukavec, čćđšž ČĆĐŠŽ', target_address: `0x${'4f'.repeat(20)}` },
    payments,
    lazy_included: true,
  };
  return {
    receipt,
    owner: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    salt: '0x000102030405060708090a0b0c0d0e0f',
    canonicalJson: JSON.stringify({ intent: receipt.intent, payments }),
    statusText: 'Uplata još nije stigla.',
    generatedAt: '2026-10-12T12:00:00Z',
  };
}

describe('receipt PDF (browser, no print dialog)', () => {
  it('a 120-row receipt with ~30 KB of JSON builds fast into a multi-page PDF', async () => {
    const t0 = Date.now();
    const bytes = await buildReceiptPdf(input(120), fonts);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(2);
    expect(doc.getTitle()).toBe('Potvrda o uplati r183ns4pcpn659hd2z3xtaqiwq');
    // Whole fonts embedded (subset drops glyphs — see pdf.ts): two Inter files.
    expect(bytes.length).toBeGreaterThan(300_000);
  });

  it('a receipt without rows (still waiting) builds too', async () => {
    const i = input(0);
    const doc = await PDFDocument.load(await buildReceiptPdf({ ...i, owner: null, salt: null }, fonts));
    expect(doc.getPageCount()).toBe(1);
  });

  it('non-ASCII in the JSON is shown as \\u escapes that parse back to the same value', async () => {
    const { jsonAscii } = await import('../src/receipts/client/pdf');
    const json = JSON.stringify({ label: 'Članarina čćđšž — Lukavec' });
    expect(jsonAscii(json)).toMatch(/^[\x20-\x7e]+$/);
    expect(JSON.parse(jsonAscii(json))).toEqual(JSON.parse(json));
  });

  it('wrapping a long word stays within the width and loses no character', async () => {
    const doc = await PDFDocument.create();
    const { StandardFonts } = await import('pdf-lib');
    const mono = await doc.embedFont(StandardFonts.Courier);
    const word = 'x'.repeat(30_000);
    const t0 = Date.now();
    const lines = wrapText(word, mono, 6.5, 400);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(lines.join('')).toBe(word);
    expect(Math.max(...lines.map((l) => mono.widthOfTextAtSize(l, 6.5)))).toBeLessThanOrEqual(400);
  });
});
