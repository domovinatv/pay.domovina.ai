# Napredna inicijalizacija Safe novčanika — svi slučajevi

> Status: **draft / design exploration** (2026-06-27)
> Kontekst: omogućiti korisniku da pri kreiranju novog Safe računa odabere
> **potpisnike**, broj **dodatnih backup EOA-a** i **threshold (M-of-N)**, te dobije
> **offline PDF backup** (A4 + foto 15×10 cm). Glavni use-case: namjenski
> novčanik za pinka.io kampanju.
>
> Povezano: [[0012-recovery-seed-second-owner-interop]], [[0013-passkey-as-identity-safe-as-account]],
> Postmortem 0001 (passkey-only traps funds), MPT Zodiac Roles arhitektura.

---

## 0. TL;DR

Safe ima **jedan globalni threshold M-of-N** — ne postoji native "1/N do 10€, 3/N
do 100€, 67% za veće". Tiering se gradi **slojevito** (Allowance modul + Zodiac
Roles + bazni threshold). Zato je plan **fazni**:

| Faza | Što | Dira relay/signing? | Rizik |
|---|---|---|---|
| **1** | +N backup EOA, threshold ostaje **1** | **NE** | nizak |
| **2** | pravi **M-of-N** (threshold > 1) | **DA** (co-signing UX) | srednji |
| **3** | **amount-tiered** policy | preko Zodiac/Allowance modula | usvojiti gotovo |

Invarijanta kroz sve faze: **owner-lista postaje persistirani podatak**, jer o njoj
ovisi CREATE2 adresa, a extra EOA-i nisu izvedivi iz passkeya.

---

## 1. Trenutno stanje (danas)

Svaki račun je fiksno `[passkeySigner, recoveryOwner]`, threshold uvijek `1`.

```mermaid
flowchart TB
  PK[Passkey signer<br/>WebAuthn / P256] --> SAFE
  RO[recoveryOwner EOA<br/>BIP39, dijeljen preko svih računa] --> SAFE
  SAFE[Safe 1.4.1<br/>threshold = 1<br/>1-of-2]
  SAFE -.->|lazy CREATE2 deploy na 1. send| CHAIN[(Gnosis Chain)]

  classDef sig fill:#e6f0ff,stroke:#002F6C,color:#002F6C;
  classDef safe fill:#fff3e0,stroke:#f7941d,color:#173863;
  class PK,RO sig;
  class SAFE safe;
```

Ključne točke u kodu:
- `wallet/functions/_lib/safe.ts` → `buildSafeInitializer(owners)` hardkodira `setup(owners, 1n, …)`
- `wallet/src/lib/accounts.ts` → `derivedOwners(signer, recovery) = [signerAddress, recoveryOwner]`
- `recoveryOwner` tajna (mnemonic) se **nikad ne persistira** — samo adresa; prikaže se jednom u PDF-u
- Deploy: relayer rekonstruira owner-array **istim kanonskim redoslijedom**

---

## 2. Prostor svih konfiguracija

Korisnik bira tri ortogonalne stvari: **broj extra EOA-a**, **threshold**, i
**je li uključen amount-tiered policy**.

```mermaid
flowchart TB
  START([Kreiranje novog računa]) --> Q1{Extra EOA-i?}
  Q1 -->|"+0 (default)"| BASE["owners = passkey, recoveryOwner"]
  Q1 -->|"+N unique in-memory EOA"| EXT["owners = passkey, recoveryOwner, EOA1..EOAn"]

  BASE --> Q2{Threshold?}
  EXT --> Q2

  Q2 -->|"1 (default)"| T1[Faza 1: redundantni potpisnici<br/>bilo tko sam potpisuje]
  Q2 -->|"M &gt; 1"| TM[Faza 2: pravi M-of-N<br/>treba skupiti M potpisa]

  T1 --> Q3{Amount-tiered<br/>policy?}
  TM --> Q3
  Q3 -->|Ne| DONE([Standardni Safe])
  Q3 -->|Da| TIER[Faza 3: Allowance modul<br/>+ Zodiac Roles<br/>+ bazni threshold]

  classDef phase1 fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20;
  classDef phase2 fill:#fff8e1,stroke:#f9a825,color:#7a5c00;
  classDef phase3 fill:#fce4ec,stroke:#c2185b,color:#880e4f;
  class T1 phase1;
  class TM phase2;
  class TIER phase3;
```

