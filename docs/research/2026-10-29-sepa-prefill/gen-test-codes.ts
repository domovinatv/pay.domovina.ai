// Testni kodovi za test-plan-uredaji.md (T1–T6; HUB3 s EE IBAN-om je već testiran 11.10. i
// builder ga od #77 ne generira). Koristi iste buildere kao rail.
//
//   EE_IBAN=EE… HR_IBAN=HR… NAME="ITalk d.o.o." OUT=/tmp/kodovi \
//     npx -y tsx docs/research/2026-10-29-sepa-prefill/gen-test-codes.ts
//
// IBAN-i dolaze iz okoline, nikad iz gita. Bez `bwip-js` u node_modules ispisuje samo
// tekst kodova; s njim (`npm i --no-save bwip-js` u korijenu repoa) piše i PNG-ove.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEpcText } from '../../../backend/src/intents/epc';
import { buildHub3Text } from '../../../backend/src/intents/hub3';

const EE = process.env.EE_IBAN ?? '';
const HR = process.env.HR_IBAN ?? '';
const NAME = process.env.NAME ?? 'ITalk d.o.o.';
const OUT = process.env.OUT ?? 'test-kodovi';
if (!EE || !HR) throw new Error('postavi EE_IBAN i HR_IBAN');

const amount = 0.01;
const ref = 'MPT T1 TEST';
const hub3 = (iban: string) =>
  buildHub3Text({ beneficiaryName: NAME, iban, amountEur: amount, model: 'HR00',
    reference: '20261029', purposeCode: 'OTHR', description: ref })!;
const epc = (iban: string, name = NAME) =>
  buildEpcText({ beneficiaryName: name, iban, amountEur: amount, remittanceInfo: ref });
const payto = (iban: string) =>
  `payto://iban/${iban}?receiver-name=${encodeURIComponent(NAME)}` +
  `&amount=EUR:${amount.toFixed(2)}&message=${encodeURIComponent(ref)}`;

type Code = { id: string; kind: 'qrcode' | 'pdf417'; text: string };
const codes: Code[] = [
  { id: 'T1-epc-hr', kind: 'qrcode', text: epc(HR) },
  { id: 'T2-epc-ee', kind: 'qrcode', text: epc(EE) },
  { id: 'T3-hub3-qr-hr', kind: 'qrcode', text: hub3(HR) },
  { id: 'T5-payto-ee', kind: 'qrcode', text: payto(EE) },
  { id: 'T6a-vop-tocno', kind: 'qrcode', text: epc(EE, NAME) },
  { id: 'T6b-vop-krivo', kind: 'qrcode', text: epc(EE, 'Monerium EMI ehf.') },
];

async function main() {
mkdirSync(OUT, { recursive: true });
let bwip: any = null;
try { bwip = await import('bwip-js'); } catch { /* samo tekst */ }

for (const c of codes) {
  writeFileSync(join(OUT, `${c.id}.txt`), c.text);
  console.log(`--- ${c.id}\n${c.text}\n`);
  if (bwip) {
    const png = await (bwip.default ?? bwip).toBuffer({
      bcid: c.kind, text: c.text, scale: 4, padding: 16, backgroundcolor: 'FFFFFF',
      ...(c.kind === 'qrcode' ? { eclevel: 'M' } : { columns: 9, eclevel: 4 }),
    });
    writeFileSync(join(OUT, `${c.id}.png`), png);
  }
}
console.log(bwip ? `PNG + txt u ${OUT}` : `samo txt u ${OUT} (nema bwip-js)`);
}

main();
