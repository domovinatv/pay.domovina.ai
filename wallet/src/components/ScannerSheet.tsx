import { useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';
import { CameraOff, ScanLine, ImagePlus } from 'lucide-react';
import { Sheet, Button } from '../ui';
import { haptic } from '../lib/haptic';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResult: (raw: string) => void;
};

type ScanState = 'idle' | 'starting' | 'scanning' | 'denied' | 'no-camera' | 'error';

export function ScannerSheet({ open, onOpenChange, onResult }: Props) {
  // Stash the result callback in a ref so the effect that owns the scanner
  // does not re-run every time the parent re-renders (which it does — Send
  // re-renders on every keystroke, and the parent passes a fresh inline
  // function each time).
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  const [state, setState] = useState<ScanState>('idle');
  const [errMsg, setErrMsg] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const [galleryBusy, setGalleryBusy] = useState(false);

  async function handleGalleryFile(file: File) {
    setGalleryError(null);
    setGalleryBusy(true);
    try {
      const result = await QrScanner.scanImage(file, { returnDetailedScanResult: true });
      haptic('tap');
      // Tear scanner down first — onResult navigates away from the sheet.
      const s = scannerRef.current;
      scannerRef.current = null;
      if (s) {
        s.stop();
        s.destroy();
      }
      onResultRef.current(result.data);
    } catch {
      setGalleryError('U slici nije pronađen QR kod.');
      haptic('error');
    } finally {
      setGalleryBusy(false);
    }
  }

  // The video element is owned by the Radix portal — use a callback ref so
  // we get notified the moment it mounts and unmounts. A plain useRef +
  // [open] effect can fire before the portaled <video> is in the DOM.
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);

  useEffect(() => {
    if (!open) {
      // Sheet closed → tear scanner down cleanly.
      const s = scannerRef.current;
      scannerRef.current = null;
      if (s) {
        s.stop();
        s.destroy();
      }
      setState('idle');
      setErrMsg('');
      return;
    }
    // Sheet just opened. The video element may or may not be attached yet —
    // we kick off camera bring-up in a tick so Radix has time to portal the
    // content into the DOM, and so the slide-up animation does not clash
    // with iOS Safari's compositing of <video> inside an animated container.
    let cancelled = false;
    setState('starting');
    setErrMsg('');

    const startWhenReady = async (attempts = 0) => {
      if (cancelled) return;
      const videoEl = videoElRef.current;
      if (!videoEl) {
        if (attempts > 40) return; // ~2s budget, then give up silently
        setTimeout(() => startWhenReady(attempts + 1), 50);
        return;
      }
      try {
        const hasCamera = await QrScanner.hasCamera();
        if (cancelled) return;
        if (!hasCamera) {
          setState('no-camera');
          return;
        }
        const scanner = new QrScanner(
          videoEl,
          (result) => {
            scanner.stop();
            onResultRef.current(result.data);
          },
          {
            highlightScanRegion: true,
            highlightCodeOutline: true,
            preferredCamera: 'environment',
            returnDetailedScanResult: true,
          },
        );
        scannerRef.current = scanner;
        await scanner.start();
        // Some iOS Safari builds need an explicit play() nudge once the
        // stream is attached, otherwise the <video> stays paused/black even
        // though the camera is running.
        try {
          await videoEl.play();
        } catch {
          /* ignore — start() already invoked play() */
        }
        if (cancelled) {
          scanner.stop();
          scanner.destroy();
          scannerRef.current = null;
          return;
        }
        setState('scanning');
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (/permission|denied|notallowed|not allowed/i.test(msg)) {
          setState('denied');
        } else {
          setState('error');
          setErrMsg(msg);
        }
      }
    };

    startWhenReady();

    return () => {
      cancelled = true;
      const s = scannerRef.current;
      scannerRef.current = null;
      if (s) {
        s.stop();
        s.destroy();
      }
    };
    // Intentionally only `open` — onResult is stashed in a ref so the
    // scanner is created exactly once per open/close cycle.
  }, [open]);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Skeniraj QR"
      description="Usmjeri kameru na QR drugog wallet-a"
    >
      <div className="flex flex-col gap-4">
        <div className="relative aspect-square rounded-2xl overflow-hidden bg-black ring-1 ring-surface-border">
          <video
            ref={(el) => {
              videoElRef.current = el;
            }}
            className="absolute inset-0 w-full h-full object-cover"
            muted
            playsInline
            autoPlay
          />
          {state !== 'scanning' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-white px-6 text-center">
              {state === 'idle' || state === 'starting' ? (
                <>
                  <ScanLine className="h-10 w-10 animate-pulse" />
                  <p className="text-sm">Pokrećem kameru…</p>
                  <p className="text-xs opacity-70 max-w-xs">
                    Ako se ne pojavi slika, dozvoli kameru kad Safari pita.
                  </p>
                </>
              ) : null}
              {state === 'no-camera' && (
                <>
                  <CameraOff className="h-10 w-10 opacity-80" />
                  <p className="text-sm">Ovaj uređaj nema dostupnu kameru.</p>
                </>
              )}
              {state === 'denied' && (
                <>
                  <CameraOff className="h-10 w-10 opacity-80" />
                  <p className="text-sm">
                    Pristup kameri je odbijen. Dozvoli kameru u postavkama Safarija pa
                    pokušaj ponovno.
                  </p>
                </>
              )}
              {state === 'error' && (
                <>
                  <CameraOff className="h-10 w-10 opacity-80" />
                  <p className="text-sm break-all">{errMsg || 'Greška pri pokretanju kamere.'}</p>
                </>
              )}
            </div>
          )}
        </div>

        <Button
          variant="secondary"
          size="md"
          block
          disabled={galleryBusy}
          onClick={() => {
            haptic('tap');
            fileInputRef.current?.click();
          }}
        >
          <ImagePlus className="h-4 w-4" />
          {galleryBusy ? 'Učitavam sliku…' : 'Učitaj iz galerije'}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset the input so picking the same file twice still fires onChange.
            e.target.value = '';
            if (file) void handleGalleryFile(file);
          }}
        />

        {galleryError && (
          <p className="text-sm text-brand-red-700 text-center" role="alert">
            {galleryError}
          </p>
        )}

        <p className="text-xs text-ink-muted text-center">
          Podržan format: EIP-681 (Ethereum URI) ili 0x… adresa.
        </p>

        <Button variant="ghost" size="md" block onClick={() => onOpenChange(false)}>
          Zatvori
        </Button>
      </div>
    </Sheet>
  );
}
