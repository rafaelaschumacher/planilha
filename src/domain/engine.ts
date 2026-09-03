/**
 * Motor de cálculo.
 *
 * Tudo aqui é FUNÇÃO PURA sobre a base única de lançamentos. Nenhuma tela
 * guarda total próprio: o dashboard, a visão semanal, a mensal e os relatórios
 * chamam estas funções. É o que garante que os números batam entre si.
 */

import { ratio, sumCents, type Cents } from './money';
import {
  compareDate,
  endOfMonth,
  endOfWeek,
  isBetween,
  lastMonths,
  monthOf,
  startOfMonth,
  startOfWeek,
  type ISODate,
  type ISOMonth,
} from './dates';
import { accountDelta, pnlEffect } from './transaction';
import type { Account, Category, ID, PaymentMethod, Transaction } from './types';
import { UNCATEGORIZED_ID } from './types';

// ---------------------------------------------------------------------------
// Saldos
// ---------------------------------------------------------------------------

export interface BalanceOptions {
  /** Considera apenas lançamentos até esta data (inclusive). Padrão: sem limite. */
  asOf?: ISODate;
  /** Inclui lançamentos `pending` (previstos). Padrão: false. */
  includePending?: boolean;
}

/**
 * Saldo de uma conta = saldo inicial + efeito de todos os lançamentos.
 *
 * Lançamentos anteriores à data de abertura são ignorados: o saldo inicial já
 * os representa. Sem isso, importar um extrato antigo somaria duas vezes.
 */
export function accountBalance(
  account: Account,
  transactions: readonly Transaction[],
  options: BalanceOptions = {},
): Cents {
  let balance = account.openingBalanceCents;
  for (const tx of transactions) {
    if (!options.includePending && tx.status === 'pending') continue;
    if (compareDate(tx.date, account.openingDate) < 0) continue;
    if (options.asOf && compareDate(tx.date, options.asOf) > 0) continue;
    balance += accountDelta(tx, account.id);
  }
  return balance;
}

/** Saldo somado de todas as contas informadas. */
export function totalBalance(
  accounts: readonly Account[],
  transactions: readonly Transaction[],
  options: BalanceOptions = {},
): Cents {
  return sumCents(accounts.map((a) => accountBalance(a, transactions, options)));
}

export interface AccountBalance {
  account: Account;
  balanceCents: Cents;
  /** Saldo incluindo lançamentos previstos. */
  projectedCents: Cents;
}

export function accountBalances(
  accounts: readonly Account[],
  transactions: readonly Transaction[],
  asOf?: ISODate,
): AccountBalance[] {
  return accounts.map((account) => ({
    account,
    balanceCents: accountBalance(account, transactions, asOf ? { asOf } : {}),
    projectedCents: accountBalance(account, transactions, { includePending: true }),
  }));
}

// ---------------------------------------------------------------------------
// Classificação fixo x variável
// ---------------------------------------------------------------------------

/** Um gasto é fixo quando marcado no lançamento ou quando a categoria é fixa. */
export function isFixedExpense(tx: Transaction, categories: ReadonlyMap<ID, Category>): boolean {
  if (tx.isFixed) return true;
  if (!tx.categoryId) return false;
  return categories.get(tx.categoryId)?.isFixed ?? false;
}

// ---------------------------------------------------------------------------
// Resumo de período
// ---------------------------------------------------------------------------

export interface CategoryTotal {
  categoryId: ID;
  categoryName: string;
  color: string;
  /** Categoria raiz (para agrupar subcategorias). */
  rootId: ID;
  rootName: string;
  amountCents: Cents;
  /** Fatia sobre o total de despesas do período (0..1). */
  share: number;
  count: number;
}

export interface PeriodSummary {
  start: ISODate;
  end: ISODate;
  incomeCents: Cents;
  expenseCents: Cents;
  /** receitas − despesas */
  netCents: Cents;
  /** (receitas − despesas) / receitas. 0 quando não houve receita. */
  savingsRate: number;
  fixedCents: Cents;
  variableCents: Cents;
  /** Despesas pagas com cartão de crédito (competência). */
  cardExpenseCents: Cents;
  /** Despesas que saíram direto da conta. */
  accountExpenseCents: Cents;
  /** Parcelas cujo vencimento cai neste período. */
  installmentCents: Cents;
  transferCents: Cents;
  cardPaymentCents: Cents;
  refundCents: Cents;
  byCategory: CategoryTotal[];
  byRootCategory: CategoryTotal[];
  byPaymentMethod: { method: PaymentMethod; amountCents: Cents; count: number }[];
  /** Maiores despesas do período, da maior para a menor. */
  largestExpenses: Transaction[];
  transactionCount: number;
}

