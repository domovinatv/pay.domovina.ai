export function BrandHeader() {
  return (
    <header className="flex flex-col items-center gap-2 pt-12 pb-8">
      <div className="flex h-1 w-32 overflow-hidden rounded-full">
        <div className="flex-1 bg-domovina-red" />
        <div className="flex-1 bg-white border-y border-gray-200" />
        <div className="flex-1 bg-domovina-navy" />
      </div>
      <h1 className="text-3xl font-bold tracking-tight">DOMOVINA</h1>
      <p className="text-sm text-gray-500 uppercase tracking-widest">Wallet</p>
    </header>
  );
}