### 2.1. Matrica slučajeva

```mermaid
flowchart LR
  subgraph A["A — default (danas)"]
    A1["1-of-2<br/>passkey + recovery"]
  end
  subgraph B["B — +N recovery (Faza 1)"]
    B1["1-of-N<br/>bilo tko potpisuje"]
  end
  subgraph C["C — pravi multisig (Faza 2)"]
    C1["M-of-N<br/>npr. 2-of-3, 3-of-5"]
  end
  subgraph D["D — tiered treasury (Faza 3)"]
    D1["bazni 67% + role 2/5<br/>+ allowance 1/N"]
  end

  A1 --> B1 --> C1 --> D1

  classDef a fill:#e6f0ff,stroke:#002F6C;
  classDef b fill:#e8f5e9,stroke:#2e7d32;
  classDef c fill:#fff8e1,stroke:#f9a825;
  classDef d fill:#fce4ec,stroke:#c2185b;
  class A1 a;
  class B1 b;
  class C1 c;
  class D1 d;
```

---

## 3. Invarijanta: owner-lista je PODATAK (CREATE2 reproducibilnost)

CREATE2 adresa Safe-a ovisi o **(owners, threshold, saltNonce)**. Extra EOA-i su
**random**, dakle **nisu izvedivi iz passkeya** — pa ako se ne persistiraju, drugi
uređaj ne može rekonstruirati istu adresu pri deployu.

```mermaid
flowchart TB
  subgraph INPUT["Ulaz u predikciju adrese"]
    OWN["owners array<br/>(kanonski sortiran)"]
    THR["threshold"]
    SALT["saltNonce"]
  end
  INPUT --> KECCAK["CREATE2: keccak256(initializer + salt)"]
  KECCAK --> ADDR["Safe adresa<br/>(counterfactual)"]

  ADDR --> PREDICT["predict (uređaj A)"]
  ADDR --> DEPLOY["relay deploy (uređaj B)"]
  PREDICT -. "moraju biti IDENTIČNI" .- DEPLOY

  classDef warn fill:#ffebee,stroke:#c62828,color:#b71c1c;
  class OWN,THR warn;
```

> **Zato:** za napredne račune backend **mora** spremiti eksplicitnu `owners`
> listu + `threshold`. Za default račune (`+0`, threshold 1) ostaje fallback na
> izvedeni `[signer, recoveryOwner]` zbog back-compata.

### 3.1. Promjena modela podataka

```mermaid
classDiagram
  class AccountRecord {
    +Address safeAddress
    +string credentialId
    +string saltNonce
    +string name
    +string createdAt
    +Address recoveryOwner
    +Address[] owners      «NOVO — opcionalno»
    +number threshold      «NOVO — default 1»
  }
  note for AccountRecord "owners prisutan => koristi DOSLOVNO\nowners odsutan => fallback derivedOwners(signer, recovery)\nthreshold default 1"
```

Kanonski redoslijed (dokumentirati i koristiti svugdje — predict + deploy + relay):

```
owners = [ signerAddress, recoveryOwner, ...extraEOAs.sort(asc) ]
```

---

## 4. Faza 1 — "+N backup EOA", threshold = 1

Više vlasnika, ali **svaki sam može potpisati** → čista **redundantna recovery**.
Ne dira relay ni signing UX. Gasi postmortem 0001 (1/1 lost-passkey trap) za pinka.