export interface SummaryOptions {
  includePending?: boolean;
  largestCount?: number;
}

const FALLBACK_CATEGORY: Pick<Category, 'id' | 'name' | 'color'> = {
  id: UNCATEGORIZED_ID,
  name: 'Sem categoria',
  color: '#94a3b8',
};

function rootOf(categoryId: ID | undefined, categories: ReadonlyMap<ID, Category>): Category | undefined {
  let current = categoryId ? categories.get(categoryId) : undefined;
  const seen = new Set<ID>();
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = categories.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

/**
 * Resumo de um intervalo de datas.
 *
 * Receita e despesa vêm exclusivamente de `pnlEffect()`, então transferências
 * e pagamentos de fatura ficam de fora por construção.
 */
export function periodSummary(
  transactions: readonly Transaction[],
  start: ISODate,
  end: ISODate,
  categories: ReadonlyMap<ID, Category>,
  options: SummaryOptions = {},
): PeriodSummary {
  const inPeriod = transactions.filter(
    (tx) => isBetween(tx.date, start, end) && (options.includePending || tx.status !== 'pending'),
  );

  let incomeCents = 0;
  let expenseCents = 0;
  let fixedCents = 0;
  let variableCents = 0;
  let cardExpenseCents = 0;
  let accountExpenseCents = 0;
  let installmentCents = 0;
  let transferCents = 0;
  let cardPaymentCents = 0;
  let refundCents = 0;

  const byCategory = new Map<ID, { amountCents: Cents; count: number }>();
  const byMethod = new Map<PaymentMethod, { amountCents: Cents; count: number }>();

  for (const tx of inPeriod) {
    const effect = pnlEffect(tx);
    incomeCents += effect.income;
    expenseCents += effect.expense;

    if (tx.kind === 'transfer') transferCents += tx.amountCents;
    if (tx.kind === 'card_payment') cardPaymentCents += tx.amountCents;
    if (tx.kind === 'refund' || tx.kind === 'chargeback') refundCents += tx.amountCents;

    if (effect.expense === 0) continue;

    // A partir daqui só despesas (e reembolsos, que entram negativos).
    if (isFixedExpense(tx, categories)) fixedCents += effect.expense;
    else variableCents += effect.expense;

    if (tx.cardId) cardExpenseCents += effect.expense;
    else accountExpenseCents += effect.expense;

    if (tx.installmentTotal && tx.installmentTotal > 1) installmentCents += effect.expense;

    const categoryId = tx.categoryId ?? UNCATEGORIZED_ID;
    const currentCat = byCategory.get(categoryId) ?? { amountCents: 0, count: 0 };
    currentCat.amountCents += effect.expense;
    currentCat.count += 1;
    byCategory.set(categoryId, currentCat);

    const currentMethod = byMethod.get(tx.paymentMethod) ?? { amountCents: 0, count: 0 };
    currentMethod.amountCents += effect.expense;
    currentMethod.count += 1;
    byMethod.set(tx.paymentMethod, currentMethod);
  }

  const toCategoryTotal = (categoryId: ID, data: { amountCents: Cents; count: number }): CategoryTotal => {
    const category = categories.get(categoryId);
    const root = rootOf(categoryId, categories);
    return {
      categoryId,
      categoryName: category?.name ?? FALLBACK_CATEGORY.name,
      color: category?.color ?? FALLBACK_CATEGORY.color,
      rootId: root?.id ?? categoryId,
      rootName: root?.name ?? category?.name ?? FALLBACK_CATEGORY.name,
      amountCents: data.amountCents,
      share: ratio(data.amountCents, expenseCents),
      count: data.count,
    };
  };

  const categoryTotals = Array.from(byCategory, ([id, data]) => toCategoryTotal(id, data))
    .filter((c) => c.amountCents !== 0)
    .sort((a, b) => b.amountCents - a.amountCents);

  const rootMap = new Map<ID, CategoryTotal>();
  for (const item of categoryTotals) {
    const existing = rootMap.get(item.rootId);
    if (existing) {
      existing.amountCents += item.amountCents;
      existing.count += item.count;
      existing.share = ratio(existing.amountCents, expenseCents);
    } else {
      const root = categories.get(item.rootId);
      rootMap.set(item.rootId, {
        categoryId: item.rootId,
        categoryName: item.rootName,
        color: root?.color ?? item.color,
        rootId: item.rootId,
        rootName: item.rootName,
        amountCents: item.amountCents,
        share: ratio(item.amountCents, expenseCents),
        count: item.count,
      });
    }
  }

  const largestExpenses = inPeriod
    .filter((tx) => tx.kind === 'expense')
    .sort((a, b) => b.amountCents - a.amountCents || compareDate(b.date, a.date))
    .slice(0, options.largestCount ?? 5);

  return {
    start,
    end,
    incomeCents,
    expenseCents,
    netCents: incomeCents - expenseCents,
    savingsRate: incomeCents > 0 ? (incomeCents - expenseCents) / incomeCents : 0,
    fixedCents,
    variableCents,
    cardExpenseCents,
    accountExpenseCents,
    installmentCents,
    transferCents,
    cardPaymentCents,
    refundCents,
    byCategory: categoryTotals,
    byRootCategory: Array.from(rootMap.values()).sort((a, b) => b.amountCents - a.amountCents),
    byPaymentMethod: Array.from(byMethod, ([method, data]) => ({ method, ...data })).sort(
      (a, b) => b.amountCents - a.amountCents,
    ),
    largestExpenses,
    transactionCount: inPeriod.length,
  };
}

export function monthSummary(
  month: ISOMonth,
  transactions: readonly Transaction[],
  categories: ReadonlyMap<ID, Category>,
  options: SummaryOptions = {},
): PeriodSummary {
  return periodSummary(transactions, startOfMonth(month), endOfMonth(month), categories, options);
}

export function weekSummary(
  anyDayOfWeek: ISODate,
  transactions: readonly Transaction[],
  categories: ReadonlyMap<ID, Category>,
  firstDayOfWeek: 0 | 1 = 0,
  options: SummaryOptions = {},
): PeriodSummary {
  return periodSummary(
    transactions,
    startOfWeek(anyDayOfWeek, firstDayOfWeek),
    endOfWeek(anyDayOfWeek, firstDayOfWeek),
    categories,
    options,
  );
}

// ---------------------------------------------------------------------------
// Evolução
// ---------------------------------------------------------------------------

export interface MonthPoint {
  month: ISOMonth;
  incomeCents: Cents;
  expenseCents: Cents;
  netCents: Cents;
  savingsRate: number;
  fixedCents: Cents;
  variableCents: Cents;
}

export function monthlyEvolution(
  months: readonly ISOMonth[],
  transactions: readonly Transaction[],
  categories: ReadonlyMap<ID, Category>,
): MonthPoint[] {
  return months.map((month) => {
    const s = monthSummary(month, transactions, categories);
    return {
      month,
      incomeCents: s.incomeCents,
      expenseCents: s.expenseCents,
      netCents: s.netCents,
      savingsRate: s.savingsRate,
      fixedCents: s.fixedCents,
      variableCents: s.variableCents,
    };
  });
}

/** Média das despesas dos `count` meses ANTERIORES a `month` (exclui o próprio). */
export function averageExpense(
  month: ISOMonth,
  count: number,
  transactions: readonly Transaction[],
  categories: ReadonlyMap<ID, Category>,
): Cents {
  const months = lastMonths(month, count + 1).slice(0, -1);
  if (months.length === 0) return 0;
  const total = sumCents(months.map((m) => monthSummary(m, transactions, categories).expenseCents));
  return Math.round(total / months.length);
}

/** Meses que possuem ao menos um lançamento, em ordem crescente. */
export function monthsWithData(transactions: readonly Transaction[]): ISOMonth[] {
  const set = new Set<ISOMonth>();
  for (const tx of transactions) set.add(monthOf(tx.date));
  return Array.from(set).sort();
}
