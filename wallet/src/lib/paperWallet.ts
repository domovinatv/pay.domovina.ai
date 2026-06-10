// Paper-wallet PDF generator — 100% client-side/offline (canvas → JPEG → a
// hand-rolled PDF; no network, no new dependencies). Plaintext BY DESIGN: a
// paper wallet is an offline artifact the user prints and stores — a
// passkey-encrypted file was rejected because it would be undecryptable in
// exactly the lost-passkey scenario it exists for.
//
// TWO-SIDED: every PDF has two pages meant to be printed on two sheets (or
// duplex) and laminated back-to-back:
//   page 1 — PUBLIC side: address + QR, freely shareable (receive card)
//   page 2 — PRIVATE side: the 12-word seed, with a marked zone to cover
//            with an opaque safety sticker after laminating
//
// Two print formats:
//   'a4'    — 210×297 mm portrait, classic document print
//   'photo' — 15×10 cm (6×4") landscape @300dpi, the native media of DNP
//             dye-sublimation photo printers — prints like a real photograph
//
// Branding follows the mediakit (/mediakit.domovina.tv): the family "D" mark
// (vertical Croatian-flag fill + product symbol), navy #002F6C / red #FF0000
// palette, tricolor stripe. Tenant name/domain come from brand config; the
// "D" mark itself is the DOMOVINA family mark.

import QRCodeStyling from 'qr-code-styling';
import { brand } from '../app/brand';

export type PaperWalletFormat = 'a4' | 'photo';

const NAVY = '#002F6C';
const RED = '#FF0000';
const MUTED = '#5A6570';
const CELL_BORDER = '#C9D4E5';

const FONT_SANS = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const FONT_MONO = 'ui-monospace, Menlo, Consolas, monospace';

// ── DOMOVINA family "D" mark (paths verbatim from mediakit domovina_wallet_logo_square.svg, 512×512 viewBox)
const D_OUTER = 'M72 64H248C354.071 64 440 149.929 440 256C440 362.071 354.071 448 248 448H72V64Z';
const D_INNER = 'M168 160H248C301.019 160 344 202.981 344 256C344 309.019 301.019 352 248 352H168V160Z';

