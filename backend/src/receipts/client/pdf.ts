/// Payment receipt as a PDF built in the browser (ADR 0022 §4): no print
/// dialog, no server, no network at click time. pdf-lib + fontkit + the Inter
/// fonts come in a separate bundle (/potvrda/pdf.js) the page loads on open.
///
/// Pattern taken from energy.domovina.ai lib/receipt-pdf.ts (same author):
/// Inter embedded (whole, see below) so Croatian letters render; hashes, addresses
/// and JSON in the built-in Courier (ASCII); text wrapping in one pass per line
/// (the first energy version was O(n²) and froze on a 74-row receipt).
///
/// Only the PUBLIC part goes into the PDF. The key (part B) never does: a PDF
/// is what gets sent around as proof, and whoever has the key has the right.
///
/// Pure function over font bytes, so it runs in vitest too.

import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import qrcode from 'qrcode-generator';

export interface PdfPayment {
  kind: 'direct' | 'lazy';
  order_id: string;
  tx_hash: string | null;
  amount_cents: number;
  placed_at: string | null;
  target_address?: string | null;
  anchor: null | { seq: number; chain_head: string; ots_bitcoin?: boolean };
}

export interface PdfReceipt {
  version: string;
  sid: string;
  status: string;
  intent: { label: string | null; target_address: string };
  payments: PdfPayment[];
  lazy_included: boolean;
}

export interface PdfInput {
  receipt: PdfReceipt;
  owner: string | null;
  salt: string | null;
  /// Canonical JSON of the public part, exactly as the JSON download.
  canonicalJson: string;
  /// Status sentence when there are no payment rows yet.
  statusText: string;
  generatedAt: string;
}

export interface PdfFonts {
  regular: Uint8Array;
  semibold: Uint8Array;
}

export const receiptPdfFileName = (sid: string) => `potvrda-o-uplati-${sid}.pdf`;

// A4 in points, 48 pt margins; DOMOVINA navy for headings.
const W = 595.28;
const H = 841.89;
const M = 48;
const CW = W - 2 * M;
const NAVY = rgb(0, 47 / 255, 108 / 255);
const INK = rgb(27 / 255, 35 / 255, 48 / 255);
const MUTED = rgb(91 / 255, 101 / 255, 119 / 255);
const RULE = rgb(217 / 255, 222 / 255, 231 / 255);

class Layout {
  page: PDFPage;
  y = H - M;
  constructor(private doc: PDFDocument) {
    this.page = doc.addPage([W, H]);
  }
  /// True when a new page was opened (the table then repeats its header).
  ensure(h: number): boolean {
    if (this.y - h < M + 24) {
      this.page = this.doc.addPage([W, H]);
      this.y = H - M;
      return true;
    }
    return false;
  }
}

/// Word wrap; an over-long "word" (hash, canonical JSON) breaks by characters.
/// Widths are summed in one pass: never re-measure the rest of a long word.
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  const cache = new Map<string, number>();
  const w = (c: string) => {
    let v = cache.get(c);
    if (v === undefined) {
      v = font.widthOfTextAtSize(c, size);
      cache.set(c, v);
    }
    return v;
  };
  const space = w(' ');
  for (const para of text.split('\n')) {
    let line = '';
    let lineW = 0;
    for (const word of para.split(' ')) {
      let ww = 0;
      for (const c of word) ww += w(c);
      const add = line ? space + ww : ww;
      if (lineW + add <= width) {
        line += (line ? ' ' : '') + word;
        lineW += add;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      lineW = 0;
      if (ww <= width) {
        line = word;
        lineW = ww;
        continue;
      }
      let chunk = '';
      let chunkW = 0;
      for (const c of word) {
        const cw = w(c);
        if (chunkW + cw > width && chunk) {
          lines.push(chunk);
          chunk = '';
          chunkW = 0;
        }
        chunk += c;
        chunkW += cw;
      }
      line = chunk;
      lineW = chunkW;
    }
    lines.push(line);
  }
  return lines;
}

