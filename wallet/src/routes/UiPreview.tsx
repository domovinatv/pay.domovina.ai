import { useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Settings,
  Phone,
  ClipboardPaste,
  ScanLine,
  CheckCircle2,
  Wallet as WalletIcon,
} from 'lucide-react';
import {
  AddressChip,
  AddressInput,
  AmountInput,
  Badge,
  BalanceDisplay,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  Section,
  Sheet,
  Skeleton,
  StatusPill,
  useToast,
} from '../ui';

const DEMO_ADDR = '0x6693a7D110b9A92fD51b3DA0bC0F2d9d39B7b1a3';

export function UiPreview() {
  const { toast } = useToast();
  const [amount, setAmount] = useState('100,00');
  const [recipient, setRecipient] = useState(DEMO_ADDR);
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <div className="min-h-full bg-surface-base text-ink-primary">
      <header className="sticky top-0 z-10 bg-surface-base/80 backdrop-blur border-b border-surface-border">
        <div className="mx-auto max-w-md flex items-center justify-between px-4 py-3">
          <AddressChip address={DEMO_ADDR} label="Matijin wallet" />
          <IconButton
            aria-label="Postavke"
            variant="soft"
            onClick={() => setSheetOpen(true)}
          >
            <Settings />
          </IconButton>
        </div>
      </header>

      <main className="mx-auto max-w-md px-4 py-6 flex flex-col gap-8">
        <p className="text-xs uppercase tracking-[0.18em] text-ink-muted text-center">
          Phase 0 · Design system preview
        </p>

        {/* Hero balance */}
        <Card padding="lg" elevation="elevated" className="flex flex-col gap-6">
          <BalanceDisplay
            amount={1234.56}
            currency="EURe"
            lastUpdatedAgo="ažurirano prije 3 s"
          />
          <div className="grid grid-cols-2 gap-3">
            <Button variant="primary" size="lg" block>
              <ArrowDownToLine className="h-5 w-5" />
              Primi
            </Button>
            <Button variant="secondary" size="lg" block>
              <ArrowUpFromLine className="h-5 w-5" />
              Pošalji
            </Button>
          </div>
        </Card>

        {/* Loading state */}
        <Section title="Loading state" description="Skeleton dok balance stiže">
          <Card padding="lg" className="flex flex-col items-center gap-3 py-8">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-14 w-48" />
            <Skeleton className="h-3 w-32" />
          </Card>
        </Section>

        {/* Buttons */}
        <Section title="Buttons">
          <Card className="flex flex-col gap-3">
            <Button variant="primary" block>Primarna akcija</Button>
            <Button variant="secondary" block>Sekundarna</Button>
            <Button variant="ghost" block>Ghost</Button>
            <Button variant="danger" block>Opasna akcija</Button>
            <div className="flex gap-3 justify-center pt-2">
              <IconButton aria-label="Wallet" variant="solid"><WalletIcon /></IconButton>
              <IconButton aria-label="Postavke" variant="soft"><Settings /></IconButton>
              <IconButton aria-label="Telefon" variant="ghost"><Phone /></IconButton>
            </div>
            <div className="flex gap-2 justify-center">
              <Button size="sm">sm</Button>
              <Button size="md">md</Button>
              <Button size="lg">lg</Button>
              <Button size="xl">xl</Button>
            </div>
          </Card>
        </Section>

        {/* Inputs */}
        <Section title="Inputs">
          <Card className="flex flex-col gap-4">
            <Field label="Iznos" hint="Maksimalno 1 234,56 EURe">
              {() => (
                <AmountInput
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              )}
            </Field>
            <Field label="Adresa primatelja" hint="Gnosis Chain · EVM adresa">
              {() => (
                <AddressInput
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  trailing={
                    <div className="flex gap-1">
                      <IconButton aria-label="Zalijepi" size="sm" variant="ghost">
                        <ClipboardPaste />
                      </IconButton>
                      <IconButton aria-label="Skeniraj QR" size="sm" variant="ghost">
                        <ScanLine />
                      </IconButton>
                    </div>
                  }
                />
              )}
            </Field>
            <Field
              label="Broj telefona"
              error="Mora počinjati s +"
            >
              {(id) => (
                <Input
                  id={id}
                  invalid
                  placeholder="+385 …"
                  defaultValue="091 234 5678"
                />
              )}
            </Field>
          </Card>
        </Section>

        {/* Pills & badges */}
        <Section title="Status">
          <Card className="flex flex-wrap gap-2">
            <StatusPill tone="info" dot pulse>U obradi</StatusPill>
            <StatusPill tone="success" dot>Primljeno</StatusPill>
            <StatusPill tone="warning" dot>Čeka SMS</StatusPill>
            <StatusPill tone="danger" dot>Greška</StatusPill>
            <StatusPill tone="neutral">Gnosis Chain</StatusPill>
            <Badge tone="info">v0.1.0</Badge>
            <Badge tone="success">verificirano</Badge>
          </Card>
        </Section>

        {/* Toasts */}
        <Section title="Toasts">
          <Card className="flex flex-col gap-2">
            <Button
              variant="secondary"
              block
              onClick={() => toast({ variant: 'success', title: 'Adresa kopirana', description: '0x6693…D1a3' })}
            >
              Trigger success
            </Button>
            <Button
              variant="secondary"
              block
              onClick={() => toast({ variant: 'error', title: 'Slanje neuspješno', description: 'Provjeri stanje računa' })}
            >
              Trigger error
            </Button>
            <Button
              variant="secondary"
              block
              onClick={() => toast({ variant: 'info', title: 'Otvori Revolut i skeniraj QR' })}
            >
              Trigger info
            </Button>
          </Card>
        </Section>

        {/* Empty state */}
        <Section title="Empty state">
          <Card padding="none">
            <EmptyState
              icon={<WalletIcon />}
              title="Još nema transakcija"
              description="Ovdje će se prikazati tvoje uplate i isplate čim se dogode."
              action={<Button size="md">Primi prvi EURe</Button>}
            />
          </Card>
        </Section>

        {/* Address chip variants */}
        <Section title="AddressChip">
          <Card className="flex flex-col items-start gap-3">
            <AddressChip address={DEMO_ADDR} />
            <AddressChip address={DEMO_ADDR} label="Matijin wallet" />
            <AddressChip address="0x449aBCEf0000000000000000000000000000abcd" label="MPT Safe" />
          </Card>
        </Section>

        {/* Sheet */}
        <Section title="Sheet (bottom-sheet / modal)">
          <Card>
            <Button block onClick={() => setSheetOpen(true)}>Otvori postavke</Button>
          </Card>
        </Section>

        <footer className="text-center text-xs text-ink-muted py-6">
          DOMOVINA · Wallet · Phase 0 preview
        </footer>
      </main>

      <Sheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title="Postavke"
        description="Demo bottom-sheet — Phase 1 spaja stvarne postavke"
      >
        <div className="flex flex-col gap-4">
          <Card padding="md" className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            <div className="flex-1">
              <p className="font-medium">Telefon vezan</p>
              <p className="text-sm text-ink-secondary">••3456 · 12 potvrda</p>
            </div>
            <StatusPill tone="success">aktivno</StatusPill>
          </Card>
          <Field label="Adresa">
            {() => <Input readOnly value={DEMO_ADDR} className="font-mono text-sm" />}
          </Field>
          <Button variant="danger" block onClick={() => setSheetOpen(false)}>
            Odjavi se s ovog uređaja
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