function drawLogo(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const s = size / 512;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  // white rounded tile
  ctx.fillStyle = '#FFFFFF';
  roundRectPath(ctx, 0, 0, 512, 512, 32);
  ctx.fill();
  ctx.strokeStyle = CELL_BORDER;
  ctx.lineWidth = 2;
  ctx.stroke();
  // "D" with vertical flag gradient (hard stops at thirds)
  const grad = ctx.createLinearGradient(0, 64, 0, 448);
  grad.addColorStop(0, RED);
  grad.addColorStop(1 / 3, RED);
  grad.addColorStop(1 / 3, '#FFFFFF');
  grad.addColorStop(2 / 3, '#FFFFFF');
  grad.addColorStop(2 / 3, NAVY);
  grad.addColorStop(1, NAVY);
  ctx.fillStyle = grad;
  ctx.fill(new Path2D(D_OUTER));
  // inner white "D" (negative space)
  ctx.fillStyle = '#FFFFFF';
  ctx.fill(new Path2D(D_INNER));
  // wallet symbol
  ctx.fillStyle = NAVY;
  roundRectPath(ctx, 180, 200, 152, 112, 14);
  ctx.fill();
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(194, 228);
  ctx.lineTo(318, 228);
  ctx.stroke();
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(302, 270, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = NAVY;
  ctx.beginPath();
  ctx.arc(302, 270, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function tricolorStripe(ctx: CanvasRenderingContext2D, y: number, w: number, bandH: number) {
  ctx.fillStyle = RED;
  ctx.fillRect(0, y, w, bandH);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, y + bandH, w, bandH);
  ctx.strokeStyle = CELL_BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(0, y + bandH, w, bandH);
  ctx.fillStyle = NAVY;
  ctx.fillRect(0, y + 2 * bandH, w, bandH);
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const probe = line ? `${line} ${w}` : w;
    if (ctx.measureText(probe).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = probe;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** 12-word grid; returns total height. Caller positions the sticker zone. */
function drawSeedGrid(
  ctx: CanvasRenderingContext2D,
  words: string[],
  x: number,
  y: number,
  totalW: number,
  cols: number,
  cellH: number,
  gap: number,
  numFontPx: number,
  wordFontPx: number,
): number {
  const cellW = (totalW - (cols - 1) * gap) / cols;
  words.forEach((word, i) => {
    const cx = x + (i % cols) * (cellW + gap);
    const cy = y + Math.floor(i / cols) * (cellH + gap);
    ctx.strokeStyle = CELL_BORDER;
    ctx.lineWidth = 3;
    roundRectPath(ctx, cx, cy, cellW, cellH, Math.min(20, cellH / 6));
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.font = `400 ${numFontPx}px ${FONT_SANS}`;
    ctx.fillText(String(i + 1), cx + cellW * 0.05 + 10, cy + cellH * 0.63);
    ctx.fillStyle = NAVY;
    ctx.font = `700 ${wordFontPx}px ${FONT_MONO}`;
    ctx.fillText(word, cx + cellW * 0.05 + 10 + numFontPx * 2, cy + cellH * 0.65);
  });
  const rows = Math.ceil(words.length / cols);
  return rows * cellH + (rows - 1) * gap;
}

/** Dashed outline marking where the opaque safety sticker goes (applied OVER
 * the laminate — peel to reveal the seed). */
function drawStickerZone(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  ctx.save();
  ctx.strokeStyle = MUTED;
  ctx.lineWidth = 3;
  ctx.setLineDash([18, 14]);
  roundRectPath(ctx, x, y, w, h, 26);
  ctx.stroke();
  ctx.restore();
}

/** Address QR as an ImageBitmap (navy modules on white, M error correction —
 * matches the in-app Receive QR styling). */
async function addressQrBitmap(address: string, sizePx: number): Promise<ImageBitmap | null> {
  try {
    const qr = new QRCodeStyling({
      width: sizePx,
      height: sizePx,
      data: address,
      qrOptions: { errorCorrectionLevel: 'M' },
      dotsOptions: { color: NAVY, type: 'square' },
      backgroundOptions: { color: '#ffffff' },
    });
    const blob = (await qr.getRawData('png')) as Blob | null;
    if (!blob) return null;
    return await createImageBitmap(blob);
  } catch (e) {
    console.warn('[paperWallet] QR generation failed — rendering without QR', e);
    return null;
  }
}

type RenderInput = {
  safeAddress: string;
  words: string[];
  date: string;
  qr: ImageBitmap | null;
};

function newCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  return [canvas, ctx];
}

// ── A4 portrait, 300dpi: 2480×3508 ──────────────────────────────────────────

function a4Header(ctx: CanvasRenderingContext2D, M: number, subtitle: string, subColor: string) {
  tricolorStripe(ctx, 0, 2480, 16);
  drawLogo(ctx, M, 140, 250);
  ctx.fillStyle = NAVY;
  ctx.font = `700 116px ${FONT_SANS}`;
  ctx.fillText(brand.name, M + 310, 255);
  ctx.fillStyle = subColor;
  ctx.font = `600 56px ${FONT_SANS}`;
  ctx.fillText(subtitle, M + 310, 345);
}

function a4Footer(ctx: CanvasRenderingContext2D, M: number, H: number) {
  ctx.fillStyle = MUTED;
  ctx.font = `400 40px ${FONT_SANS}`;
  ctx.fillText(`${brand.domain}   ·   Self-custody — ključ je 100% tvoj`, M, H - 130);
  tricolorStripe(ctx, H - 48, 2480, 16);
}

/** A4 page 1 — PUBLIC: big receive QR + address. Freely shareable. */
function renderA4Public(input: RenderInput): HTMLCanvasElement {
  const W = 2480;
  const H = 3508;
  const M = 180;
  const [canvas, ctx] = newCanvas(W, H);

  a4Header(ctx, M, 'JAVNA STRANA · ADRESA ZA UPLATE', MUTED);
  ctx.fillStyle = MUTED;
  ctx.font = `400 44px ${FONT_SANS}`;
  ctx.fillText(
    `Kreirano: ${input.date}   ·   Mreža: Gnosis Chain (EVM, chain ID 100)   ·   Safe v1.4.1`,
    M,
    505,
  );

  // Big centered QR
  const qrSize = 1240;
  const box = qrSize + 80;
  const bx = (W - box) / 2;
  const by = 640;
  ctx.strokeStyle = CELL_BORDER;
  ctx.lineWidth = 4;
  ctx.strokeRect(bx, by, box, box);
  if (input.qr) ctx.drawImage(input.qr, bx + 40, by + 40, qrSize, qrSize);

  ctx.textAlign = 'center';
  ctx.fillStyle = NAVY;
  ctx.font = `700 72px ${FONT_MONO}`;
  const half = Math.ceil(input.safeAddress.length / 2);
  ctx.fillText(input.safeAddress.slice(0, half), W / 2, by + box + 150);
  ctx.fillText(input.safeAddress.slice(half), W / 2, by + box + 245);

  ctx.font = `700 56px ${FONT_SANS}`;
  ctx.fillText('Skeniraj i pošalji EURe · Gnosis Chain', W / 2, by + box + 400);
  ctx.fillStyle = MUTED;
  ctx.font = `400 46px ${FONT_SANS}`;
  ctx.fillText(
    'Ova strana je JAVNA — slobodno je dijeli, fotografiraj ili pošalji uplatitelju.',
    W / 2,
    by + box + 490,
  );
  ctx.fillStyle = RED;
  ctx.font = `600 44px ${FONT_SANS}`;
  ctx.fillText(
    'Druga strana sadrži privatni recovery seed — nju nikad ne dijeli.',
    W / 2,
    by + box + 600,
  );
  ctx.textAlign = 'left';

  a4Footer(ctx, M, H);
  return canvas;
}

/** A4 page 2 — PRIVATE: seed grid + sticker zone + restore instructions. */
function renderA4Private(input: RenderInput): HTMLCanvasElement {
  const W = 2480;
  const H = 3508;
  const M = 180;
  const [canvas, ctx] = newCanvas(W, H);

  a4Header(ctx, M, 'PRIVATNA STRANA · RECOVERY SEED — SAKRIJ OVU STRANU', RED);

  // Warning box
  const warnY = 480;
  const warnH = 270;
  ctx.fillStyle = '#FFF5F5';
  roundRectPath(ctx, M, warnY, W - 2 * M, warnH, 24);
  ctx.fill();
  ctx.strokeStyle = RED;
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.fillStyle = NAVY;
  ctx.font = `700 48px ${FONT_SANS}`;
  ctx.fillText('ČUVAJ OVO KAO GOTOVINU.', M + 50, warnY + 85);
  ctx.font = `400 44px ${FONT_SANS}`;
  const warnLines = wrapText(
    ctx,
    'Tko ima ovih 12 riječi, ima potpunu kontrolu nad sredstvima — u bilo kojem walletu, bez aplikacije i bez lozinke. Spremi offline; ne šalji mailom, ne slikaj u galeriju, ne drži u cloudu.',
    W - 2 * M - 100,
  );
  warnLines.forEach((l, i) => ctx.fillText(l, M + 50, warnY + 155 + i * 56));

  // Owner address (so the buried sheet is self-contained)
  let y = 940;
  ctx.fillStyle = MUTED;
  ctx.font = `400 42px ${FONT_SANS}`;
  ctx.fillText('PRIPADA ADRESI (vidi javnu stranu):', M, y);
  ctx.fillStyle = NAVY;
  ctx.font = `700 52px ${FONT_MONO}`;
  ctx.fillText(input.safeAddress, M, y + 75);

  // Seed grid inside the sticker zone
  y = 1180;
  ctx.fillStyle = NAVY;
  ctx.font = `700 52px ${FONT_SANS}`;
  ctx.fillText('RECOVERY SEED — 12 RIJEČI (REDOSLIJED JE BITAN)', M, y);
  const gy = y + 70;
  const gridH = drawSeedGrid(ctx, input.words, M, gy, W - 2 * M, 3, 160, 36, 36, 60);
  drawStickerZone(ctx, M - 45, gy - 45, W - 2 * M + 90, gridH + 90);
  ctx.fillStyle = MUTED;
  ctx.font = `400 42px ${FONT_SANS}`;
  const stickerLines = wrapText(
    ctx,
    'Iscrtkano područje: nakon laminiranja prelijepi ga neprozirnom sigurnosnom naljepnicom — seed ostaje skriven i vidljiv je tek kad se naljepnica fizički ukloni.',
    W - 2 * M - 60,
  );
  stickerLines.forEach((l, i) => ctx.fillText(l, M, gy + gridH + 140 + i * 56));

  // Restore instructions
  y = gy + gridH + 140 + stickerLines.length * 56 + 110;
  ctx.fillStyle = NAVY;
  ctx.font = `700 52px ${FONT_SANS}`;
  ctx.fillText('KAKO VRATITI PRISTUP', M, y);
  ctx.font = `400 44px ${FONT_SANS}`;
  const steps = [
    '1.  Safe Mobile (iOS/Android) ili app.safe.global: uvezi seed kao potpisnika (signer), zatim učitaj Safe po adresi iznad.',
    '2.  MetaMask (desktop): Uvezi račun → Tajna fraza za oporavak (SRP), pa upravljaj Safe-om kroz app.safe.global.',
    `3.  Seed je 1-od-2 vlasnik — ${brand.name} passkey i dalje radi neovisno o njemu.`,
  ];
  let sy = y + 80;
  for (const step of steps) {
    const lines = wrapText(ctx, step, W - 2 * M - 60);
    lines.forEach((l, j) => ctx.fillText(j === 0 ? l : '     ' + l, M, sy + j * 58));
    sy += lines.length * 58 + 28;
  }

  a4Footer(ctx, M, H);
  return canvas;
}

// ── 15×10 cm (6×4") landscape, 300dpi: 1800×1200 — DNP photo media ──────────

function photoHeader(ctx: CanvasRenderingContext2D, M: number, title: string, date: string) {
  ctx.fillStyle = NAVY;
  ctx.fillRect(0, 0, 1800, 150);
  drawLogo(ctx, M, 25, 100);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 56px ${FONT_SANS}`;
  ctx.fillText(title, M + 135, 95);
  ctx.font = `400 34px ${FONT_SANS}`;
  ctx.textAlign = 'right';
  ctx.fillText(date, 1800 - M, 92);
  ctx.textAlign = 'left';
}

/** Photo page 1 — PUBLIC: receive QR + address (shareable photo card). */
function renderPhotoPublic(input: RenderInput): HTMLCanvasElement {
  const W = 1800;
  const H = 1200;
  const M = 90; // generous safe margin: borderless photo printers crop edges
  const [canvas, ctx] = newCanvas(W, H);

  photoHeader(ctx, M, `${brand.name} — javna strana`, input.date);

  const qrSize = 700;
  const qrY = 215;
  ctx.strokeStyle = CELL_BORDER;
  ctx.lineWidth = 3;
  ctx.strokeRect(M, qrY, qrSize + 36, qrSize + 36);
  if (input.qr) ctx.drawImage(input.qr, M + 18, qrY + 18, qrSize, qrSize);

  const colX = M + qrSize + 110;
  ctx.fillStyle = NAVY;
  ctx.font = `700 44px ${FONT_MONO}`;
  const half = Math.ceil(input.safeAddress.length / 2);
  ctx.fillText(input.safeAddress.slice(0, half), colX, 350);
  ctx.fillText(input.safeAddress.slice(half), colX, 410);
  ctx.font = `700 46px ${FONT_SANS}`;
  ctx.fillText('Skeniraj i pošalji EURe', colX, 540);
  ctx.fillStyle = MUTED;
  ctx.font = `400 34px ${FONT_SANS}`;
  ctx.fillText('Gnosis Chain (EVM, chain ID 100) · Safe', colX, 605);
  ctx.fillText('Ova strana je javna — slobodno je dijeli.', colX, 660);
  ctx.fillStyle = RED;
  ctx.font = `600 34px ${FONT_SANS}`;
  ctx.fillText('Seed je na drugoj strani — nju sakrij.', colX, 745);

  ctx.fillStyle = MUTED;
  ctx.font = `400 28px ${FONT_SANS}`;
  ctx.fillText(`${brand.domain} · Self-custody — ključ je 100% tvoj`, M, H - 60);
  tricolorStripe(ctx, H - 24, W, 8);
  return canvas;
}

/** Photo page 2 — PRIVATE: seed grid + sticker zone. */
function renderPhotoPrivate(input: RenderInput): HTMLCanvasElement {
  const W = 1800;
  const H = 1200;
  const M = 90;
  const [canvas, ctx] = newCanvas(W, H);

  photoHeader(ctx, M, 'RECOVERY SEED — privatna strana', input.date);

  const gy = 280;
  const gridH = drawSeedGrid(ctx, input.words, M, gy, W - 2 * M, 4, 160, 20, 26, 42);
  drawStickerZone(ctx, M - 30, gy - 30, W - 2 * M + 60, gridH + 60);
  ctx.fillStyle = MUTED;
  ctx.font = `400 30px ${FONT_SANS}`;
  ctx.fillText(
    'Nakon laminiranja prelijepi iscrtkano područje neprozirnom sigurnosnom naljepnicom.',
    M,
    gy + gridH + 90,
  );

  ctx.fillStyle = NAVY;
  ctx.font = `700 32px ${FONT_MONO}`;
  ctx.fillText(`Pripada adresi: ${input.safeAddress}`, M, gy + gridH + 165);

  ctx.fillStyle = RED;
  ctx.font = `700 32px ${FONT_SANS}`;
  ctx.fillText(
    'ČUVAJ KAO GOTOVINU — tko ima ovih 12 riječi, kontrolira sredstva.',
    M,
    H - 105,
  );
  ctx.fillStyle = MUTED;
  ctx.font = `400 28px ${FONT_SANS}`;
  ctx.fillText(
    `${brand.domain} · uvoz: Safe Mobile / MetaMask / app.safe.global · seed je 1-od-2 vlasnik`,
    M,
    H - 60,
  );
  tricolorStripe(ctx, H - 24, W, 8);
  return canvas;
}

// ── Minimal multi-page PDF with embedded JPEGs (DCTDecode) ───────────────────
// Hand-rolled to stay dependency-free: catalog → pages → per page {page,
// image XObject, content stream painting the image across the MediaBox}.
type PdfPageImage = { jpeg: Uint8Array; w: number; h: number };

function buildPdfWithJpegPages(pages: PdfPageImage[], pageWPt: number, pageHPt: number): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const offsets: number[] = [];
  const push = (part: string | Uint8Array) => {
    const b = typeof part === 'string' ? enc.encode(part) : part;
    chunks.push(b);
    offset += b.length;
  };

  // Object ids: 1=catalog, 2=pages, then per page i: page=3+3i, image=4+3i, contents=5+3i
  const n = pages.length;
  const kids = pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ');

  push('%PDF-1.4\n');
  offsets[1] = offset;
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offsets[2] = offset;
  push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);

  pages.forEach((p, i) => {
    const pageId = 3 + 3 * i;
    const imgId = 4 + 3 * i;
    const contId = 5 + 3 * i;
    const content = `q ${pageWPt} 0 0 ${pageHPt} 0 0 cm /Im${i} Do Q\n`;
    offsets[pageId] = offset;
    push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWPt} ${pageHPt}] ` +
        `/Resources << /XObject << /Im${i} ${imgId} 0 R >> /ProcSet [/PDF /ImageC] >> /Contents ${contId} 0 R >>\nendobj\n`,
    );
    offsets[imgId] = offset;
    push(
      `${imgId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
    );
    push(p.jpeg);
    push('\nendstream\nendobj\n');
    offsets[contId] = offset;
    push(`${contId} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
  });

  const maxId = 2 + 3 * n;
  const xrefStart = offset;
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxId; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('canvas.toBlob failed'));
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      },
      'image/jpeg',
      0.95,
    );
  });
}