```mermaid
flowchart TB
  PK[Passkey signer] --> SAFE
  RO[recoveryOwner EOA] --> SAFE
  E1[EOA #1<br/>print → suorganizator A] --> SAFE
  E2[EOA #2<br/>print → suorganizator B] --> SAFE
  E3[EOA #n<br/>print → ...] --> SAFE
  SAFE["Safe — threshold = 1<br/>1-of-(2+n)"]
  SAFE --> NOTE["Bilo TKO sam pomiče/spašava sredstva.<br/>Gubitak jednog ključa NE zaključava."]

  classDef sig fill:#e6f0ff,stroke:#002F6C,color:#002F6C;
  classDef safe fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20;
  class PK,RO,E1,E2,E3 sig;
  class SAFE safe;
```

### 4.1. Tok kreiranja (in-app)

```mermaid
sequenceDiagram
  autonumber
  participant U as Korisnik
  participant UI as WalletSwitcherSheet
  participant GEN as EOA generator (in-memory)
  participant PDF as paperWallet.ts
  participant BE as Backend (wallet_accounts)

  U->>UI: "Novi račun" + napredne opcije (N, threshold=1)
  UI->>GEN: generiraj N EOA (generatePrivateKey)
  GEN-->>UI: N × {address, privkey} (tajna samo u RAM-u)
  UI->>UI: owners = [signer, recovery, ...EOAsort]
  UI->>UI: predictSafeAddressForOwners(owners, 1, saltNonce)
  UI->>PDF: render A4 + 15×10 cm (svi EOA + QR)
  PDF-->>U: download / print
  UI->>U: gate "Jesi li spremio svih N?"
  U-->>UI: potvrda
  UI->>UI: obriši tajne iz memorije
  UI->>BE: POST account {safeAddress, owners, threshold:1, saltNonce}
  Note over BE: Safe se deploya lazy na 1. send (relay)
```

### 4.2. PDF backup (svi formati)

```mermaid
flowchart LR
  subgraph PDFGEN["downloadPaperWalletPdf() — prošireno"]
    direction TB
    IN["lista EOA-a + brand"] --> A4["A4 stranica<br/>1 EOA / stranica"]
    IN --> PHOTO["15×10 cm foto-print"]
  end
  A4 --> CARD1["EOA k-of-N<br/>adresa + QR<br/>mnemonic/privkey + QR<br/>indeks 'EOA 2 od 4'"]
  PHOTO --> CARD2["isti sadržaj,<br/>foto-format"]

  classDef brand fill:#fff3e0,stroke:#f7941d,color:#173863;
  class A4,PHOTO brand;
```

> Napomena o formatu: "15×10 inch" je ~38×25 cm (vrlo veliko). Standardni
> foto-print je **15×10 cm** — pretpostavka u dokumentu. Oba su trivijalna za
> dodati (samo page-size).

---

## 5. Faza 2 — pravi M-of-N (threshold > 1)

Ovdje **pada one-tap relay**: relayer slaže `execTransaction` s **jednim** passkey
ERC-1271 potpisom. Za M-of-N treba **skupiti M potpisa** (passkey + EOA iz PDF-a),
sortirati po owner-adresi i konkatenirati.

```mermaid
sequenceDiagram
  autonumber
  participant U as Korisnik
  participant UI as Send UI (novi co-sign flow)
  participant PK as Passkey (WebAuthn)
  participant K as EOA ključevi (iz PDF-a)
  participant R as Relayer
  participant C as Safe on-chain

  U->>UI: Pošalji X EURe
  UI->>PK: potpis #1 (ERC-1271)
  PK-->>UI: signature(passkey)
  loop dok skupiš M potpisa
    UI->>K: uvezi/potpiši EOA (privkey)
    K-->>UI: signature(EOA_i)
  end
  UI->>UI: sortiraj potpise po owner-adresi, konkateniraj
  UI->>R: execTransaction(to, value, data, signatures[M])
  R->>C: relay
  C-->>U: tx hash
  Note over UI,C: Gubitak PDF-a + M&gt;1 = TRAJNO zaključana sredstva ⚠️
```

