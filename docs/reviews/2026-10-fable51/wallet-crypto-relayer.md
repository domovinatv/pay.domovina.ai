# Wallet crypto jezgra + relayer — nalazi (Fable 5.1, 2026-10-02)

Opseg: `wallet/src/lib/{passkey,bootstrap,recover,paperWallet,safeOwners,activate,eip681,accounts,safe,webauthnSig}.ts`,
`wallet/functions/**`, plus pozivna mjesta u `routes/`, `components/`,
`public/sdk.js` i `backend/src/wallets/{api,db}.ts` gdje stvarno živi granica
povjerenja walleta. Ovo je **F0 pass** koji je srpanjski review ostavio
nepokrivenim (`unverified.md` → „wallet-core-crypto"). Sve je pročitano u
cijelosti; `npx tsc --noEmit` u `wallet/` prolazi.

Posebno: **CREATE2 parity relayer ↔ klijent (XD-01) je empirijski provjeren
uživo protiv Gnosis RPC-a** — vidi „Potvrđeno dobro". Test i dalje ne postoji.

---

## A. Novi nalazi (WC-xx)

### WC-01 [SEC / MONEY-BUG] Backend-injektiran derived račun → klijent ga prikaže kao svoj → uplata ide na napadačev Safe (potvrđuje i pojačava WP-01)

**Gdje.** `wallet/src/lib/accounts.ts:288-301` (`syncAccountsWithBackend` PULL petlja), `backend/src/wallets/api.ts:205-236` (`POST /:credentialId/accounts`, bez autentikacije), `backend/src/wallets/db.ts:86-104` (`upsertAccount`), `wallet/src/routes/Embed.tsx:229-239` (isti trust u `resolveSendAccount`).

Klijent slijepo persistira svaki backend zapis: `reg[key] = { safeAddress: r.safe_address, saltNonce: r.salt_nonce, recoveryOwner: r.recovery_owner, … }` — nema `predictSafeAddressForOwners([id.signerAddress, id.recoveryOwner], 1, r.salt_nonce) === r.safe_address` niti `r.recovery_owner === id.recoveryOwner`. `credential_id` **nije tajna**: vraća ga `GET /api/wallets/family/:safeAddress` (`api.ts:123-133`), curi u `dw_cred` URL param prema host stranicama (`Landing.tsx:146`, `sdk.js:124`) i u referrere.

**Kako puca.** Napadač zna žrtvin Safe (javna adresa na QR-u) → `GET /family/<safe>` → `credential_id` → `POST /:cred/accounts` s `recoveryOwner = napadačev EOA`, `safeAddress = predict([žrtvinSigner, napadačEOA], salt)`, `name = "Ušteđevina"`. Žrtva otvori wallet (`Landing.tsx:510/561` zove sync) → račun se pojavi u switcheru → Receive prikaže tu adresu → uplata. Napadač sam deploya Safe preko factoryja (CREATE2 je permissionless) i drainira kao 1-of-2 vlasnik. Relayerov CREATE2 guard ovo **ne** hvata: štiti samo send stranu, a napadačev tuple je interno konzistentan.

**Popravak.** (1) Klijent: u `syncAccountsWithBackend` i `Embed.resolveSendAccount` prihvatiti zapis samo ako `r.recovery_owner === id.recoveryOwner` (lokalno verificiran, vidi WC-02) **i** `predictSafeAddressForOwners(derivedOwners(id.signerAddress, id.recoveryOwner), 1, r.salt_nonce) === r.safe_address`; sve ostalo odbaciti + `console.warn`. (2) Backend: u `POST /:cred/accounts` učitati `wallet_registry` red i odbiti ako `body.recoveryOwner !== row.recovery_owner` ili CREATE2 ne odgovara `[row.signer_address, row.recovery_owner]` — predict kod već postoji u `wallet/functions/_lib/safe.ts` (vidi `backend-money-rail.md` BW-18 i plan P0-3). (3) Write rute zahtijevaju passkey potpis nad payloadom.

---

### WC-02 [SEC / MONEY-BUG] Otrovan `recovery_owner`: neautenticirani backfill + klijent ga persistira bez on-chain provjere (potvrđuje WP-02, s nijansom)

**Gdje.** `backend/src/wallets/db.ts:53-60` (`UPDATE … SET recovery_owner=? WHERE … recovery_owner IS NULL`, iz javnog `POST /api/wallets`), `wallet/src/routes/Landing.tsx:546` (`recoveryOwner: remote.recovery_owner` → `savePasskey` :548), `wallet/src/lib/accounts.ts:381-390` (backend grana u `ensureRecoveryOwner`), `accounts.ts:355-358` (ako je `rec.recoveryOwner` već postavljen, on-chain provjera se preskače).

Nijansa u odnosu na srpanj: `ensureRecoveryOwner` sada **preferira** on-chain `getOwners()` (`:368-380`) — dobro. Ali (a) cross-device restore u `enterByCredentialId` ne prolazi tu logiku — upisuje `remote.recovery_owner` izravno u identitet, nakon čega `ensureRecoveryOwner` rano izlazi (`:355`); (b) backend grana (`:386-387`) ostaje za nedeployani bootstrap Safe, a komentar „counterfactual → holds NO funds, so a wrong value here can strand nothing" je kriv: vrijednost ulazi u IDENTITET (`:394`) i u CREATE2 preimage **svih** budućih derived računa; (c) `GpCardScreen.tsx:404-410` dodaje `recoveryOwner` iz storea kao ownera Gnosis Pay Safea.

**Kako puca.** Legacy red (`recovery_owner IS NULL`) ili red registriran bez `recoveryOwner`. Napadač s `credential_id` pošalje `POST /api/wallets` s istim `credentialId` + `recoveryOwner = napadač`; INSERT je no-op, backfill UPDATE prođe. Žrtva na novom uređaju → `Landing.tsx:546` persistira napadača → svaki „Novi račun" je 1-of-2 `[žrtva, napadač]`; GP kartica dobije napadača kao ownera.

**Popravak.** (1) Backend: maknuti backfill (ili uvjetovati on-chain: `getOwners(safe_address)` sadrži `recoveryOwner` i on je codeless). (2) Klijent: `recoveryOwner` iz backenda nikad ne upisivati izravno — u `enterByCredentialId` ostaviti `undefined` i pustiti `ensureRecoveryOwner` da ga izvede on-chain; backend grana smije samo **predložiti** vrijednost koja se ne persistira dok nije potvrđena on-chain (bootstrap Safe je ionako uvijek deployan pri kreiranju — `bootstrap-deploy.ts:234` čeka receipt). (3) Ispraviti komentar na `accounts.ts:382-384`.

---

### WC-03 [SEC] Cross-device restore vjeruje cijelom backend identitetu (pubKey, signer, safe) bez on-chain/assertion provjere

**Gdje.** `Landing.tsx:537-548` (`restored` zapis), `Landing.tsx:934-955` (`healStubPubKey` — pubKey iz backenda), `Send.tsx:277-290` (isti heal), `Embed.tsx:119-126` (`resolveSigningRecord`), `backend/src/wallets/db.ts:31-50` (`INSERT OR IGNORE` = first-writer-wins).

`INSERT OR IGNORE` znači da napadač ne može prepisati postojeći red — dobro. Ali `registerWalletWithBackend` je fire-and-forget (`Landing.tsx:476`, `registry.ts:41-68`); ako prvi POST ne prođe, prvi tko upiše red s tim `credentialId` definira `pub_key`, `signer_address`, `safe_address` koje klijent na drugom uređaju persistira kao istinu. Klijent ne provjerava ni `getSigner(pub_key) === signer_address`, ni da `getOwners(safe_address)` sadrži signer, ni da pubKey odgovara passkeyu koji je korisnik upravo odabrao.

**Popravak.** Pri restoreu: (1) `signerAddress` uvijek izvesti lokalno iz pubKeya; (2) `safe_address` prihvatiti samo ako on-chain `getOwners(safe_address)` sadrži taj signer; (3) pubKey verificirati protiv stvarne assertion — `pickExistingPasskey` već radi `get()`, `recover.ts` već ima `recoverPubkeys()` → backend pubKey mora biti jedan od 2 kandidata. Backend tako postaje cache, ne izvor istine (ADR 0001).

---

### WC-04 [RISK] Relayer hot path: cilj nije verificiran kao Safe i nema gornje granice gasa → „global gas budget" je zapravo budget **poziva**

**Gdje.** `wallet/functions/api/relay.ts:218` (`isDeployed(safeAddress)` jedini uvjet), `:240-242` (`sendTransaction` bez `gas`), `wallet/functions/_lib/limits.ts:61` (`globalDaily: 1000` broji pozive).

Bilo koja adresa s kodom prolazi pre-flight. Napadač deploya ugovor čiji fallback troši sav gas bez reverta; `estimateGas` vrati ~block limit i relayer plati. Postojeći threat model računa s normalnim profilom (~150–400k gas); ovdje je multiplikator ~40–100× po pozivu (Gnosis block limit ~17M — NEPROVJERENO).

**Kako puca.** 25 poziva/IP/dan × ~17M gas, ili 1000 globalno → relayerov xDAI ode u jednom danu. Bez gubitka korisničkih sredstava.

**Popravak.** (1) Eksplicitni `gas` cap na oba `sendTransaction` (hot ~1.5M, cold ~3.5M — izmjeriti). (2) Hot path: verificirati da je `safeAddress` Safe proxy — `getCode` vs poznati 1.4.1 proxy runtime bytecode i/ili `storage slot 0 === SAFE_SINGLETON`; (3) `getOwners()` mora sadržavati `signerAddress`. (4) Limit brojati u stvarnom gasu iz receipta ili preimenovati u „calls/day".

---

### WC-05 [BUG-nisko] Relayer cold path vjeruje `body.signerAddress` umjesto da ga izvede iz pubKeya

**Gdje.** `relay.ts:207` (`coldOwners = [signerAddress, …]`), `:308`, `:248-256` (`createSigner(pubKeyX, pubKeyY)`). Usporedi `bootstrap-deploy.ts:123-128` koji signer ispravno računa.
**Kako puca.** `signerAddress ≠ getSigner(pubKey)` → bundle deploya signer na S1, Safe s ownerom S2 → `checkSignatures` revert → MultiSend revert (glasno, bez strandinga), ali `500 Submit failed` umjesto `400`. Uz WC-03 realan put.
**Popravak.** `getSigner(pubKeyX, pubKeyY, verifiers) !== body.signerAddress` → `400 signerAddress does not match pubkey`.

---

### WC-06 [BUG] `/recover` hardkodira Safe nonce 0 → recovery ne radi na već deployanom Safeu

**Gdje.** `wallet/src/lib/recover.ts:212-219` (`getSafeTxHash(args.safe, { …, nonce: 0n })`).
Komentar: „the Safe has no code yet" — ali `readSafeNonce` (`safe.ts:223-231`) već vraća 0 za counterfactual i pravi nonce za deployani. Deployan Safe (djelomični recovery, `activateAccount`) → potpis nad krivim nonceom → revert → `500`. Korisnik u „izgubio sam passkey" scenariju dobije beskorisnu grešku.
**Popravak.** Maknuti `nonce: 0n`.

---

### WC-07 [BUG-nisko] „Dodaj passkey" (`ExpandAccess`) ne šalje `saltNonce`/`recoveryOwner` → odbijen na nedeployanom derived računu

**Gdje.** `ExpandAccess.tsx:162-170`.
Za aktivni derived račun bez koda relay ide cold path s `coldOwners=[signer]`, salt 0 → CREATE2 guard (`relay.ts:290-302`) → 400. Guard radi svoje, ali feature tiho ne radi za polovicu računa. Uz to novi `PasskeyRecord` dobiva `safeAddress = derived Safe` (`:177-186`), pa ga `bootstrapAccountView` kasnije tretira kao bootstrap identitet.
**Popravak.** Proslijediti `saltNonce`/`recoveryOwner` kad je `accountKind === 'derived'` (isti spread kao `Send.tsx:356-357`) ili zabraniti na nedeployanom uz „prvo Aktiviraj račun".

---

### WC-08 [RISK] `ensureRecoveryOwner` fallback uzima prvog ne-signer ownera čak i ako je ugovor

**Gdje.** `accounts.ts:380`.
Ako je dodan drugi passkey (ADR 0008) a seed EOA uklonjen, „recovery owner" postaje drugi WebAuthn signer proxy. Derived računi su `[passkey1, passkey2]` — korisnikovi, ali UI (`Settings.tsx:359-376`, paper wallet tekst) obećava da seed pokriva te račune, što nije istina.
**Popravak.** Bez codeless kandidata → `ro = null` i UI „recovery seed nije dostupan za nove račune".

---

### WC-09 [BUG-nisko] `nextSaltNonce` race s fire-and-forget syncom → re-mint postojećeg salta

**Gdje.** `accounts.ts:183-193`, `Landing.tsx:510-511` (`void syncAccountsWithBackend`), `WalletSwitcherSheet.tsx:102-106`.
Uređaj B klikne „Novi račun" prije PULL-a → salt N koji A već koristi → ista adresa (bez gubitka), ali backend upsert (`db.ts:93-95`) prepiše `name`, korisnik vidi „novi" račun koji već ima balans.
**Popravak.** `deriveAccount` najprije `await syncAccountsWithBackend` (ili `max(local, remote) + 1`); backend `ON CONFLICT` ne prepisuje `name` ako je `salt_nonce` različit.

---

### WC-10 [RISK] Klijent vjeruje jednom javnom RPC-u za sve derivacije (`getSigner`, `getOwners`, `getCode`)

**Gdje.** `constants.ts:17`, `safe.ts:20-23, 52-59, 176-188`.
`predictSignerAddress` je view call — kompromitiran/MITM RPC može vratiti napadačevu adresu kao „signer" i sve derived predikcije odu na napadačev Safe. Signer adresa je čisti CREATE2 (`keccak(x,y,verifiers)` salt + poznati creation code) i može se računati offline kao što relayer radi za Safe.
**Popravak.** Lokalni CREATE2 za signer + usporedba s RPC-om (mismatch → stop); drugi RPC za cross-check kritičnih readova.

---

### WC-11 [RISK] Seed kanali u sukobu s vlastitim upozorenjem (clipboard + Downloads)

**Gdje.** `Landing.tsx:1632` (`clipboard.writeText(recoverySeed)`), `paperWallet.ts:557-581` (PDF s plaintext seedom).
Apple Universal Clipboard sinkronizira preko iClouda; iOS Downloads često u iCloud Driveu. By-design, ali bez UI napomene.
**Popravak.** Napomena uz „Kopiraj seed" i uz PDF; opcionalno auto-clear clipboarda.

---

### WC-12 [RISK-nisko] `bootstrap-deploy` 25 s receipt timeout → klijent odbaci identitet iako tx može landati

**Gdje.** `bootstrap-deploy.ts:234`, `Landing.tsx:465-466, 488-495`.
Timeout → `500` → klijent ne spremi record, mnemonic nikad ne prikaže. Safe se svejedno deploya (adresa nikad otkrivena → bez gubitka), ali passkey ostaje u keychainu, a retry minta NOVI EOA + NOVI passkey (`excludeCredentials` prazan) → duplikat identiteta.
**Popravak.** Na timeout `{ ok:false, pending:true, txHash }`; klijent polla `isSafeDeployed` do 60 s; `excludeCredentialIds` uključuje credentialId iz neuspjelog pokušaja (u memoriji).

---

### WC-13 [RISK-nisko] `eip681.decodeQR` tiho ispušta iznos na ne-decimalnom `uint256` i ne podržava `pay-` prefiks

**Gdje.** `eip681.ts:102-111`, `:54-59`. `1.5e18` → `BigInt` baci → QR prihvaćen samo kao recipient. Nije money-bug (ništa se ne zaokružuje).
**Popravak.** Parsirati `^\d+(\.\d+)?e\d+$` ili vratiti `unsupported` s razlogom.

---

### WC-14 [TEST-GAP] Nula automatiziranih testova nad cijelom crypto/gas površinom (potvrđuje WR-08)

Nema `*.test.ts` u `wallet/`. CREATE2 parity je ručno verificiran, ali to je snapshot — svaki bump protocol-kita ili promjena `buildSafeInitializer`/`derivedOwners`/`SAFE_PROXY_INIT_CODE_HASH` je ponovno slijepa. Minimalni paket: (1) parity `predictSafeProxyAddress` vs protocol-kit za 1- i 2-owner + nenulti salt; (2) `extractClientDataFields` nad snimljenim iOS/Android/Chrome `clientDataJSON`; (3) `recoverPubkeys` nad snimljenom assertionom; (4) `parseAmount`/`decodeQR` rubovi; (5) `readCount` garbage.

---

## B. Stanje srpanjskih nalaza

| ID | Stanje | Dokaz |
|---|---|---|
| WP-01 | **OTVORENO — pojačan** | `accounts.ts:288-301` bez verifikacije; backend ruta neautenticirana; `credential_id` javan. Vidi WC-01. |
| WP-02 | **OTVORENO — djelomično ublažen** | On-chain-first u `accounts.ts:368-380`; ali `Landing.tsx:546` i `accounts.ts:386-387` persistiraju backend vrijednost; backfill neautenticiran. Vidi WC-02. |
| WP-03 | OTVORENO | `archiveDerivedAccount` samo briše lokalno; sync vraća; nema tombstonea. |
| WP-04 | OTVORENO | `store.ts:44-54`. |
| WP-05 | OTVORENO | `Receive.tsx:108` float → JSON number. |
| WP-06 | OTVORENO — širi | `accounts.ts:85`, `simpleMode.ts:17`, `passkey.ts:118` prihvaćaju JSON primitive; `passkey.ts:77` `Object.entries(null)` baca u Landing renderu. |
| WP-07 | OTVORENO | `Send.tsx:249-254` samo paralelni dvoklik; bez idempotency ključa; klijentski `relay.ts` fetch bez timeouta. |
| WP-08 | OTVORENO | `Recover.tsx:41`. |
| WP-09 | OTVORENO (niže) | Ublaženo: relay vraća 409 s porukom (`relay.ts:331-353`) koja stiže hostu preko `postError`. |
| WP-10 | OTVORENO | `sdk.js:117-145`. |
| WP-11 | OTVORENO (nijansa) | Per-tx gate postoji; kumulativni ne; komentar zavaravajući. |
| WP-12 | OTVORENO | `balances.ts:44-47` zaokružuje (9.999 → „10.00"). |
| WR-01 | OTVORENO | `relay.ts:241`, `bootstrap-deploy.ts:226` bez noncea; `relayer.ts:19-25` bez `nonceManager`; viem 2.50.4 uzima `getTransactionCount` po pozivu. viemov `nonceManager` je per-isolate — za CF treba DO. |
| WR-02 | OTVORENO | `relay.ts:359-364` fallback `sendColdPath(signerNow, safeNow)` bez CREATE2 guarda (guard samo na `:283-302`). |
| WR-03 | OTVORENO | `limits.ts:99-127` read-then-write. |
| WR-04 | OTVORENO | `limits.ts:32` NaN za garbage. |
| WR-05 | OTVORENO | `relay.ts:166-195` izvan `try`. |
| WR-06 | OTVORENO (by design) | `turnstile.ts:28-29` fail-open bez signala; je li `TURNSTILE_SECRET` u prod — NEPROVJERENO. |
| WR-07 | OTVORENO | `relayer.ts:45` jedan RPC. |
| WR-08 | OTVORENO | Vidi WC-14. |

---

## C. Potvrđeno dobro (ne „popravljati")

- **CREATE2 parity relayer ↔ klijent — empirijski potvrđeno.** `SAFE_PROXY_INIT_CODE_HASH` (`functions/_lib/safe.ts:35-36`) = `keccak256(factory.proxyCreationCode() ++ abi.encode(SafeL2 singleton))` pročitan uživo s Gnosis factoryja `0x4e1D…ec67` → `0xe298…31ee`, match. Ručni `predictSafeProxyAddress([A,B], 7)` == protocol-kit 7.1.0 `getAddress()` → `0x87CF…56BC`, match. Initializer `setup(owners, 1, 0x0, '0x', CompatibilityFallbackHandler, 0x0, 0, 0x0)` isti; owner order `[signer, recoveryOwner]` (`accounts.ts:99-101` ↔ `relay.ts:207`).
- **Mnemonic nikad ne napušta memoriju.** `bootstrap.ts:99-104` (`generateMnemonic` 128-bit CSPRNG), `signAttach` potpiše i odbaci; `submitBootstrapDeploy` šalje samo adresu + potpis. Nema storage upisa, nema fetch-a prema trećima; grep `mnemonic|seed|privateKey` čist izvan UI copyja.
- **Pre-flight `getCode` obavezan** (`relay.ts:218`); cold-path guard (`:283-302`) na primarnoj grani; bootstrap guard (`bootstrap-deploy.ts:104-115`).
- **Brisanje passkeya ne postoji** — samo mrtav, zakomentiran kod s upozorenjem (`passkey.ts:627-688`).
- **Dedup po ADR-u:** random `user.id` po create (`passkey.ts:367`), `excludeCredentials` (`:369-372, 392`), get-first probe samo kad je registry prazan (`Landing.tsx:372-405`), `residentKey: 'required'`, `attestation: 'none'`.
- **'swap' (1/1 passkey-only) nije dostupan iz UI-ja** — jedini poziv je `mode: 'add'`.
- **webauthnSig.ts ispravan:** low-s (`:30`), DER 0x81 tolerancija, `extractClientDataFields` strippa `type`+`challenge` koje ugovor rekonstruira iz hasha → challenge binding na `safeTxHash` enforcea Safe on-chain. Contract-signature layout točan.
- **recover.ts ispravan:** `parseDerRaw` bez low-s (potrebno za recovery), oba recovery bita (`:98-106`), random 32-byte challenge, `userVerification: 'required'`, match samo ako `predict(getSigner(pub), salt) == target`.
- **Nema float money matha na send strani:** bigint usporedbe, exact Max string, `parseUnits`; `eip681.ts` `BigInt`/`formatUnits`/`getAddress` strict, chain-id i token provjere.
- **SDK/Embed origin model** (detalji u `wallet-ui-flutter.md`); jedini preostali problem je clickjacking (WU-01), ne origin.
- **ExpandAccess** izvodi novog ownera isključivo iz lokalno kreiranog passkeya. Cross-TLD „peer linking" iz memorije **ne postoji** u trenutnom kodu (grep prazan) — nema površine; memoriju `project_multi_passkey_safe_shipped` treba ažurirati.
- **Backend `registerWallet` je `INSERT OR IGNORE`** — postojeći pubKey/signer/safe ne može se prepisati (jedina rupa je backfill, WC-02).
- **Relayer ulazna validacija:** uint256 range, `safeAddress !== signerAddress`, `recoveryOwner !== signer/safe`, stub-0 guard, key normalizacija, threshold>1 → 409.
- **viem `sendTransaction` radi `estimateGas`** prije broadcasta — replay snimljenog `/api/relay` payloada revertira u simulaciji, ne troši gas.

## D. Neprovjereno

- Ponašanje `SafeWebAuthnSignerSingleton` prema high-s potpisima (normalizacija je svakako sigurna; ugovor nije čitan).
- Stvarni Gnosis block gas limit (WC-04 procjena ~17M iz sjećanja).
- Je li `/api/wallets/family/:safeAddress` deployan u produkciji s `credential_id` u odgovoru (kod pročitan, prod nije gađan).
- Je li `TURNSTILE_SECRET` provisioniran u prod.