/** Render both sides to 300dpi canvases — exported for previews/tests. */
export async function renderPaperWalletCanvases(
  safeAddress: string,
  seed: string,
  format: PaperWalletFormat,
): Promise<{ publicSide: HTMLCanvasElement; privateSide: HTMLCanvasElement }> {
  const input: RenderInput = {
    safeAddress,
    words: seed.split(/\s+/),
    date: new Date().toISOString().slice(0, 10),
    qr: await addressQrBitmap(safeAddress, 1400),
  };
  return format === 'a4'
    ? { publicSide: renderA4Public(input), privateSide: renderA4Private(input) }
    : { publicSide: renderPhotoPublic(input), privateSide: renderPhotoPrivate(input) };
}

/** Generate the two-sided paper-wallet PDF (page 1 public, page 2 private)
 * and trigger a download. Throws on failure so the caller can keep its
 * backup gating honest. */
export async function downloadPaperWalletPdf(
  safeAddress: string,
  seed: string,
  format: PaperWalletFormat,
): Promise<void> {
  const { publicSide, privateSide } = await renderPaperWalletCanvases(safeAddress, seed, format);
  const pages: PdfPageImage[] = [
    { jpeg: await canvasToJpeg(publicSide), w: publicSide.width, h: publicSide.height },
    { jpeg: await canvasToJpeg(privateSide), w: privateSide.width, h: privateSide.height },
  ];
  // PDF points: A4 = 595.28×841.89; 6×4" landscape = 432×288
  const pdf =
    format === 'a4'
      ? buildPdfWithJpegPages(pages, 595.28, 841.89)
      : buildPdfWithJpegPages(pages, 432, 288);
  const suffix = format === 'a4' ? 'A4' : 'foto-15x10';
  const url = URL.createObjectURL(pdf);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${brand.shortName}-paper-wallet-${safeAddress.slice(2, 8)}-${suffix}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
