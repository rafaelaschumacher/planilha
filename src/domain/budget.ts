/**
 * Orçamento mensal por categoria.
 *
 * O gasto de uma categoria SOMA suas subcategorias: orçar "Alimentação" cobre
 * "Mercado" e "Restaurante" automaticamente. Sem isso, o orçamento pareceria
 * sempre sobrando.
 */

import { ratio, sumCents, type Cents } from './money';
import { endOfMonth, isBetween, startOfMonth, type ISOMonth } from './dates';
import { pnlEffect } from './transaction';
import type { Budget, Category, ID, Transaction } from './types';

export interface BudgetStatus {
  categoryId: ID;
  categoryName: string;
  color: string;
  limitCents: Cents;
  spentCents: Cents;
  /** Pode ser negativo quando estourou. */
  remainingCents: Cents;
  /** 0..n (pode passar de 1). */
  usageRatio: number;
  over: boolean;
  warn: boolean;
  /** `true` quando o limite veio do orçamento padrão, não de um valor do mês. */
  fromDefault: boolean;
}

/** Limite vigente de uma categoria no mês: valor do mês sobrescreve o padrão. */
export function resolveLimit(
  budgets: readonly Budget[],
  categoryId: ID,
  month: ISOMonth,
): { limitCents: Cents; fromDefault: boolean } | null {
  let fallback: Budget | undefined;
  for (const budget of budgets) {
    if (budget.categoryId !== categoryId) continue;
    if (budget.month === month) return { limitCents: budget.limitCents, fromDefault: false };
    if (budget.month === null) fallback = budget;
  }
  return fallback ? { limitCents: fallback.limitCents, fromDefault: true } : null;
}

/** IDs da categoria e de todos os seus descendentes. */
export function categoryWithDescendants(categoryId: ID, categories: readonly Category[]): Set<ID> {
  const result = new Set<ID>([categoryId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const category of categories) {
      if (category.parentId && result.has(category.parentId) && !result.has(category.id)) {
        result.add(category.id);
        grew = true;
      }
    }
  }
  return result;
}

/** Quanto foi gasto na categoria (com subcategorias) dentro do mês. */
export function spentInCategory(
  categoryId: ID,
  month: ISOMonth,
  transactions: readonly Transaction[],
  categories: readonly Category[],
  includePending = false,
): Cents {
  const ids = categoryWithDescendants(categoryId, categories);
  const start = startOfMonth(month);
  const end = endOfMonth(month);
  let total = 0;
  for (const tx of transactions) {
    if (!includePending && tx.status === 'pending') continue;
    if (!tx.categoryId || !ids.has(tx.categoryId)) continue;
    if (!isBetween(tx.date, start, end)) continue;
    total += pnlEffect(tx).expense; // reembolso entra negativo e devolve orçamento
  }
  return total;
}

export function budgetStatuses(
  month: ISOMonth,
  budgets: readonly Budget[],
  categories: readonly Category[],
  transactions: readonly Transaction[],
  warnRatio = 0.8,
): BudgetStatus[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const categoryIds = new Set(budgets.map((b) => b.categoryId));

  const statuses: BudgetStatus[] = [];
  for (const categoryId of categoryIds) {
    const resolved = resolveLimit(budgets, categoryId, month);
    if (!resolved) continue;
    const category = byId.get(categoryId);
    if (!category || category.archived) continue;

    const spentCents = spentInCategory(categoryId, month, transactions, categories);
    const usageRatio = ratio(spentCents, resolved.limitCents);
    statuses.push({
      categoryId,
      categoryName: category.name,
      color: category.color,
      limitCents: resolved.limitCents,
      spentCents,
      remainingCents: resolved.limitCents - spentCents,
      usageRatio,
      over: spentCents > resolved.limitCents,
      warn: usageRatio >= warnRatio && spentCents <= resolved.limitCents,
      fromDefault: resolved.fromDefault,
    });
  }

  return statuses.sort((a, b) => b.usageRatio - a.usageRatio);
}

export interface BudgetOverall {
  limitCents: Cents;
  spentCents: Cents;
  remainingCents: Cents;
  usageRatio: number;
  overCount: number;
  warnCount: number;
}

export function budgetOverall(statuses: readonly BudgetStatus[]): BudgetOverall {
  const limitCents = sumCents(statuses.map((s) => s.limitCents));
  const spentCents = sumCents(statuses.map((s) => s.spentCents));
  return {
    limitCents,
    spentCents,
    remainingCents: limitCents - spentCents,
    usageRatio: ratio(spentCents, limitCents),
    overCount: statuses.filter((s) => s.over).length,
    warnCount: statuses.filter((s) => s.warn).length,
  };
}