```mermaid
flowchart TB
  M1["1-of-N<br/>Faza 1"] -->|threshold ↑| M2["M-of-N<br/>Faza 2"]
  M2 --> RISK{"Gubitak ključa?"}
  RISK -->|"1-of-N"| OK["OK — drugi ključ spašava"]
  RISK -->|"M-of-N, izgubiš &gt; N-M"| LOCK["TRAJNO LOCKED ⚠️"]

  classDef ok fill:#e8f5e9,stroke:#2e7d32;
  classDef bad fill:#ffebee,stroke:#c62828,color:#b71c1c;
  class OK ok;
  class LOCK bad;
```

---

## 6. Faza 3 — amount-tiered policy (usvojiti gotovo, NE graditi u core)

Safe nema native tiering. Mature rješenje = **slojevi modula** (Gnosis Guild
Zodiac + Safe Allowance). Ovo vaš MPT već koristi (Safe 2/3 + Zodiac Roles).

```mermaid
flowchart TB
  TX([Transakcija iznosa V]) --> D1{V ≤ 10€ / dan?}
  D1 -->|Da| ALLOW["Allowance modul<br/>1 delegat, BEZ co-signera<br/>(zaobilazi threshold)"]
  D1 -->|Ne| D2{V ≤ 100€ i whitelistan poziv?}
  D2 -->|Da| ROLES["Zodiac Roles<br/>sekundarni Safe, ISTI vlasnici,<br/>niži threshold npr. 2/5"]
  D2 -->|Ne| BASE["Bazni Safe threshold<br/>67% / 3-of-5<br/>(sve ostalo)"]

  ALLOW --> CHAIN[(Gnosis)]
  ROLES --> CHAIN
  BASE --> CHAIN

  classDef t1 fill:#e8f5e9,stroke:#2e7d32;
  classDef t2 fill:#fff8e1,stroke:#f9a825;
  classDef t3 fill:#fce4ec,stroke:#c2185b;
  class ALLOW t1;
  class ROLES t2;
  class BASE t3;
```

### 6.1. Arhitektura modula

```mermaid
flowchart TB
  subgraph MAIN["Glavni Safe (bazni 3/5)"]
    OWNERS["Vlasnici: 5 EOA / passkey"]
    ALLOWMOD["Allowance modul<br/>(enabled)"]
    ROLESMOD["Zodiac Roles Modifier<br/>(enabled)"]
    DELAY["Zodiac Delay Modifier<br/>(opc. timelock za velike)"]
  end
  SUB["Sekundarni Safe 2/5<br/>(isti vlasnici)<br/>član role, scoped pozivi"]
  DEL["Delegat (1 ključ)<br/>dnevni cap"]

  ROLESMOD --- SUB
  ALLOWMOD --- DEL

  classDef main fill:#e6f0ff,stroke:#002F6C,color:#002F6C;
  classDef mod fill:#fff3e0,stroke:#f7941d,color:#173863;
  class OWNERS main;
  class ALLOWMOD,ROLESMOD,DELAY,SUB,DEL mod;
```

### 6.2. Gotova rješenja (research) — što već postoji

```mermaid
mindmap
  root((Tiered i<br/>multisig admin))
    Safe_native
      Allowance_Spending_Limit_modul
        1 delegat dnevni cap
        u app.safe.global UI
      Globalni threshold M-of-N
    Zodiac_Gnosis_Guild
      Roles_Modifier
        Lower threshold for routine tx
        per-arg amount cap
      Delay_Modifier
        timelock velike tx
      Pilot
        extension routing kroz role
    ERC-7579_buducnost
      Safe7579_adapter
      Rhinestone_Smart_Sessions
        per-amount per-target time-boxed
    Offline_air-gap
      Safe_Protocol_Kit
        getAddress i createDeploymentTx
      Safe_CLI_Python
      Coldcard_Keystone
    Admin_UX
      Den_onchainden
      Zodiac_Pilot
      batched_txs
```

---

## 7. SDK / pinka handoff (gdje napredna opcija ulazi)

