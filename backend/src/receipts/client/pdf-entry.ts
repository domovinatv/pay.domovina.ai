/// Entry of /potvrda/pdf.js: pdf-lib + fontkit + Inter (OFL, inlined by the
/// esbuild `binary` loader). Loaded when the receipt page opens, so building
/// the PDF later needs no network.
import regular from './fonts/inter-400.ttf';
import semibold from './fonts/inter-600.ttf';
import { buildReceiptPdf, receiptPdfFileName, type PdfInput } from './pdf';

declare global {
  interface Window {
    MptReceiptPdf?: { build(input: PdfInput): Promise<Uint8Array>; fileName(sid: string): string };
  }
}

window.MptReceiptPdf = {
  build: (input) => buildReceiptPdf(input, { regular, semibold }),
  fileName: receiptPdfFileName,
};
