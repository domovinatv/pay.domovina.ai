/// URL-safe SID generator. Confusable-free 32-character alphabet (no
/// 0/O/1/l/I) — same convention as Flutter's _randomSid() in home_page.dart.
/// 32^12 ≈ 1.15e18 (~60 bits); birthday-collision at 50% sits near
/// ~5e8 sids, comfortable for any realistic scale. createIntent retries
/// on PK violation up to 3 times as belt-and-braces.
export function generateSid(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const out: string[] = [];
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 12; i++) {
    out.push(chars[buf[i] % chars.length]);
  }
  return out.join('');
}
