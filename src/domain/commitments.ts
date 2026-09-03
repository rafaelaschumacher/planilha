/**
 * Futuro financeiro.
 *
 *   SALDO ATUAL  −  COMPROMISSOS  =  VALOR REALMENTE DISPONÍVEL
 *
 * O maior risco aqui é contar o mesmo compromisso duas vezes. As fontes são
 * deliberadamente separadas para que não se sobreponham:
 *
 *  · FATURAS — cobrem TODAS as compras de cartão, inclusive parcelas futuras,
 *    porque cada parcela cai dentro de alguma fatura. Por isso parcelas NÃO são
 *    somadas de novo em outro lugar.
 *  · AGENDADOS — despesas em conta previstas ou com data futura.
 *  · RECORRENTES — contas fixas ainda NÃO lançadas. Se já existe o lançamento
 *    do mês, a projeção é descartada.
 */

import { sumCents, type Cents } from './money';
import {
  addMonthsToMonth,
  compareDate,
  currentMonth,
  dayInMonth,
  endOfMonth,
  monthOf,
  monthRange,
  type ISODate,
  type ISOMonth,
} from './dates';
import { listInvoices } from './invoice';
import { normalizeMerchant } from './text';
import type { Account, Card, ID, RecurringRule, Transaction } from './types';
import { accountBalance } from './engine';

export type CommitmentKind = 'invoice' | 'scheduled' | 'recurring';

export const COMMITMENT_KIND_LABEL: Record<CommitmentKind, string> = {
  invoice: 'Fatura',
  scheduled: 'Agendado',
  recurring: 'Conta fixa',
};

export interface Commitment {
  id: string;
  kind: CommitmentKind;
  label: string;
  dueDate: ISODate;
  month: ISOMonth;
  amountCents: Cents;
  cardId?: ID;
  accountId?: ID;
  categoryId?: ID;
  /** Detalhe para a interface: "3 de 6", "vence em 4 dias"… */
  detail?: string;
  /** `true` quando a data já passou e continua em aberto. */
  overdue: boolean;
}

export interface CommitmentsInput {
  cards: readonly Card[];
  transactions: readonly Transaction[];
  recurring: readonly RecurringRule[];
  today: ISODate;
  /** Último mês considerado (inclusive). */
  horizonMonth: ISOMonth;
}

export interface CommitmentsResult {
  items: Commitment[];
  totalCents: Cents;
  byMonth: { month: ISOMonth; amountCents: Cents }[];
  invoiceCents: Cents;
  scheduledCents: Cents;
  recurringCents: Cents;
}

/**
 * Chaves das recorrências que JÁ viraram lançamento, para não projetar de novo.
 * Reconhece tanto o vínculo explícito (`recurringRuleId`) quanto o lançamento
 * feito à mão com a mesma descrição no mesmo mês.
 */
function materializedRecurring(transactions: readonly Transaction[]): {
  byRule: Set<string>;
  byDescription: Set<string>;
} {
  const byRule = new Set<string>();
  const byDescription = new Set<string>();
  for (const tx of transactions) {
    if (tx.kind !== 'expense' && tx.kind !== 'income') continue;
    const month = monthOf(tx.date);
    if (tx.recurringRuleId) byRule.add(`${tx.recurringRuleId}|${month}`);
    byDescription.add(`${normalizeMerchant(tx.description)}|${month}`);
  }
  return { byRule, byDescription };
}

function ruleActiveInMonth(rule: RecurringRule, month: ISOMonth): boolean {
  if (!rule.active) return false;
  if (month < rule.startMonth) return false;
  if (rule.endMonth && month > rule.endMonth) return false;
  return true;
}

