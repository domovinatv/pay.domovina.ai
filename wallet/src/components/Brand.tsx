export function BrandHeader() {
  return (
    <header className="flex flex-col items-center gap-2 pt-12 pb-8">
      <div className="flex h-1 w-32 overflow-hidden rounded-pill">
        <div className="flex-1 bg-brand-red-500" />
        <div className="flex-1 bg-surface-raised border-y border-surface-border" />
        <div className="flex-1 bg-brand-navy-700" />
      </div>
      <h1 className="text-3xl font-bold tracking-tight text-ink-primary">DOMOVINA</h1>
      <p className="text-sm text-ink-muted uppercase tracking-widest">Wallet</p>
    </header>
  );
}
