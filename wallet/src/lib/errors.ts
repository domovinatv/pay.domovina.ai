// User-facing error strings for native browser errors that otherwise leak
// English text into the UI ("The request is not allowed by the user agent
// or the platform in the current context...").
//
// Strategy: map DOMException.name first (most reliable across browsers),
// then fall back to substring match on .message for cases where the name
// is generic. Always return Croatian.

type Context = 'camera' | 'passkey' | 'clipboard' | 'share' | 'generic';

export function humanizeError(err: unknown, ctx: Context = 'generic'): string {
  // 1. DOMException by name — covers most of getUserMedia, WebAuthn,
  //    clipboard, navigator.share, etc.
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
        return notAllowed(ctx);
      case 'NotFoundError':
        return notFound(ctx);
      case 'NotReadableError':
        return 'Resurs je trenutno zauzet (možda ga druga aplikacija drži). Pokušaj ponovno.';
      case 'NotSupportedError':
        return 'Ovaj preglednik ne podržava tu radnju.';
      case 'AbortError':
        return ctx === 'passkey'
          ? 'Otkazao si Face ID prompt.'
          : 'Radnja je prekinuta.';
      case 'SecurityError':
        return 'Sigurnosno ograničenje preglednika spriječilo je radnju (HTTPS / mixed-content?).';
      case 'InvalidStateError':
        return 'Krivo stanje sustava. Pokušaj ponovno.';
      case 'TimeoutError':
        return 'Isteklo je vrijeme.';
      case 'TypeError':
        return 'Neispravan format podatka.';
      case 'ConstraintError':
        return 'Sustav ne može ispuniti zahtjev s tim parametrima.';
      default:
        // Continue to substring matching below.
        break;
    }
  }

  // 2. Plain Error or unknown — look at message text. Many WebKit + Chromium
  //    builds emit the same English string; matching on a stable substring
  //    works without overfitting.
  const raw = err instanceof Error ? err.message : String(err);
  const lc = raw.toLowerCase();

  if (lc.includes('not allowed') || lc.includes('permission')) {
    return notAllowed(ctx);
  }
  if (lc.includes('user denied') || lc.includes('user cancelled')) {
    return ctx === 'passkey' ? 'Otkazao si Face ID prompt.' : 'Korisnik je odbio dozvolu.';
  }
  if (lc.includes('aborted') || lc.includes('cancel')) {
    return 'Radnja je prekinuta.';
  }
  if (lc.includes('no camera') || lc.includes('camera not found')) {
    return 'Nije pronađena dostupna kamera.';
  }
  if (lc.includes('clipboard')) {
    return 'Pristup clipboard-u nije dopušten (provjeri postavke preglednika).';
  }
  if (lc.includes('https') || lc.includes('secure context')) {
    return 'Ova radnja zahtijeva HTTPS.';
  }
  if (lc.includes('rate limit') || lc.includes('too many')) {
    return 'Dosegnut je dnevni limit. Pokušaj kasnije.';
  }

  // 3. Nothing matched — surface the original message. It may be English
  //    but at least it is the actual cause rather than a misleading
  //    translation. In practice this branch is rare for the contexts we
  //    use; most native errors hit one of the buckets above.
  return raw || 'Dogodila se nepoznata greška.';
}

function notAllowed(ctx: Context): string {
  switch (ctx) {
    case 'camera':
      return 'Pristup kameri nije dopušten. Dozvoli kameru u postavkama Safarija (Postavke → Safari → Kamera) pa pokušaj ponovno.';
    case 'passkey':
      return 'Face ID / passkey nije odobren. Pokušaj ponovno.';
    case 'clipboard':
      return 'Pristup clipboard-u nije dopušten. Klikni unutar aplikacije pa pokušaj ponovno.';
    case 'share':
      return 'Dijeljenje nije dopušteno u ovom kontekstu.';
    default:
      return 'Zatraženo dopuštenje sustav nije odobrio. Provjeri postavke privatnosti.';
  }
}

function notFound(ctx: Context): string {
  switch (ctx) {
    case 'camera':
      return 'Nije pronađena dostupna kamera.';
    case 'passkey':
      return 'Passkey nije pronađen. Otvori na izvornom uređaju ili kreiraj novi wallet.';
    default:
      return 'Traženi resurs nije pronađen.';
  }
}
