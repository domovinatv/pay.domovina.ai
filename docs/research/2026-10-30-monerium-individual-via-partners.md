# Monerium individual računi idu kroz partnere (Bleap, Rebind)

Datum: 30. 10. 2026.

## Ukratko

- Monerium od 30. 10. 2026. više ne prima prijave za individual račune kroz
  monerium.app. Fizičke osobe upućuje na partnere **Bleap** i **Rebind**, uz ponovni KYC.
- Bleap **nema** developer konzolu, API ni webhookove. Ne zamjenjuje developer.monerium.com.
- Nijedan partner koji izdaje Monerium IBAN ne izlaže Moneriumove webhookove svojim
  korisnicima. Webhookovi idu partneru kao integratoru.
- Za rail se ništa ne mijenja: tenant (tvrtka ili udruga) ide na **korporativni KYB
  izravno kod Moneriuma**. Mail se odnosi samo na individual račune.
- Fizičke osobe s webhookovima dobit ćemo samo ako MPT postane Monerium **OAuth ili
  whitelabel partner**. Upit kod partners@monerium.com je „in review”.

## Izvor

Odgovor Monerium supporta od 30. 10. 2026. na dvije individual prijave Tomislava
Belavića: osobnu i onu za udrugu Prilika za Susret. Prijave su predane 2. 10. 2026.
Belavić ih je proslijedio Matiji. Bitan dio:

> As a result, we will no longer accept individual account applications directly through
> monerium.app. […] Through our partners, Bleap and Rebind, you can get a Monerium euro
> IBAN […]. You will need to register and verify your identity again with your chosen app.

Podatke iz starih prijava Monerium briše. Udruga se i tako trebala prijaviti kao
corporate (KYB), a ne kao individual.

## Bleap: zašto ne može nositi rail

Matija je 30. 10. otvorio osobni Bleap račun i dobio IBAN.

| Pitanje | Nalaz |
|---|---|
| Developer API / konzola / webhookovi | Nema ih. Ni na webu ni u ToS-u nema developer programa ni SDK-a. |
| Poslovna upotreba | ToS 3.6: samo osobna upotreba. Poslovno, pa i preko IBAN-a, samo uz pisano odobrenje. |
| Tko izdaje IBAN | Monerium, „pod zasebnim odnosom s korisnikom”. Bleap je samo sučelje. |
| Novčanik | MPC EOA, ključ podijeljen između uređaja i Bleapa. Mreža Arbitrum. Rail ga ne kontrolira, pa nema forwarda ni ProjectRoutera (ADR 0026). |
| Referenca uplate | Na lancu se vidi samo mint EURe (iznos, vrijeme). Opis je u Monerium orderu, a do njega nema pristupa. |

Otvoreno: nije provjereno može li se profil koji je otvorio Bleap prijaviti na
monerium.app s istim mailom. I kad bi mogao, ostaje zabrana poslovne upotrebe.

## Partneri koji izdaju Monerium IBAN

| Partner | Napomena |
|---|---|
| Gnosis Pay / Gnosis App | Javni API s IBAN endpointima (`create-a-new-monerium-integration`), koristimo ga u GP fazama 0–2. Moneriumovi webhookovi prema trećima nisu nađeni. |
| Rebind | smart wallet + kartica, bez javnog API-ja |
| Zeal | wallet + kartica, Gnosis Pay ga navodi za migraciju IBAN-a, bez javnog API-ja |
| Safe{Wallet} | Monerium integracija u aplikaciji |
| Greenhood, Frak | walleti s IBAN-om; Frak je primjer OAuth „Connect with Monerium” integracije |

MetaMask, Aave, CoW Swap i 1inch su na Moneriumovom popisu partnera, ali koriste EURe,
ne izdaju IBAN.

Monerium planovi:
- **Whitelabel:** partner preko API-ja vodi KYC, IBAN-e i plaćanja pod svojim brendom.
- **OAuth:** korisnik se prijavi na co-branded Monerium portal i ovlasti partnerovu aplikaciju.
- **Private:** API samo za vlastiti račun. To je naš sadašnji plan.

## Otvoreno

1. Požuriti partnership upit kod Moneriuma. Argument: Monerium sad sam šalje
   individualce kroz partnere.
2. Reći Belaviću da udrugu Prilika za Susret prijavi kao corporate (KYB).
3. Bleapov KYC mail „we need one more thing” (18:53) treba provjeriti u aplikaciji.

## Izvori

- https://monerium.com/partners/
- https://monerium.com/blog/2026/how-bleap-combines-euro-accounts-and-onchain-finance-with-monerium/
- https://www.bleap.finance/nl-nl/legal-agreements/terms-of-service-bleap-finance
- https://help.gnosispay.com/hc/en-us/articles/50058039479444
- https://docs.gnosispay.com/api-reference/iban/create-a-new-monerium-integration.md
- https://nivelais.com/articles/frak/monerium-onchain-iban/

## Vezani dokumenti

- [Monerium first-IBAN screening](2026-09-monerium-first-iban-screening.md)
- [Monerium ugovori](monerium-contract-architecture.md)
