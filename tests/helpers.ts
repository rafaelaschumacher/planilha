import { buildTransaction, type TransactionDraft } from '../src/domain/transaction';
import { defaultCategories } from '../src/domain/seed';
import type { Account, Card, Category, ID, Transaction } from '../src/domain/types';

let seq = 0;
export const uid = (p = 'id') => `${p}_${(seq += 1)}`;

export function makeAccount(overrides: Partial<Account> = {}): Account {
  const timestamp = '2024-01-01T00:00:00.000Z';
  return {
    id: overrides.id ?? uid('acc'),
    name: 'Conta Teste',
    institution: 'Banco Fictício',
    type: 'checking',
    openingBalanceCents: 0,
    openingDate: '2024-01-01',
    color: '#6366f1',
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function makeCard(overrides: Partial<Card> = {}): Card {
  const timestamp = '2024-01-01T00:00:00.000Z';
  return {
    id: overrides.id ?? uid('card'),
    name: 'Cartão Teste',
    institution: 'Banco Fictício',
    limitCents: 1_000_000,
    closingDay: 20,
    dueDay: 28,
    color: '#0ea5e9',
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function tx(draft: TransactionDraft): Transaction {
  return buildTransaction(draft);
}

export const categories: Category[] = defaultCategories();
export const categoryMap: Map<ID, Category> = new Map(categories.map((c) => [c.id, c]));
