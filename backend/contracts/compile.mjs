#!/usr/bin/env node
/**
 * One-shot compile of PaymentRegistry.sol → PaymentRegistry.json.
 *
 * Uses solc-js standard-json mode so the output carries everything we need
 * for both deploy (bytecode + ABI) and Gnosisscan verify (metadata with
 * exact compiler version + settings). Run once and commit the JSON; deploy
 * script reads from disk and never recompiles, so the artifact you deploy
 * is bit-identical to the one you verify.
 *
 *   node compile.mjs              # writes ./PaymentRegistry.json
 *   node compile.mjs --quiet      # suppress info logs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, 'PaymentRegistry.sol');
const OUT = resolve(HERE, 'PaymentRegistry.json');
const SOLC_VERSION = '0.8.24';
const quiet = process.argv.includes('--quiet');

const source = readFileSync(SOURCE, 'utf8');

const standardInput = {
  language: 'Solidity',
  sources: {
    'PaymentRegistry.sol': { content: source },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris',
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'],
      },
    },
  },
};

if (!quiet) console.error(`compiling with solc ${SOLC_VERSION} (optimizer 200 runs, evmVersion paris)…`);

const result = execFileSync(
  'npx',
  ['--yes', `solc@${SOLC_VERSION}`, '--standard-json'],
  { input: JSON.stringify(standardInput), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
);

// solc-js prints an SMT availability notice on stdout before the JSON
// payload — strip everything before the first `{`.
const jsonStart = result.indexOf('{');
if (jsonStart < 0) {
  console.error('solc produced no JSON output:');
  console.error(result);
  process.exit(1);
}
const parsed = JSON.parse(result.slice(jsonStart));
const errors = (parsed.errors ?? []).filter((e) => e.severity === 'error');
if (errors.length > 0) {
  console.error('solc errors:');
  for (const e of errors) console.error(e.formattedMessage ?? e.message);
  process.exit(1);
}
for (const w of parsed.errors ?? []) {
  if (!quiet) console.error(w.formattedMessage ?? w.message);
}

const contract = parsed.contracts?.['PaymentRegistry.sol']?.PaymentRegistry;
if (!contract) {
  console.error('PaymentRegistry contract missing from solc output');
  console.error(JSON.stringify(parsed, null, 2));
  process.exit(1);
}

const artifact = {
  contractName: 'PaymentRegistry',
  source: 'PaymentRegistry.sol',
  compiler: {
    version: SOLC_VERSION,
    settings: standardInput.settings,
  },
  abi: contract.abi,
  bytecode: '0x' + contract.evm.bytecode.object,
  deployedBytecode: '0x' + contract.evm.deployedBytecode.object,
  metadata: contract.metadata,
};

writeFileSync(OUT, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
if (!quiet) {
  console.error(`wrote ${OUT}`);
  console.error(`bytecode size: ${(artifact.bytecode.length - 2) / 2} bytes`);
}