Pinka kampanja traži novčanik preko `dw_create_account` handoffa. Napredne opcije
prenose se kao dodatni query parametri; potvrda i generiranje EOA-a ostaju u
wallet origin-u (self-custody — tajne nikad ne napuštaju wallet domenu).

```mermaid
sequenceDiagram
  autonumber
  participant P as pinka app
  participant SDK as sdk.js
  participant W as wallet.domovina.ai (Landing)
  participant PDF as PDF
  participant BE as Backend

  P->>SDK: createAccount({name, advanced:{extraEoa:N, threshold:M}})
  SDK->>W: redirect ?dw_create_account=1&dw_name&dw_eoa=N&dw_thr=M&dw_return
  W->>W: consent screen ("Dozvoli kreiranje računa")
  W->>W: generiraj N EOA in-memory, owners+threshold
  W->>PDF: print A4 + 15×10 cm
  W->>BE: POST account {owners, threshold, saltNonce}
  W->>P: redirect natrag (dw_account, dw_safe, dw_salt, dw_signer)
  Note over P,W: Tajne EOA-a NIKAD ne idu u pinka app — samo adrese
```

---

## 8. Stablo odluke — što odabrati za koji slučaj

```mermaid
flowchart TB
  Q0([Čemu služi novčanik?]) --> P{Osobni / mali iznosi?}
  P -->|Da| DEF["DEFAULT 1-of-2<br/>(danas) — ništa ne mijenjaš"]
  P -->|Ne| K{Kampanja / više organizatora?}
  K -->|"Jedan smije sam,<br/>treba samo redundancija"| F1["FAZA 1: 1-of-N + PDF<br/>(preporuka za pinka MVP)"]
  K -->|"Treba suglasnost više njih"| F2["FAZA 2: M-of-N + co-sign UX"]
  F2 --> BIG{Veći treasury<br/>s tieringom?}
  BIG -->|Da| F3["FAZA 3: Zodiac Roles + Allowance<br/>(usvoji gotovo, admin u Pilot/Den)"]
  BIG -->|Ne| F2DONE([M-of-N dovoljno])

  classDef def fill:#e6f0ff,stroke:#002F6C;
  classDef f1 fill:#e8f5e9,stroke:#2e7d32;
  classDef f2 fill:#fff8e1,stroke:#f9a825;
  classDef f3 fill:#fce4ec,stroke:#c2185b;
  class DEF def;
  class F1 f1;
  class F2,F2DONE f2;
  class F3 f3;
```

---

## 9. Sažetak preporuke

1. **Faza 1 odmah** — `owners`-as-data + `threshold` polje (default 1) + `+N` EOA
   + prošireni PDF. Ne dira relay. Gasi pinka 1/1 trap.
2. **Faza 2 kasnije** — M-of-N traži zaseban co-signing UX; PDF postaje kritičan.
3. **Faza 3 nikad u core** — Zodiac Roles + Allowance modul; admin kroz Pilot/Den,
   ne reimplementirati app.safe.global.

**Invarijanta:** owner-lista + threshold se **persistiraju** (CREATE2
reproducibilnost preko uređaja); tajne EOA-a se **prikažu jednom** (PDF) i nikad
ne spremaju — isti obrazac kao postojeći `recoveryOwner`.

---

### Izvori (research)

- Zodiac Roles — [Lower Threshold for Routine Transactions](https://docs.roles.gnosisguild.org/tutorials/lower-threshold-routine-transactions)
- Safe — [Spending Limits](https://help.safe.global/en/articles/40842-set-up-and-use-spending-limits) · [Smart Account Modules](https://docs.safe.global/advanced/smart-account-modules)
- Safe — [ERC-7579 / Safe7579](https://docs.safe.global/advanced/erc-7579/7579-safe) · [Smart Sessions](https://github.com/erc7579/smartsessions)
- Safe — [Protocol Kit Deployment](https://docs.safe.global/sdk/protocol-kit/guides/safe-deployment) · SEAL [Secure Multisig Best Practices](https://frameworks.securityalliance.org/wallet-security/secure-multisig-best-practices/)