/// Courier (built-in) is WinAnsi only. JSON shown in it escapes everything
/// outside printable ASCII as \uXXXX — the same JSON value; the exact bytes are
/// the separate JSON download.
export const jsonAscii = (json: string) =>
  json.replace(/[^\x20-\x7e\n]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const eur = (cents: number) =>
  `${(cents / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')} EUR`;
const short = (h: string | null | undefined) => (h ? `${h.slice(0, 8)}…${h.slice(-4)}` : '—');
const date = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}. ${p(d.getUTCMonth() + 1)}. ${d.getUTCFullYear()}. ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
};

export async function buildReceiptPdf(input: PdfInput, fonts: PdfFonts): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // Full fonts, NOT subset: pdf-lib + fontkit 1.1.1 subsetting drops most of
  // Inter's glyphs (the text layer stays right, so text-extraction tests pass
  // while the page shows only a few letters). ~170 KB per font in the PDF.
  const reg = await doc.embedFont(fonts.regular, { subset: false });
  const bold = await doc.embedFont(fonts.semibold, { subset: false });
  const mono = await doc.embedFont(StandardFonts.Courier);
  const { receipt: rc } = input;
  doc.setTitle(`Potvrda o uplati ${rc.sid}`);
  doc.setSubject('MPT potvrda o uplati (ADR 0022)');
  doc.setProducer('MPT · pdf-lib');
  doc.setCreationDate(new Date(input.generatedAt));

  const L = new Layout(doc);
  const text = (s: string, x: number, size: number, font: PDFFont, color = INK) =>
    L.page.drawText(s, { x, y: L.y, size, font, color });
  const para = (s: string, size: number, font: PDFFont, color = INK, x = M, width = CW, lead = 1.35) => {
    for (const line of wrapText(s, font, size, width)) {
      L.ensure(size * lead);
      L.y -= size * lead;
      text(line, x, size, font, color);
    }
  };
  const heading = (s: string) => {
    L.ensure(40);
    L.y -= 22;
    text(s, M, 13, bold, NAVY);
    L.y -= 6;
  };

  // Title
  L.y -= 22;
  text('Potvrda o uplati', M, 22, bold, NAVY);
  L.y -= 16;
  text(`MPT · ${rc.version}`, M, 9, reg, MUTED);
  L.y -= 10;
  L.page.drawRectangle({ x: M, y: L.y, width: CW, height: 2, color: NAVY });
  L.y -= 6;

  // Fields
  const total = rc.payments.reduce((s, p) => s + p.amount_cents, 0);
  const fields: Array<[string, string, PDFFont]> = [
    ['Referenca (sid)', rc.sid, mono],
    ['Namjena', rc.intent.label ?? '—', reg],
    ['Primatelj (Gnosis)', rc.intent.target_address, mono],
    ['Ukupno potvrđeno', rc.payments.length ? eur(total) : '—', bold],
    ['Vlasnik potvrde', input.owner ?? '— (ključ nije učitan)', input.owner ? mono : reg],
  ];
  for (const [k, v, f] of fields) {
    const lines = wrapText(v, f, 9.5, CW - 130);
    L.ensure(14 * lines.length + 4);
    L.y -= 15;
    text(k, M, 9.5, reg, MUTED);
    lines.forEach((line, i) => {
      if (i > 0) L.y -= 12;
      text(line, M + 130, 9.5, f);
    });
  }

  // Payments
  heading(`Uplate (${rc.payments.length})`);
  if (rc.payments.length === 0) {
    para(input.statusText, 10, reg);
  } else {
    const cols = [
      { h: 'Datum', x: M, w: 92 },
      { h: 'Iznos', x: M + 94, w: 62 },
      { h: 'Vrsta', x: M + 160, w: 92 },
      { h: 'Primatelj', x: M + 254, w: 88 },
      { h: 'Gnosis tx', x: M + 344, w: 88 },
      { h: 'Sidro', x: M + 434, w: 65 },
    ];
    const header = () => {
      L.y -= 14;
      for (const c of cols) text(c.h, c.x, 8.5, bold, MUTED);
      L.y -= 5;
      L.page.drawLine({ start: { x: M, y: L.y }, end: { x: M + CW, y: L.y }, thickness: 0.6, color: RULE });
    };
    header();
    for (const p of rc.payments) {
      if (L.ensure(16)) header();
      L.y -= 13;
      text(date(p.placed_at), cols[0].x, 8, reg);
      const a = eur(p.amount_cents);
      text(a, cols[1].x + cols[1].w - reg.widthOfTextAtSize(a, 8) - 4, 8, reg);
      text(p.kind === 'direct' ? 'Izravna (ključ)' : 'Naknadna (IBAN)', cols[2].x, 8, p.kind === 'direct' ? bold : reg);
      text(short(p.target_address ?? null), cols[3].x, 7.5, mono);
      text(short(p.tx_hash), cols[4].x, 7.5, mono);
      text(p.anchor ? `#${p.anchor.seq}${p.anchor.ots_bitcoin ? ' BTC' : ''}` : 'čeka', cols[5].x, 8, reg, p.anchor ? INK : MUTED);
    }
    if (!rc.lazy_included) {
      L.y -= 4;
      para('Naknadno pokrivene uplate vidi samo vlasnik ključa.', 8.5, reg, MUTED);
    }
  }

  // Verification
  heading('Kako provjeriti bez MPT-a');
  const steps = [
    'keccak256("MPT-RECEIPT-v1" || vlasnik (20 B) || salt (16 B)), prvih 120 bitova u base32 (abeceda abcdefghijkmnpqrstuvwxyz23456789) s prefiksom "r1", mora dati referencu.',
    'Svaki redak je list Merkle stabla; dokaz i korijen su u JSON-u na kraju. Sidro veže korijen uz sva prethodna sidra (chain_head), a sha256(chain_head) je žigosan na Bitcoinu (OpenTimestamps; BTC = dokaz s Bitcoin atestacijom je u JSON-u).',
    'Sve to provjerava scripts/mpt_receipt_verify.py (repo pay.domovina.ai, samo Python standardna biblioteka); javna kopija sidara: github.com/domovinatv/mpt-receipts-checkpoints.',
    'Vlasnik dokazuje da je on uplatitelj potpisom nasumične poruke ključem potvrde. Ključ NIJE u ovom PDF-u.',
  ];
  steps.forEach((s, i) => para(`${i + 1}. ${s}`, 9, reg, INK, M, CW));
  if (input.salt) {
    L.y -= 4;
    para(`salt: ${input.salt}`, 8.5, mono);
  }

  // QR: sid, owner, salt (vector modules)
  if (input.owner && input.salt) {
    const qr = qrcode(0, 'M');
    qr.addData(JSON.stringify({ v: 1, sid: rc.sid, owner: input.owner.toLowerCase(), salt: input.salt }));
    qr.make();
    const n = qr.getModuleCount();
    const size = 120;
    const cell = size / n;
    L.ensure(size + 30);
    L.y -= size + 12;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) {
          L.page.drawRectangle({ x: M + c * cell, y: L.y + size - (r + 1) * cell, width: cell + 0.05, height: cell + 0.05, color: rgb(0, 0, 0) });
        }
      }
    }
    L.page.drawText('QR: referenca, vlasnik i salt.', { x: M + size + 14, y: L.y + size / 2, size: 8.5, font: reg, color: MUTED });
  }

  // Canonical JSON
  heading('Potvrda (kanonski JSON)');
  if (/[^\x20-\x7e]/.test(input.canonicalJson)) {
    para('Znakovi izvan ASCII-ja prikazani su kao \\uXXXX (isti JSON); točan tekst je u preuzetoj JSON datoteci.', 8, reg, MUTED);
  }
  para(jsonAscii(input.canonicalJson), 6.5, mono, INK, M, CW, 1.25);

  // Footer on every page
  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    pg.drawText(`MPT potvrda o uplati · ${rc.sid} · izrađeno ${input.generatedAt} u pregledniku · ${i + 1}/${pages.length}`, {
      x: M, y: M - 20, size: 7, font: reg, color: MUTED,
    });
  });
  return doc.save();
}
