// Paper-wallet PDF generator — 100% client-side/offline (canvas → JPEG → a
// hand-rolled single-page PDF; no network, no new dependencies). Plaintext BY
// DESIGN: a paper wallet is an offline artifact the user prints and stores —
// a passkey-encrypted file was rejected because it would be undecryptable in
// exactly the lost-passkey scenario it exists for.
//
// Two print formats:
//   'a4'    — 210×297 mm portrait, classic document print
//   'photo' — 15×10 cm (6×4") landscape @300dpi, the native media of DNP
//             dye-sublimation photo printers — prints like a real photograph
//
// Branding follows the mediakit (/mediakit.domovina.tv): the family "D" mark
// (vertical Croatian-flag fill + product symbol), navy #002F6C / red #FF0000
// palette, tricolor stripe. Tenant name/colors come from brand config; the
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

// ── A4 portrait, 300dpi: 2480×3508 ──────────────────────────────────────────
function renderA4(input: RenderInput): HTMLCanvasElement {
  const W = 2480;
  const H = 3508;
  const M = 180;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);

  tricolorStripe(ctx, 0, W, 16);

  // Header
  drawLogo(ctx, M, 140, 250);
  ctx.fillStyle = NAVY;
  ctx.font = `700 116px ${FONT_SANS}`;
  ctx.fillText(brand.name, M + 310, 255);
  ctx.fillStyle = MUTED;
  ctx.font = `600 56px ${FONT_SANS}`;
  ctx.fillText('PAPER BACKUP · RECOVERY SEED', M + 310, 345);

  ctx.font = `400 44px ${FONT_SANS}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(
    `Kreirano: ${input.date}   ·   Mreža: Gnosis Chain (EVM, chain ID 100)   ·   Safe v1.4.1`,
    M,
    505,
  );

  // Warning box
  const warnY = 570;
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
    'Tko ima ovih 12 riječi, ima potpunu kontrolu nad sredstvima na adresi ispod — u bilo kojem walletu, bez aplikacije i bez lozinke. Spremi offline; ne šalji mailom, ne slikaj u galeriju, ne drži u cloudu.',
    W - 2 * M - 100,
  );
  warnLines.forEach((l, i) => ctx.fillText(l, M + 50, warnY + 155 + i * 56));

  // Address + QR
  let y = 1000;
  ctx.fillStyle = NAVY;
  ctx.font = `700 52px ${FONT_SANS}`;
  ctx.fillText('ADRESA (SAFE SMART ACCOUNT)', M, y);
  y += 50;
  const qrSize = 620;
  if (input.qr) {
    ctx.strokeStyle = CELL_BORDER;
    ctx.lineWidth = 3;
    ctx.strokeRect(M, y, qrSize + 40, qrSize + 40);
    ctx.drawImage(input.qr, M + 20, y + 20, qrSize, qrSize);
  }
  const addrX = M + qrSize + 110;
  ctx.font = `700 60px ${FONT_MONO}`;
  ctx.fillStyle = NAVY;
  const half = Math.ceil(input.safeAddress.length / 2);
  ctx.fillText(input.safeAddress.slice(0, half), addrX, y + 240);
  ctx.fillText(input.safeAddress.slice(half), addrX, y + 320);
  ctx.font = `400 42px ${FONT_SANS}`;
  ctx.fillStyle = MUTED;
  ctx.fillText('Skeniraj QR za primanje na Gnosis Chainu.', addrX, y + 430);
  ctx.fillText('Adresa je javna — smije se dijeliti.', addrX, y + 490);

  // Seed grid
  y = 1880;
  ctx.fillStyle = NAVY;
  ctx.font = `700 52px ${FONT_SANS}`;
  ctx.fillText('RECOVERY SEED — 12 RIJEČI (REDOSLIJED JE BITAN)', M, y);
  y += 50;
  const gap = 36;
  const cellW = (W - 2 * M - 2 * gap) / 3;
  const cellH = 150;
  input.words.forEach((word, i) => {
    const cx = M + (i % 3) * (cellW + gap);
    const cy = y + Math.floor(i / 3) * (cellH + gap);
    ctx.strokeStyle = CELL_BORDER;
    ctx.lineWidth = 3;
    roundRectPath(ctx, cx, cy, cellW, cellH, 20);
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.font = `400 36px ${FONT_SANS}`;
    ctx.fillText(String(i + 1), cx + 34, cy + 95);
    ctx.fillStyle = NAVY;
    ctx.font = `700 60px ${FONT_MONO}`;
    ctx.fillText(word, cx + 110, cy + 98);
  });

  // Restore instructions
  y = y + 4 * (cellH + gap) + 70;
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

  // Footer
  ctx.fillStyle = MUTED;
  ctx.font = `400 40px ${FONT_SANS}`;
  ctx.fillText(`${brand.domain}   ·   Self-custody — ključ je 100% tvoj`, M, H - 130);
  tricolorStripe(ctx, H - 48, W, 16);
  return canvas;
}

// ── 15×10 cm (6×4") landscape, 300dpi: 1800×1200 — DNP photo media ──────────
function renderPhoto(input: RenderInput): HTMLCanvasElement {
  const W = 1800;
  const H = 1200;
  const M = 90; // generous safe margin: borderless photo printers crop edges
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);

  // Header band
  ctx.fillStyle = NAVY;
  ctx.fillRect(0, 0, W, 150);
  drawLogo(ctx, M, 25, 100);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 56px ${FONT_SANS}`;
  ctx.fillText(`${brand.name} — paper backup`, M + 135, 95);
  ctx.font = `400 34px ${FONT_SANS}`;
  ctx.textAlign = 'right';
  ctx.fillText(input.date, W - M, 92);
  ctx.textAlign = 'left';

  // Left column: QR + address
  const qrSize = 470;
  const qrY = 210;
  if (input.qr) {
    ctx.strokeStyle = CELL_BORDER;
    ctx.lineWidth = 2;
    ctx.strokeRect(M, qrY, qrSize + 28, qrSize + 28);
    ctx.drawImage(input.qr, M + 14, qrY + 14, qrSize, qrSize);
  }
  ctx.fillStyle = NAVY;
  ctx.font = `700 34px ${FONT_MONO}`;
  const half = Math.ceil(input.safeAddress.length / 2);
  ctx.fillText(input.safeAddress.slice(0, half), M, qrY + qrSize + 90);
  ctx.fillText(input.safeAddress.slice(half), M, qrY + qrSize + 134);
  ctx.fillStyle = MUTED;
  ctx.font = `400 28px ${FONT_SANS}`;
  ctx.fillText('Safe adresa · Gnosis Chain · skeniraj za primanje', M, qrY + qrSize + 190);

  // Right column: seed grid 3×4
  const gridX = M + qrSize + 110;
  const gridY = 230;
  ctx.fillStyle = NAVY;
  ctx.font = `700 36px ${FONT_SANS}`;
  ctx.fillText('RECOVERY SEED — 12 RIJEČI', gridX, gridY - 30);
  const gap = 18;
  const cellW = (W - M - gridX - 2 * gap) / 3;
  const cellH = 130;
  input.words.forEach((word, i) => {
    const cx = gridX + (i % 3) * (cellW + gap);
    const cy = gridY + Math.floor(i / 3) * (cellH + gap);
    ctx.strokeStyle = CELL_BORDER;
    ctx.lineWidth = 2;
    roundRectPath(ctx, cx, cy, cellW, cellH, 14);
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.font = `400 26px ${FONT_SANS}`;
    ctx.fillText(String(i + 1), cx + 20, cy + 80);
    ctx.fillStyle = NAVY;
    ctx.font = `700 42px ${FONT_MONO}`;
    ctx.fillText(word, cx + 70, cy + 83);
  });

  // Bottom warning + footer
  ctx.fillStyle = RED;
  ctx.font = `700 32px ${FONT_SANS}`;
  ctx.fillText(
    'ČUVAJ KAO GOTOVINU — tko ima ovih 12 riječi, kontrolira sredstva. Spremi offline.',
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

// ── Minimal single-page PDF with one embedded JPEG (DCTDecode) ───────────────
// Hand-rolled to stay dependency-free: catalog → pages → page → image XObject
// → content stream that paints the image across the full MediaBox.
function buildPdfWithJpeg(
  jpeg: Uint8Array,
  imgW: number,
  imgH: number,
  pageWPt: number,
  pageHPt: number,
): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const offsets: number[] = [];
  const push = (part: string | Uint8Array) => {
    const b = typeof part === 'string' ? enc.encode(part) : part;
    chunks.push(b);
    offset += b.length;
  };

  push('%PDF-1.4\n');
  const content = `q ${pageWPt} 0 0 ${pageHPt} 0 0 cm /Im0 Do Q\n`;
  offsets[1] = offset;
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offsets[2] = offset;
  push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  offsets[3] = offset;
  push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWPt} ${pageHPt}] ` +
      '/Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> /Contents 5 0 R >>\nendobj\n',
  );
  offsets[4] = offset;
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  push(jpeg);
  push('\nendstream\nendobj\n');
  offsets[5] = offset;
  push(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
  const xrefStart = offset;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
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

/** Render the paper wallet to a 300dpi canvas — exported for previews/tests. */
export async function renderPaperWalletCanvas(
  safeAddress: string,
  seed: string,
  format: PaperWalletFormat,
): Promise<HTMLCanvasElement> {
  const input: RenderInput = {
    safeAddress,
    words: seed.split(/\s+/),
    date: new Date().toISOString().slice(0, 10),
    qr: await addressQrBitmap(safeAddress, 1000),
  };
  return format === 'a4' ? renderA4(input) : renderPhoto(input);
}

/** Generate the paper-wallet PDF and trigger a download. Throws on failure so
 * the caller can keep its backup gating honest. */
export async function downloadPaperWalletPdf(
  safeAddress: string,
  seed: string,
  format: PaperWalletFormat,
): Promise<void> {
  const canvas = await renderPaperWalletCanvas(safeAddress, seed, format);
  const jpeg = await canvasToJpeg(canvas);
  // PDF points: A4 = 595.28×841.89; 6×4" landscape = 432×288
  const pdf =
    format === 'a4'
      ? buildPdfWithJpeg(jpeg, canvas.width, canvas.height, 595.28, 841.89)
      : buildPdfWithJpeg(jpeg, canvas.width, canvas.height, 432, 288);
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
