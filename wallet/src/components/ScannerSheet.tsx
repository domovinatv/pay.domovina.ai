import { useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';
import { CameraOff, ScanLine } from 'lucide-react';
import { Sheet, Button } from '../ui';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResult: (raw: string) => void;
};

type ScanState = 'idle' | 'starting' | 'scanning' | 'denied' | 'no-camera' | 'error';

export function ScannerSheet({ open, onOpenChange, onResult }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const [state, setState] = useState<ScanState>('idle');
  const [errMsg, setErrMsg] = useState<string>('');

  useEffect(() => {
    if (!open) {
      scannerRef.current?.stop();
      scannerRef.current?.destroy();
      scannerRef.current = null;
      setState('idle');
      return;
    }
    if (!videoRef.current) return;

    let cancelled = false;
    setState('starting');

    (async () => {
      try {
        const hasCamera = await QrScanner.hasCamera();
        if (!hasCamera) {
          if (!cancelled) setState('no-camera');
          return;
        }
        if (!videoRef.current) return;
        const scanner = new QrScanner(
          videoRef.current,
          (result) => {
            // Stop immediately so we don't fire onResult multiple times.
            scanner.stop();
            onResult(result.data);
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
        if (!cancelled) setState('scanning');
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (/permission|denied|notallowed/i.test(msg)) {
          setState('denied');
        } else {
          setState('error');
          setErrMsg(msg);
        }
      }
    })();

    return () => {
      cancelled = true;
      scannerRef.current?.stop();
      scannerRef.current?.destroy();
      scannerRef.current = null;
    };
  }, [open, onResult]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Skeniraj QR" description="Usmjeri kameru na QR drugog wallet-a">
      <div className="flex flex-col gap-4">
        <div className="relative aspect-square rounded-2xl overflow-hidden bg-black ring-1 ring-surface-border">
          {/* The qr-scanner lib draws its own scan-region overlay; we just provide
              the video element + a centered fallback when camera is unavailable. */}
          <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" muted playsInline />
          {state !== 'scanning' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 text-white px-6 text-center">
              {state === 'starting' && (
                <>
                  <ScanLine className="h-10 w-10 animate-pulse" />
                  <p className="text-sm">Pokrećem kameru…</p>
                </>
              )}
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
                    Pristup kameri je odbijen. Dozvoli kameru u postavkama preglednika
                    pa pokušaj ponovno.
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

        <p className="text-xs text-ink-muted text-center">
          Podržan format: EIP-681 (Ethereum URI) ili 0x… adresa.
        </p>

        <Button variant="secondary" size="md" block onClick={() => onOpenChange(false)}>
          Zatvori
        </Button>
      </div>
    </Sheet>
  );
}
