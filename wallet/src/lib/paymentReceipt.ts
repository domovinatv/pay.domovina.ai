// Composite "payment receipt" image: brand header + QR code + amount +
// metadata rows + footer. Used by Receive (both SEPA top-up and P2P direct
// EURe flows) to produce a single share-able / save-able PNG that carries
// the full payment context, not just a bare QR.
//
// The image is rendered into an offscreen Canvas at 2× pixel density so it
// looks crisp on retina/AMOLED previews when shared via iMessage etc., and
// then exported as a PNG Blob via canvas.toBlob.

export type ReceiptRow = {
  label: string;
  value: string;
  /** Render the value in monospace (addresses, IBANs, references). */
  mono?: boolean;
};

export type ReceiptInput = {
  /** Raw QR PNG blob (from qr-code-styling.getRawData). */
  qrBlob: Blob;
  /** Right-aligned header sub-title, e.g. "EURe top-up · SEPA". */
  title: string;
  /** Optional big amount line below the QR, e.g. "100,00 EUR". */
  amountLine?: string;
  /** Metadata rows printed under the divider. */
  rows: ReceiptRow[];
  /** Optional footer hint, e.g. "Skeniraj u Revolutu / banci". */
  footer?: string;
};

const W = 800;
const PADDING = 48;
const QR_SIZE = 480;
const HEADER_H = 96;
const ROW_H = 56;
const SCALE = 2; // retina supersample
const BRAND_NAVY = '#002F6C';
const BRAND_RED = '#FF0000';
const INK = '#0F1727';
const INK_MUTED = '#8A94A5';
const SURFACE_LINE = '#E2E6EC';

const FONT_DISPLAY = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_MONO = 'ui-monospace, "SFMono-Regular", "Menlo", "Consolas", monospace';

export async function buildReceiptPng(input: ReceiptInput): Promise<Blob> {
  const qrImg = await blobToImage(input.qrBlob);

  // Vertical layout: header → padding → QR → padding → (amount → padding)? →
  // divider → padding → rows → padding → footer? → padding
  const amountSpace = input.amountLine ? 80 + PADDING / 2 : 0;
  const footerSpace = input.footer ? 36 + PADDING / 2 : 0;
  const rowsSpace = input.rows.length * ROW_H;
  const H = Math.round(
    HEADER_H +
      PADDING +
      QR_SIZE +
      PADDING +
      amountSpace +
      24 + // divider area
      rowsSpace +
      PADDING +
      footerSpace +
      PADDING,
  );

  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas-2d-not-supported');
  ctx.scale(SCALE, SCALE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.textBaseline = 'middle';

  // ── Background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);

  // ── Header: navy band with brand mark on left, title on right
  ctx.fillStyle = BRAND_NAVY;
  ctx.fillRect(0, 0, W, HEADER_H);

  // Tricolor accent strip (red/white/navy) under the band — DOMOVINA mark
  const stripeY = HEADER_H - 6;
  const stripeW = 96;
  ctx.fillStyle = BRAND_RED;
  ctx.fillRect(PADDING, stripeY, stripeW / 3, 4);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(PADDING + stripeW / 3, stripeY, stripeW / 3, 4);
  ctx.fillStyle = '#FFFFFF'; // navy on navy would invisible; use a lighter mark
  ctx.fillRect(PADDING + (2 * stripeW) / 3, stripeY, stripeW / 3, 4);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 30px ${FONT_DISPLAY}`;
  ctx.textAlign = 'left';
  ctx.fillText('DOMOVINA', PADDING, HEADER_H / 2 - 4);
  ctx.font = `500 14px ${FONT_DISPLAY}`;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText('WALLET', PADDING + 145, HEADER_H / 2 - 4);

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `500 18px ${FONT_DISPLAY}`;
  ctx.textAlign = 'right';
  ctx.fillText(input.title, W - PADDING, HEADER_H / 2 - 4);
  ctx.textAlign = 'left';

  // ── QR centered on a thin border-card so it reads well against any chat background
  const qrX = (W - QR_SIZE) / 2;
  const qrY = HEADER_H + PADDING;
  ctx.strokeStyle = SURFACE_LINE;
  ctx.lineWidth = 1;
  roundRect(ctx, qrX - 12, qrY - 12, QR_SIZE + 24, QR_SIZE + 24, 16);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.stroke();
  ctx.drawImage(qrImg, qrX, qrY, QR_SIZE, QR_SIZE);

  // ── Amount (optional)
  let y = qrY + QR_SIZE + PADDING;
  if (input.amountLine) {
    ctx.fillStyle = INK;
    ctx.font = `700 48px ${FONT_DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.fillText(input.amountLine, W / 2, y + 24);
    ctx.textAlign = 'left';
    y += 80 + PADDING / 2;
  }

  // ── Divider
  ctx.strokeStyle = SURFACE_LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PADDING, y);
  ctx.lineTo(W - PADDING, y);
  ctx.stroke();
  y += 24;

  // ── Rows: label (uppercase tracking) left, value right
  const labelX = PADDING;
  const valueX = PADDING + 200;
  for (const row of input.rows) {
    ctx.fillStyle = INK_MUTED;
    ctx.font = `600 12px ${FONT_DISPLAY}`;
    ctx.textAlign = 'left';
    ctx.fillText(row.label.toUpperCase(), labelX, y + ROW_H / 2);

    ctx.fillStyle = INK;
    ctx.font = `${row.mono ? 500 : 600} 17px ${row.mono ? FONT_MONO : FONT_DISPLAY}`;
    // Auto-shrink if the value would overflow the canvas
    let value = row.value;
    let valueFontSize = 17;
    while (ctx.measureText(value).width > W - valueX - PADDING && valueFontSize > 11) {
      valueFontSize -= 1;
      ctx.font = `${row.mono ? 500 : 600} ${valueFontSize}px ${row.mono ? FONT_MONO : FONT_DISPLAY}`;
    }
    ctx.fillText(value, valueX, y + ROW_H / 2);

    y += ROW_H;
  }

  // ── Footer
  if (input.footer) {
    y += PADDING / 2;
    ctx.fillStyle = INK_MUTED;
    ctx.font = `500 15px ${FONT_DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.fillText(input.footer, W / 2, y);
    ctx.textAlign = 'left';
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('canvas-toBlob-failed'));
    }, 'image/png');
  });
}

async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('qr-image-load-failed'));
      img.src = url;
    });
    return img;
  } finally {
    // Revoke after a tick so any rendering work that still references the
    // image (e.g. drawImage in the synchronous task right after) finishes.
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Helper: format ISO date as compact YYYY-MM-DD HH:MM UTC.
export function formatReceiptTime(iso: string | undefined | null): string {
  if (!iso) return new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 16);
  return `${date} ${time} UTC`;
}
