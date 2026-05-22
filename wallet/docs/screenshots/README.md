# Screenshots

Snimi na pravom iPhone-u (iOS Safari PWA standalone) jer to je
referentno ciljano okruženje. Android Chrome i desktop su sekundarni.

## Tehnička priprema

1. iPhone → Settings → Display & Brightness → izaberi temu (svjetla
   za light shots, tamna za dark shots).
2. Otvori `wallet.domovina.ai` u Safari-ju → Share → **Add to Home
   Screen**. Ovo daje native splash + saskripirani Safari chrome.
3. Pokreni PWA s home screena (NE iz Safari taba) tako da safe-area
   insets izgledaju produkcijski.
4. Snimi screen native iOS shortcut-om: **Volume up + Side button**
   (ili **Home + Power** na klasicima).
5. Crop status bar van ako želiš čistije slike — opcionalno.

## Shot lista (filename ↔ kako se tamo dođe)

Svaki par je `light` + `dark` ako nije naveden samo jedan.

| Filename | Što treba pokazati |
|----------|--------------------|
| `hero.png` | Najbolji home shot za GitHub README hero — light tema, popunjen balance, neka aktivnost vidljiva, AddressChip u headeru |
| `landing-welcome.png` | Landing **prvi posjet** (no known passkeys) — 3 feature row-a, Kreiraj wallet primary, cross-device secondary. Za testiranje, otvori incognito ili obriši `domovina_wallets_v2` u localStorage. |
| `landing-known.png` | Landing **welcome-known** — barem 1 WalletCard (gradient avatar + truncated address). Za 2+ kartice — kreiraj dodatni wallet. |
| `landing-created.png` | Landing **created stage** — emerald sparkle medallion + AddressChip s tvojom novom adresom + Otvori wallet gumb. |
| `home.png` | Home — balance hero + Primi/Pošalji + activity feed s barem 2 reda + sigurnost sekcija. |
| `receive-sepa.png` | Receive **Iz banke** tab — amount field, preset chips (10/25/50/100), Generiraj QR. |
| `receive-sepa-qr.png` | Receive — generated SEPA QR ticket s "Čekam uplatu…" pulsing pill + detalji uplate. |
| `receive-p2p.png` | Receive **Drugi wallet** tab — amount input + EIP-681 QR + Podijeli/Spremi QR gumbi + Safe adresa + Link za dijeljenje. |
| `send.png` | Send — Nedavno korišteno chips iznad address inputa, recipient + amount popunjeni, Face ID gumb primary. |
| `send-scanner.png` | Scanner sheet otvoren — live kamera feed s qr-scanner overlay-em + Učitaj iz galerije gumb. |
| `settings.png` | Settings hub — sve sekcije vidljive (skroliraj donji rub van ako treba). |
| `settings-theme.png` | Settings → Izgled — SegmentedControl s aktivnom temom. Najbolje 2 shot-a (sustav i tama). |
| `phone-wizard.png` | `/settings/phone` u **sms-sent** stage-u — pulsing "Čekam SMS…" pill + tel: gateway broj + tracking-widest kod + Otvori SMS gumb. |
| `update-banner.png` | UpdateBanner snackbar pri dnu — "Nova verzija je spremna" s Ažuriraj gumbom. Da ga vidiš: deploy novu verziju i pričekaj 60s u otvorenom PWA-u. |
| `ui-preview.png` | `/ui-preview` design system gallery — bilo koji reprezentativni dio (balance card + button grid). |
| `dark-mode.png` | Home u dark modu. |

## Convention

- **Resolution**: native iPhone screenshot (1290×2796 za 15/16 Pro, 1170×2532 za 12-14). Ne mijenjaj — `width="240"` u README-u skalira u prikazu.
- **Format**: PNG (zadržava brand boje bez JPEG artefakata).
- **Background**: ako režeš slike za marketing materijal, koristi
  brand navy `#002F6C` background.

## Ako želiš headless / scriptanu rutu

Playwright + lokalni dev server + mock-iran localStorage može
automatski capture-ati sve ovo. Skripta nije priložena jer su
manualni iPhone shot-ovi vjernije reprezentativni za promo svrhu
(haptika, dynamic island, system font rendering izgleda druge).
