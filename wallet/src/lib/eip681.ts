// EIP-681 encoding + decoding for wallet-to-wallet P2P QR codes.
//
// Format: ethereum:<address>[@<chainId>][/<function>][?key=value[&...]]
//
// For an ERC-20 transfer of EURe on Gnosis Chain:
//   ethereum:0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430@100/transfer
//     ?address=0xRECIPIENT&uint256=1500000000000000000
//
// Decoder also accepts plain "0xADDRESS" strings (some wallets just QR the
// address) and "ethereum:0xADDRESS[@chain]" without a function — both are
// treated as "address-only" hints (no amount).

import { formatUnits, getAddress, isAddress, parseUnits, type Address } from 'viem';
import { EURE_ADDRESS, EURE_DECIMALS, GNOSIS_CHAIN_ID } from './constants';

export type DecodedQR =
  | {
      kind: 'eure-gnosis';
      recipient: Address;
      /** Decimal-formatted amount (e.g. "1.5"), or null when QR did not specify. */
      amountDecimal: string | null;
    }
  | {
      kind: 'address-only';
      recipient: Address;
    }
  | {
      kind: 'unsupported';
      reason: string;
    };

export function encodeEureTransferUri(opts: {
  recipient: Address;
  /** Decimal-formatted amount string. Omit for "scan + enter amount". */
  amountDecimal?: string;
}): string {
  const params: string[] = [`address=${opts.recipient}`];
  if (opts.amountDecimal && opts.amountDecimal.length > 0) {
    const wei = parseUnits(opts.amountDecimal, EURE_DECIMALS);
    params.push(`uint256=${wei.toString()}`);
  }
  return `ethereum:${EURE_ADDRESS}@${GNOSIS_CHAIN_ID}/transfer?${params.join('&')}`;
}

export function decodeQR(raw: string): DecodedQR {
  const text = raw.trim();
  if (!text) return { kind: 'unsupported', reason: 'Prazan QR' };

  // Plain 0x-address (most basic case).
  if (/^0x[a-fA-F0-9]{40}$/.test(text)) {
    return { kind: 'address-only', recipient: getAddress(text) };
  }

  if (!text.toLowerCase().startsWith('ethereum:')) {
    return { kind: 'unsupported', reason: 'QR nije Ethereum / EIP-681 format' };
  }

  // Strip scheme.
  const body = text.slice('ethereum:'.length);
  // Split off query string first.
  const [pathPart, queryPart = ''] = body.split('?');
  // Path: <address>[@<chainId>][/<function>]
  const fnSplit = pathPart.split('/');
  const target = fnSplit[0];
  const fn = fnSplit[1];
  const [targetAddr, chainStr] = target.split('@');
  const chainId = chainStr ? Number(chainStr) : undefined;

  if (!isAddress(targetAddr)) {
    return { kind: 'unsupported', reason: 'Adresa u QR-u nije valjana' };
  }
  const target_ = getAddress(targetAddr);

  // No function call → address-only.
  if (!fn) {
    if (chainId !== undefined && chainId !== GNOSIS_CHAIN_ID) {
      return { kind: 'unsupported', reason: `QR je za chain ${chainId}, ne Gnosis (100)` };
    }
    return { kind: 'address-only', recipient: target_ };
  }

  // ERC-20 transfer call.
  if (fn !== 'transfer') {
    return { kind: 'unsupported', reason: `Nepoznata funkcija "${fn}"` };
  }
  if (chainId !== undefined && chainId !== GNOSIS_CHAIN_ID) {
    return { kind: 'unsupported', reason: `QR je za chain ${chainId}, ne Gnosis (100)` };
  }
  if (target_.toLowerCase() !== EURE_ADDRESS.toLowerCase()) {
    return { kind: 'unsupported', reason: 'QR ne šalje EURe (drugi token)' };
  }

  // Parse query for recipient + amount.
  const params = new URLSearchParams(queryPart);
  const toRaw = params.get('address');
  if (!toRaw || !isAddress(toRaw)) {
    return { kind: 'unsupported', reason: 'Nedostaje recipient adresa' };
  }
  const recipient = getAddress(toRaw);

  // Some wallets emit `uint256`, others `value`.
  const valueRaw = params.get('uint256') ?? params.get('value');
  let amountDecimal: string | null = null;
  if (valueRaw) {
    try {
      const wei = BigInt(valueRaw);
      amountDecimal = formatUnits(wei, EURE_DECIMALS);
    } catch {
      // Malformed — skip amount but keep recipient.
    }
  }

  return { kind: 'eure-gnosis', recipient, amountDecimal };
}
