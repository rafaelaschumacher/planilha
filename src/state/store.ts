/**
 * Estado da aplicação.
 *
 * A base inteira fica em memória e o IndexedDB é a cópia durável. Para o
 * volume de um controle pessoal (alguns milhares de lançamentos por ano) isso
 * é o desenho mais simples E o mais correto: todas as telas leem exatamente os
 * mesmos dados, então dashboard, visão semanal e relatórios não têm como
 * divergir entre si.
 *
 * Toda escrita passa por `assertValidTransaction`, que valida antes de gravar.
 */

import { useSyncExternalStore } from 'react';
import { db, ensureSeeded, loadDataset, replaceDataset, resetDatabase } from '../db/database';
import type {
  Account,
  Budget,
  Card,
  Category,
  CategoryRule,
  FinanceDataset,
  ID,
  ImportBatch,
  RecurringRule,
  Settings,
  Transaction,
} from '../domain/types';
import { emptyDataset } from '../domain/types';
import { assertValidTransaction, newId } from '../domain/transaction';
import { buildDemoDataset } from '../db/demo';

export interface StoreState {
  status: 'loading' | 'ready' | 'error';
  error?: string;
  data: FinanceDataset;
}

let state: StoreState = { status: 'loading', data: emptyDataset() };
const listeners = new Set<() => void>();

function emit(next: StoreState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => state;

export function useStore(): StoreState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useDataset(): FinanceDataset {
  return useStore().data;
}

/** Recarrega tudo do banco. Chamado após qualquer escrita. */
async function refresh(): Promise<void> {
  const data = await loadDataset();
  emit({ status: 'ready', data });
}

let initialized = false;

export async function initStore(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    await ensureSeeded();
    await refresh();
  } catch (error) {
    emit({
      status: 'error',
      data: emptyDataset(),
      error:
        error instanceof Error
          ? error.message
          : 'Não foi possível abrir o banco local. Navegação anônima e bloqueio de dados de site impedem o armazenamento.',
    });
  }
}

const now = () => new Date().toISOString();

