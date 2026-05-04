import type { Env } from '../types';
import type { BankingProvider } from './types';
import { EnableBankingProvider } from './enable_banking';
import { GoCardlessProvider } from './gocardless';
import { pickProvider } from './types';

export function getProvider(env: Env): BankingProvider {
  switch (pickProvider(env)) {
    case 'enable_banking':
      return new EnableBankingProvider(env);
    case 'gocardless':
      return new GoCardlessProvider(env);
  }
}

export type { BankingProvider, ProviderTransaction, ProviderAccount } from './types';