export function futureCommitments(input: CommitmentsInput): CommitmentsResult {
  const { cards, transactions, recurring, today, horizonMonth } = input;
  const horizonEnd = endOfMonth(horizonMonth);
  const items: Commitment[] = [];

  // 1. Faturas em aberto — cobre parcelas futuras sem contá-las duas vezes.
  for (const card of cards) {
    if (card.archived) continue;
    for (const invoice of listInvoices(card, transactions, today)) {
      if (invoice.openCents <= 0) continue;
      if (compareDate(invoice.dueDate, horizonEnd) > 0) continue;
      const futureItems = invoice.items.filter((tx) => compareDate(tx.date, today) > 0).length;
      items.push({
        id: `inv:${card.id}:${invoice.ref}`,
        kind: 'invoice',
        label: `Fatura ${card.name}`,
        dueDate: invoice.dueDate,
        month: invoice.ref,
        amountCents: invoice.openCents,
        cardId: card.id,
        detail:
          invoice.status === 'open'
            ? `fecha em ${invoice.end.slice(8, 10)}/${invoice.end.slice(5, 7)}`
            : futureItems > 0
              ? `${futureItems} lançamento(s) futuro(s)`
              : undefined,
        overdue: compareDate(invoice.dueDate, today) < 0,
      });
    }
  }

  // 2. Despesas em conta previstas ou com data futura.
  for (const tx of transactions) {
    if (tx.kind !== 'expense' || tx.cardId) continue;
    const isFuture = compareDate(tx.date, today) > 0;
    const isPending = tx.status === 'pending';
    if (!isFuture && !isPending) continue;
    if (compareDate(tx.date, horizonEnd) > 0) continue;
    items.push({
      id: `sch:${tx.id}`,
      kind: 'scheduled',
      label: tx.description,
      dueDate: tx.date,
      month: monthOf(tx.date),
      amountCents: tx.amountCents,
      accountId: tx.accountId,
      categoryId: tx.categoryId,
      detail:
        tx.installmentNumber && tx.installmentTotal
          ? `parcela ${tx.installmentNumber} de ${tx.installmentTotal}`
          : isPending
            ? 'previsto'
            : undefined,
      overdue: isPending && compareDate(tx.date, today) < 0,
    });
  }

  // 3. Contas fixas ainda não lançadas.
  const materialized = materializedRecurring(transactions);
  const fromMonth = monthOf(today);
  for (const month of monthRange(fromMonth, horizonMonth)) {
    for (const rule of recurring) {
      if (rule.kind !== 'expense') continue;
      if (!ruleActiveInMonth(rule, month)) continue;
      if (materialized.byRule.has(`${rule.id}|${month}`)) continue;
      if (materialized.byDescription.has(`${normalizeMerchant(rule.description)}|${month}`)) continue;
      const dueDate = dayInMonth(month, rule.dayOfMonth);
      items.push({
        id: `rec:${rule.id}:${month}`,
        kind: 'recurring',
        label: rule.description,
        dueDate,
        month,
        amountCents: rule.amountCents,
        accountId: rule.accountId,
        cardId: rule.cardId,
        categoryId: rule.categoryId,
        detail: 'conta fixa prevista',
        overdue: compareDate(dueDate, today) < 0,
      });
    }
  }

  items.sort((a, b) => compareDate(a.dueDate, b.dueDate) || b.amountCents - a.amountCents);

  const byMonthMap = new Map<ISOMonth, Cents>();
  for (const item of items) {
    byMonthMap.set(item.month, (byMonthMap.get(item.month) ?? 0) + item.amountCents);
  }

  const totalFor = (kind: CommitmentKind) =>
    sumCents(items.filter((i) => i.kind === kind).map((i) => i.amountCents));

  return {
    items,
    totalCents: sumCents(items.map((i) => i.amountCents)),
    byMonth: Array.from(byMonthMap, ([month, amountCents]) => ({ month, amountCents })).sort((a, b) =>
      a.month.localeCompare(b.month),
    ),
    invoiceCents: totalFor('invoice'),
    scheduledCents: totalFor('scheduled'),
    recurringCents: totalFor('recurring'),
  };
}

