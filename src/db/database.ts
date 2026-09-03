/**
 * Banco de dados local.
 *
 * IndexedDB é um banco de verdade dentro do navegador: transacional, com
 * índices e sem limite prático para o volume de um controle pessoal. Os dados
 * NUNCA saem do seu dispositivo — não existe servidor neste projeto.
 *
 * O volume aqui é pequeno (alguns milhares de lançamentos por ano), então a
 * aplicação carrega a base inteira em memória e faz os cálculos com as funções
 * puras do domínio. Isso mantém todas as telas coerentes entre si, porque
 * todas leem exatamente os mesmos dados.
 */

import Dexie, { type EntityTable } from 'dexie';
import type {
  Account,
  Budget,
  Card,
  Category,
  CategoryRule,
  FinanceDataset,
  ImportBatch,
  RecurringRule,
  Settings,
  Transaction,
} from '../domain/types';
import { DEFAULT_SETTINGS } from '../domain/types';
import { defaultCategories, defaultRules } from '../domain/seed';

export class FinanceDatabase extends Dexie {
  accounts!: EntityTable<Account, 'id'>;
  cards!: EntityTable<Card, 'id'>;
  categories!: EntityTable<Category, 'id'>;
  transactions!: EntityTable<Transaction, 'id'>;
  budgets!: EntityTable<Budget, 'id'>;
  rules!: EntityTable<CategoryRule, 'id'>;
  recurring!: EntityTable<RecurringRule, 'id'>;
  imports!: EntityTable<ImportBatch, 'id'>;
  settings!: EntityTable<Settings, 'id'>;

  constructor(name = 'financas') {
    super(name);
    this.version(1).stores({
      accounts: 'id, name, archived',
      cards: 'id, name, archived',
      categories: 'id, parentId, kind, archived',
      // Os índices compostos cobrem as consultas que a interface faz de fato:
      // "lançamentos do mês", "desta conta", "deste cartão".
      transactions:
        'id, date, kind, accountId, cardId, toAccountId, categoryId, installmentGroupId, fingerprint, importBatchId, needsReview, [kind+date], [accountId+date], [cardId+date]',
      budgets: 'id, categoryId, month, [categoryId+month]',
      rules: 'id, priority, active',
      recurring: 'id, active',
      imports: 'id, importedAt',
      settings: 'id',
    });
  }
}

export const db = new FinanceDatabase();

/** Cria as categorias e regras iniciais na primeira vez que o app abre. */
export async function ensureSeeded(database: FinanceDatabase = db): Promise<void> {
  await database.transaction('rw', database.categories, database.rules, database.settings, async () => {
    if ((await database.categories.count()) === 0) {
      await database.categories.bulkAdd(defaultCategories());
    }
    if ((await database.rules.count()) === 0) {
      await database.rules.bulkAdd(defaultRules());
    }
    if (!(await database.settings.get('singleton'))) {
      await database.settings.add({ ...DEFAULT_SETTINGS, updatedAt: new Date().toISOString() });
    }
  });
}

/** Carrega a base inteira. É o ponto de entrada de todas as telas. */
export async function loadDataset(database: FinanceDatabase = db): Promise<FinanceDataset> {
  const [accounts, cards, categories, transactions, budgets, rules, recurring, imports, settings] =
    await Promise.all([
      database.accounts.toArray(),
      database.cards.toArray(),
      database.categories.toArray(),
      database.transactions.toArray(),
      database.budgets.toArray(),
      database.rules.toArray(),
      database.recurring.toArray(),
      database.imports.toArray(),
      database.settings.get('singleton'),
    ]);

  return {
    accounts,
    cards,
    categories,
    transactions,
    budgets,
    rules,
    recurring,
    imports,
    settings: settings ?? { ...DEFAULT_SETTINGS },
  };
}

/** Substitui TODO o conteúdo do banco. Usado ao restaurar um backup. */
export async function replaceDataset(data: FinanceDataset, database: FinanceDatabase = db): Promise<void> {
  await database.transaction(
    'rw',
    [
      database.accounts, database.cards, database.categories, database.transactions,
      database.budgets, database.rules, database.recurring, database.imports, database.settings,
    ],
    async () => {
      await Promise.all([
        database.accounts.clear(), database.cards.clear(), database.categories.clear(),
        database.transactions.clear(), database.budgets.clear(), database.rules.clear(),
        database.recurring.clear(), database.imports.clear(), database.settings.clear(),
      ]);
      await Promise.all([
        database.accounts.bulkAdd(data.accounts),
        database.cards.bulkAdd(data.cards),
        database.categories.bulkAdd(data.categories),
        database.transactions.bulkAdd(data.transactions),
        database.budgets.bulkAdd(data.budgets),
        database.rules.bulkAdd(data.rules),
        database.recurring.bulkAdd(data.recurring),
        database.imports.bulkAdd(data.imports),
        database.settings.put(data.settings),
      ]);
    },
  );
}

/** Apaga tudo e recria apenas as categorias e regras padrão. */
export async function resetDatabase(database: FinanceDatabase = db): Promise<void> {
  await database.delete();
  await database.open();
  await ensureSeeded(database);
}
