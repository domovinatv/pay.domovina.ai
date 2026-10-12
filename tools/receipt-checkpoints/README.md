# mpt-receipts-checkpoints

Javna kopija sidara **potvrda o uplati** MPT raila
([ADR 0022](https://github.com/domovinatv/pay.domovina.ai/blob/main/docs/decisions/0022-potvrda-o-uplati-vezana-uz-kljuc-uplatitelja.md),
[ADR 0023](https://github.com/domovinatv/pay.domovina.ai/blob/main/docs/decisions/0023-potvrde-nadogradnja-iz-maksimir-glasanja.md)).

Svaki dan (00:40 UTC) GitHub Action, **bez ikakve tajne**:

1. preuzme nova sidra s `https://mpt.domovina.ai/api/receipts/anchors`;
2. zapiše `anchors/<seq>.json` i `anchors/<seq>.ots` (OpenTimestamps dokaz za `sha256(chain_head)`);
3. napravi `ots upgrade` za dokaze koji još čekaju Bitcoin blok;
4. provjeri cijeli lanac skriptom `mpt_receipt_verify.py`. **Ako lanac puca, Action pada**;
5. osvježi `index.json` (`"bitcoin": true` kad dokaz ima Bitcoin atestaciju).

Zašto: dokazi ne smiju postojati samo u MPT-ovoj bazi. Ovaj repo ih čuva i kad MPT nestane, a
povijest commitova pokazuje kad je koje sidro prvi put viđeno.

## Provjera vlastite potvrde

```sh
git clone https://github.com/domovinatv/mpt-receipts-checkpoints
python3 mpt-receipts-checkpoints/mpt_receipt_verify.py mpt-potvrda-<sid>.json \
  --checkpoints mpt-receipts-checkpoints/anchors \
  --rpc https://rpc.gnosischain.com --rpc https://gnosis.drpc.org
ots verify -d $(python3 -c "import json,hashlib;print(hashlib.sha256(bytes.fromhex(json.load(open('mpt-receipts-checkpoints/anchors/1.json'))['chain_head'][2:])).hexdigest())") mpt-receipts-checkpoints/anchors/1.ots
```

`mpt_receipt_verify.py` je kopija iz `pay.domovina.ai/scripts/` (samo standardna biblioteka
Pythona). Oblik sidra:

```
chain_head = keccak256(abi.encode(prev_chain_head, seq, root, leaf_count, total_leaves, total_cents, lazy_count))
```
