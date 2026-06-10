# pay.DOMOVINA.ai

<p align="center">
  <a href="https://pay.domovina.ai">
    <img src="web/favicon.svg" width="120" alt="Domovina Pay logotip">
  </a>
</p>

Generator platnih barkodova za hrvatska plaćanja i most prema *on-chain* euru, dostupan na **[pay.domovina.ai](https://pay.domovina.ai)**.

Iz jedne forme producira tri kompatibilna formata:

- **SEPA EPC QR** — skenira Revolut, Wise i sve EPC-kompatibilne aplikacije; stroga 10-redna shema s pozicijskim praznim poljima koja jamči ispravan parsing na iOS-u.
- **HUB3 PDF417** — puni 14-poljni FINA layout (uključujući prazan blok platitelja 4–6) za hrvatsko mobilno bankarstvo i FINA aplikacije.
- **EIP-681 wallet QR** — *deep link* za Monerium EURe na Gnosis Chainu (`0x420CA0f9…`) koji MetaMask, Rainbow i ostali Web3 walleti čitaju kao gotovu transakciju.

Dio je obitelji proizvoda **Domovina** (vidi [mediakit.domovina.tv](https://github.com/domovinatv/mediakit.domovina.tv)).

## Arhitektura

| Sloj | Tehnologija | Lokacija |
|---|---|---|
| Frontend | Flutter web (WASM release) | `lib/`, `web/` |
| Backend | Cloudflare Workers + D1 + KV | `backend/` |
| Hosting (frontend) | Cloudflare Pages (`pay-domovina` projekt) | `pay.domovina.ai` |
| Hosting (backend) | Cloudflare Workers | `monerium.domovina.ai` |
| On-chain routing | Safe 2/3 + Zodiac Roles Modifier (Gnosis) | `backend/safe-tx/` |

Glavni *rail* za Monerium EURe prijenose ide kroz **MPT Safe** (`0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e`) s Zodiac Roles Modifier mehanizmom — privatne korisničke transakcije se ne dogode bez 2-od-3 Safe potpisa, dok dnevno IBAN→EURe rutiranje ide kroz EOA backend signera ograničenog na samo `EUReForwarder` ulogu.

## Lokalni razvoj

```bash
# Frontend
flutter pub get
flutter run -d chrome

# Backend (zaseban poddirektorij)
cd backend
npm install
wrangler dev --remote   # --remote daje javni *.workers.dev URL za Monerium webhook
```

## Produkcijski deploy

```bash
# Frontend → Cloudflare Pages
flutter build web --wasm --release
wrangler pages deploy build/web --project-name=pay-domovina --branch=main --commit-dirty=true

# Backend → Cloudflare Workers
cd backend && wrangler deploy
```

Cloudflare account ID: `7dc7167b7e2e00923bfa7cd697df14e4`.

## Brand

Ikona slijedi jedinstveni Domovina vizualni okvir: slovo „D" ispunjeno horizontalnim prugama hrvatske zastave, unutarnji bijeli prostor i centralni simbol — u ovom slučaju **znak eura (€)** koji označava domenu proizvoda (euro denominirana plaćanja, SEPA i *on-chain*). Izvor SVG-a živi u zajedničkom [mediakitu](https://github.com/domovinatv/mediakit.domovina.tv) pod imenom `domovina_pay_logo_square.svg`.

Paleta: tamnoplava `#002F6C`, crvena `#FF0000`, bijela `#FFFFFF`.

## Licenca

Kod je open source pod **[MIT licencom](./LICENSE)** (© 2026 domovina.tv) — slobodno koristite, mijenjajte i forkajte uz vlastiti branding.

Brand resursi (logotip, ikona, paleta) podliježu licenci **[CC BY-ND 4.0](https://creativecommons.org/licenses/by-nd/4.0/)** definiranoj u [mediakitu](https://github.com/domovinatv/mediakit.domovina.tv).
