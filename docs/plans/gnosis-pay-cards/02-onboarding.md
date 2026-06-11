# 02 — Onboarding: SIWE → KYC → GP Safe

Base URL: `https://api.gnosispay.com` · Auth: `Authorization: Bearer {jwt}` (SIWE) ·
OpenAPI: `https://api.gnosispay.com/api-docs/spec.json` · Referentni FE: `github.com/gnosispay/ui`

**Bitno svojstvo**: cijeli onboarding je dizajniran da se zove **direktno iz browsera**
(CORS + domain whitelist + user-scoped JWT). Naš backend za ovaj dio nije obavezan.

## Sequence dijagram — kompletan put do kartice

```mermaid
sequenceDiagram
    actor U as Korisnik
    participant W as wallet.domovina.ai<br/>(tab "Kartica")
    participant GP as api.gnosispay.com
    participant S as Sumsub (iframe)

    rect rgb(235,243,255)
    Note over U,GP: 1. SIWE autentikacija
    W->>GP: GET /api/v1/auth/nonce
    GP-->>W: nonce
    W->>U: passkey ceremonija (ERC-1271)<br/>ili EOA personal_sign
    W->>GP: POST /api/v1/auth/challenge {message, signature, ttlInSeconds}
    GP-->>W: JWT (1–24 h, bez refresha)
    end

    rect rgb(235,255,238)
    Note over U,GP: 2. Registracija (jednom)
    W->>GP: POST /api/v1/auth/signup/otp {email}
    GP-->>U: email OTP
    W->>GP: POST /api/v1/auth/signup {authEmail, otp, partnerId}
    GP-->>W: 201 {id, token} — novi JWT s userId
    W->>GP: GET /api/v1/user/terms → POST /api/v1/user/terms (po svakom ToS-u)
    end

    rect rgb(255,248,235)
    Note over U,S: 3. KYC (Sumsub, obavezan)
    W->>GP: GET /api/v1/kyc/integration?lang=hr
    GP-->>W: {type: SUMSUB_WEB, url}
    W->>S: iframe(url) — dokumenti + selfie
    loop polling
        W->>GP: GET /api/v1/user
        GP-->>W: kycStatus: pending → approved
    end
    end

    rect rgb(255,240,245)
    Note over U,GP: 4. Source of funds + telefon
    W->>GP: GET /api/v1/source-of-funds
    U->>W: odgovori (sve odjednom)
    W->>GP: POST /api/v1/source-of-funds [{question, answer}…]
    W->>GP: POST /api/v1/verification {phoneNumber: +385…}
    GP-->>U: SMS OTP
    W->>GP: POST /api/v1/verification/check {code}
    end

    rect rgb(240,240,255)
    Note over U,GP: 5. GP Safe deploy (gasless, bez potpisa)
    W->>GP: POST /api/v1/safe/deploy {dailyLimit: 350}
    GP-->>W: 202 accepted
    loop do ~1 min
        W->>GP: GET /api/v1/safe/deploy → ok
        W->>GP: GET /api/v1/safe/config → accountStatus: 0
    end
    end

    W->>GP: POST /api/v1/cards/virtual
    GP-->>W: 201 {cardId} — kartica aktivna! 🎉
```

## State machine — izvor istine je `GET /api/v1/user`

Router "sljedećeg koraka" se derivira čisto iz user objekta (+ JWT decode za `userId`):

```mermaid
stateDiagram-v2
    [*] --> Anon
    Anon --> Authed: SIWE ok (JWT)
    Authed --> Registered: 401 na /user → signup s email OTP
    Authed --> Registered: JWT sadrži userId
    Registered --> TermsOk: svi ToS accepted
    TermsOk --> KycPending: Sumsub iframe pokrenut
    KycPending --> KycApproved: kycStatus = approved
    KycPending --> KycRejected: rejected (TRAJNO, bez retryja)
    KycPending --> KycAction: requiresAction / resubmissionRequested
    KycAction --> KycPending: korisnik reagira / support
    KycApproved --> SofDone: isSourceOfFundsAnswered = true
    SofDone --> PhoneOk: isPhoneValidated = true
    PhoneOk --> SafeDeploying: POST /safe/deploy (safeWallets prazan)
    SafeDeploying --> SafeReady: deploy=ok ∧ accountStatus ∈ {0, 7}
    SafeDeploying --> SafeFailed: failed → DELETE /safe/reset → retry
    SafeReady --> CardActive: POST /cards/virtual (201)
    KycRejected --> [*]
```