export interface AvailabilityInput {
  accounts: readonly Account[];
  cards: readonly Card[];
  transactions: readonly Transaction[];
  recurring: readonly RecurringRule[];
  today: ISODate;
  /** Horizonte do "disponível". Padrão: fim do mês corrente. */
  availabilityMonth?: ISOMonth;
  /** Horizonte do "compromissos futuros". Padrão: 12 meses. */
  horizonMonths?: number;
}

export interface Availability {
  /** Soma dos saldos das contas hoje. */
  balanceCents: Cents;
  /** Compromissos até o fim do mês de referência. */
  committedCents: Cents;
  /** balanceCents − committedCents. Pode ser negativo — e essa é a informação. */
  availableCents: Cents;
  /** Todos os compromissos dentro do horizonte longo. */
  future: CommitmentsResult;
  /** Compromissos dentro do horizonte curto (o que entra em `committedCents`). */
  nearTerm: CommitmentsResult;
}

/**
 * A conta que o produto existe para responder:
 * "tirando o que já está comprometido, quanto realmente sobra?"
 */
export function availability(input: AvailabilityInput): Availability {
  const availabilityMonth = input.availabilityMonth ?? monthOf(input.today);
  const horizonMonth = addMonthsToMonth(monthOf(input.today), (input.horizonMonths ?? 12) - 1);

  const balanceCents = sumCents(
    input.accounts
      .filter((a) => !a.archived)
      .map((a) => accountBalance(a, input.transactions, { asOf: input.today })),
  );

  const nearTerm = futureCommitments({
    cards: input.cards,
    transactions: input.transactions,
    recurring: input.recurring,
    today: input.today,
    horizonMonth: availabilityMonth,
  });

  const future = futureCommitments({
    cards: input.cards,
    transactions: input.transactions,
    recurring: input.recurring,
    today: input.today,
    horizonMonth,
  });

  return {
    balanceCents,
    committedCents: nearTerm.totalCents,
    availableCents: balanceCents - nearTerm.totalCents,
    future,
    nearTerm,
  };
}

/** Parcelas ainda por vencer, agrupadas por compra. */
export interface InstallmentPlan {
  groupId: ID;
  description: string;
  cardId?: ID;
  totalCents: Cents;
  installmentTotal: number;
  paidCount: number;
  remainingCount: number;
  paidCents: Cents;
  remainingCents: Cents;
  nextDate?: ISODate;
  lastDate: ISODate;
}

/** Todas as compras parceladas com o andamento de cada uma. */
export function installmentPlans(
  transactions: readonly Transaction[],
  today: ISODate = currentMonth() + '-01',
): InstallmentPlan[] {
  const groups = new Map<ID, Transaction[]>();
  for (const tx of transactions) {
    if (!tx.installmentGroupId || !tx.installmentTotal || tx.installmentTotal < 2) continue;
    if (tx.kind !== 'expense') continue;
    const list = groups.get(tx.installmentGroupId) ?? [];
    list.push(tx);
    groups.set(tx.installmentGroupId, list);
  }

  const plans: InstallmentPlan[] = [];
  for (const [groupId, list] of groups) {
    list.sort((a, b) => (a.installmentNumber ?? 0) - (b.installmentNumber ?? 0));
    const first = list[0]!;
    const past = list.filter((tx) => compareDate(tx.date, today) <= 0);
    const future = list.filter((tx) => compareDate(tx.date, today) > 0);
    plans.push({
      groupId,
      description: first.description,
      cardId: first.cardId,
      // Soma as parcelas existentes: é o valor real, mesmo se alguma foi editada.
      totalCents: sumCents(list.map((tx) => tx.amountCents)),
      installmentTotal: first.installmentTotal ?? list.length,
      paidCount: past.length,
      remainingCount: future.length,
      paidCents: sumCents(past.map((tx) => tx.amountCents)),
      remainingCents: sumCents(future.map((tx) => tx.amountCents)),
      nextDate: future[0]?.date,
      lastDate: list[list.length - 1]!.date,
    });
  }

  return plans.sort((a, b) => b.remainingCents - a.remainingCents);
}
