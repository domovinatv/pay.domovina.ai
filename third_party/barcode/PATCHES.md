# barcode 2.2.9 — vendored with one fix

Source: pub.dev `barcode` 2.2.9 (Apache-2.0, https://github.com/DavBfr/dart_barcode),
only `lib/`, `LICENSE`, `pubspec.yaml`. Used through `dependency_overrides` in the root
`pubspec.yaml`.

## Patch

`lib/src/pdf417.dart`, `_getLeftCodeWord`, cluster 0: `(rows - 3) ~/ 3` → `(rows - 1) ~/ 3`.

ISO/IEC 15438 puts `(rows - 1) / 3` in both the left (cluster 0) and right (cluster 1)
row indicators; upstream already uses it on the right. With the old formula the two
disagree whenever `rows % 3 != 0`. Apple Vision reads only one side and decodes anyway;
zxing cross-checks them and rejects the symbol, so about two of three HUB3 barcodes
were unreadable on zxing-based (Android) scanners.

Found 2026-10-10, see `docs/research/aircash/05-hub3-format-provjera.md`. Drop this
directory and the override once upstream ships the fix.