`kycStatus` vrijednosti: `notStarted`, `documentsRequested`, `pending`, `processing`,
`approved`, `resubmissionRequested`, `rejected` (final), `requiresAction` (ručni review →
prikazati support kontakt).

`AccountIntegrityStatus`: `Ok(0)`, `SafeNotDeployed(1)`, `SafeMisconfigured(2)`,
`RolesNotDeployed(3)`, `RolesMisconfigured(4)`, `DelayNotDeployed(5)`, `DelayMisconfigured(6)`,
`DelayQueueNotEmpty(7)` (validan), `UnexpectedError(8)`.

## Endpoint referenca (onboarding domena)

| Korak | Endpoint | Napomene |
|---|---|---|
| Nonce | `GET /api/v1/auth/nonce` | plain-text, svježi po loginu |
| Login | `POST /api/v1/auth/challenge` | `{message, signature, ttlInSeconds≤86400}`; EOA i ERC-1271 |
| Email OTP | `POST /api/v1/auth/signup/otp` | `{email}` |
| Signup | `POST /api/v1/auth/signup` | `{authEmail, otp, partnerId?}`; **409 = adresa/email već vezani**; partnerId SAMO ovdje (atribucija nepovratna) |
| ToS lista | `GET /api/v1/user/terms` / public `GET /api/v1/terms` | tipovi: `general-tos`, `card-monavate-tos`, `cashback-tos`, `privacy-policy` |
| ToS accept | `POST /api/v1/user/terms` | `{terms, version}`, checkbox obavezan u UI |
| KYC web | `GET /api/v1/kyc/integration?lang=hr` | Sumsub URL za iframe; `lang=hr` radi |
| KYC SDK | `GET /api/v1/kyc/integration/sdk` | za budući native app |
| SoF | `GET`/`POST /api/v1/source-of-funds` | sve odgovore u jednom POST-u, uključiti tekst pitanja |
| Telefon | `POST /api/v1/verification` + `/check` | **gated iza KYC approved**; zamjenjuje postojeći broj; 429 rate limit |
| Profil | `GET /api/v1/user` | izvor istine za state machine |
| Deploy | `POST /api/v1/safe/deploy` | `{dailyLimit?}` default 350; idempotentan; 202 |
| Deploy status | `GET /api/v1/safe/deploy` | `processing/ok/failed/not_deployed` |
| Konfiguracija | `GET /api/v1/safe/config` | `address`, `tokenSymbol`, `accountStatus`, `accountAllowance` |
| Dodatne adrese | `GET/POST/DELETE /api/v1/eoa-accounts` | SIWE identiteti, NISU Safe owneri |

## DOMOVINA-specifični detalji

- **Valuta**: country-based — GB→GBPe, BR→USDCe, **ostali (HR)→EURe**. Ništa ne biramo.
- **Telefon**: GP-ov OTP je neovisan o našem otp.domovina.ai bindingu → korisnik verificira broj
  dvaput; UX copy to mora objasniti ("GP zahtijeva vlastitu verifikaciju za VISA mrežu").
  Postojeće pravilo: telefon = verifikacija, NE recovery.
- **Email**: GP traži email (unique per user) — imamo li ga? Wallet danas ne skuplja email →
  novi input u onboarding UI.
- **JWT**: nema refresha; max 24 h pa puna SIWE re-auth = jedna passkey ceremonija. Lazy re-auth
  na 401.
- **Sumsub iframe u PWA**: standardni web-SDK URL; kamera radi u Safari PWA kontekstu (provjeriti
  na iOS — poznata ograničenja getUserMedia u standalone modu → test u Fazi 1; fallback: otvoriti
  u Safari tabu).
- **KYC podatke ne diramo**: sve ide kroz Sumsub iframe; mi ne pohranjujemo ništa osim statusa →
  minimalan GDPR scope.
