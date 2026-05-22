import { useState } from 'react';

export function AddressView({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;

  return (
    <button
      type="button"
      onClick={copy}
      className="font-mono text-sm text-gray-600 hover:text-domovina-navy active:scale-[0.98] transition"
      title={address}
    >
      {copied ? 'Kopirano ✓' : short}
    </button>
  );
}