export const actions = {
  // --- Contas ------------------------------------------------------------
  async saveAccount(account: Account): Promise<void> {
    await db.accounts.put({ ...account, updatedAt: now() });
    await refresh();
  },

  async deleteAccount(id: ID): Promise<void> {
    const used = await db.transactions.where('accountId').equals(id).count();
    const asTarget = await db.transactions.where('toAccountId').equals(id).count();
    if (used + asTarget > 0) {
      throw new Error(
        `Esta conta tem ${used + asTarget} lançamento(s). Arquive em vez de excluir — excluir deixaria os lançamentos órfãos e o histórico errado.`,
      );
    }
    await db.accounts.delete(id);
    await refresh();
  },

  // --- Cartões -----------------------------------------------------------
  async saveCard(card: Card): Promise<void> {
    await db.cards.put({ ...card, updatedAt: now() });
    await refresh();
  },

  async deleteCard(id: ID): Promise<void> {
    const used = await db.transactions.where('cardId').equals(id).count();
    if (used > 0) {
      throw new Error(
        `Este cartão tem ${used} lançamento(s). Arquive em vez de excluir — o histórico das faturas depende dele.`,
      );
    }
    await db.cards.delete(id);
    await refresh();
  },

  // --- Categorias --------------------------------------------------------
  async saveCategory(category: Category): Promise<void> {
    await db.categories.put({ ...category, updatedAt: now() });
    await refresh();
  },

  async deleteCategory(id: ID): Promise<void> {
    const used = await db.transactions.where('categoryId').equals(id).count();
    const children = await db.categories.where('parentId').equals(id).count();
    if (children > 0) throw new Error('Esta categoria tem subcategorias. Remova ou mova as subcategorias primeiro.');
    if (used > 0) {
      throw new Error(`Esta categoria é usada por ${used} lançamento(s). Arquive-a para parar de sugeri-la.`);
    }
    await db.categories.delete(id);
    await db.budgets.where('categoryId').equals(id).delete();
    await refresh();
  },

  // --- Lançamentos -------------------------------------------------------
  async saveTransaction(transaction: Transaction): Promise<void> {
    assertValidTransaction(transaction);
    await db.transactions.put({ ...transaction, updatedAt: now() });
    await refresh();
  },

  async saveTransactions(transactions: Transaction[]): Promise<void> {
    transactions.forEach(assertValidTransaction);
    await db.transactions.bulkPut(transactions);
    await refresh();
  },

  async deleteTransaction(id: ID): Promise<void> {
    await db.transactions.delete(id);
    await refresh();
  },

  /** Exclui a compra parcelada inteira — todas as parcelas de uma vez. */
  async deleteInstallmentGroup(groupId: ID): Promise<number> {
    const count = await db.transactions.where('installmentGroupId').equals(groupId).delete();
    await refresh();
    return count;
  },

  async deleteImportBatch(batchId: ID): Promise<number> {
    const count = await db.transactions.where('importBatchId').equals(batchId).delete();
    await db.imports.delete(batchId);
    await refresh();
    return count;
  },

  /** Categorização manual: vira a verdade e para de pedir revisão. */
  async setCategory(id: ID, categoryId: ID | undefined): Promise<void> {
    const tx = await db.transactions.get(id);
    if (!tx) return;
    const updated: Transaction = {
      ...tx,
      categorySource: categoryId ? 'manual' : 'none',
      needsReview: !categoryId,
      updatedAt: now(),
    };
    if (categoryId) updated.categoryId = categoryId;
    else delete updated.categoryId;
    await db.transactions.put(updated);
    await refresh();
  },

  async markReviewed(ids: ID[]): Promise<void> {
    await db.transaction('rw', db.transactions, async () => {
      for (const id of ids) {
        const tx = await db.transactions.get(id);
        if (tx) await db.transactions.put({ ...tx, needsReview: false, updatedAt: now() });
      }
    });
    await refresh();
  },

  // --- Orçamento ---------------------------------------------------------
  async saveBudget(budget: Budget): Promise<void> {
    // Um único orçamento por categoria e período — dois limites concorrentes
    // fariam a tela mostrar um número e o cálculo usar outro.
    const existing = (await db.budgets.toArray()).find(
      (b) => b.categoryId === budget.categoryId && b.month === budget.month && b.id !== budget.id,
    );
    if (existing) await db.budgets.delete(existing.id);
    await db.budgets.put({ ...budget, updatedAt: now() });
    await refresh();
  },

  async deleteBudget(id: ID): Promise<void> {
    await db.budgets.delete(id);
    await refresh();
  },

  // --- Regras e recorrências --------------------------------------------
  async saveRule(rule: CategoryRule): Promise<void> {
    await db.rules.put({ ...rule, updatedAt: now() });
    await refresh();
  },

  async deleteRule(id: ID): Promise<void> {
    await db.rules.delete(id);
    await refresh();
  },

  async saveRecurring(rule: RecurringRule): Promise<void> {
    await db.recurring.put({ ...rule, updatedAt: now() });
    await refresh();
  },

  async deleteRecurring(id: ID): Promise<void> {
    await db.recurring.delete(id);
    await refresh();
  },

  // --- Importação --------------------------------------------------------
  async commitImport(batch: Omit<ImportBatch, 'id' | 'importedAt'>, transactions: Transaction[]): Promise<ID> {
    const id = newId('imp');
    transactions.forEach(assertValidTransaction);
    await db.transaction('rw', db.transactions, db.imports, async () => {
      await db.imports.add({ ...batch, id, importedAt: now() });
      await db.transactions.bulkAdd(transactions.map((t) => ({ ...t, importBatchId: id })));
    });
    await refresh();
    return id;
  },

  // --- Configurações -----------------------------------------------------
  async saveSettings(settings: Partial<Settings>): Promise<void> {
    const current = (await db.settings.get('singleton')) ?? state.data.settings;
    await db.settings.put({ ...current, ...settings, id: 'singleton', updatedAt: now() });
    await refresh();
  },

  // --- Base inteira ------------------------------------------------------
  async restoreBackup(data: FinanceDataset): Promise<void> {
    await replaceDataset(data);
    await refresh();
  },

  async loadDemoData(): Promise<void> {
    await replaceDataset(buildDemoDataset());
    await refresh();
  },

  async wipeEverything(): Promise<void> {
    await resetDatabase();
    await refresh();
  },
};
