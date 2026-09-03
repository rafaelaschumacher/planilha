/**
 * Ciclo da fatura do cartão de crédito.
 *
 * A fatura NÃO é uma tabela no banco: ela é DERIVADA das compras e dos
 * pagamentos. Guardar a fatura como registro próprio seria o caminho mais
 * curto para "faturas duplicadas" e para números que não batem com os
 * lançamentos. Aqui ela é sempre recalculada a partir da base única.
 *
 * Convenções (padrão dos cartões brasileiros):
 *  · A fatura é identificada pelo MÊS DO VENCIMENTO ("a fatura de abril").
 *  · Compras feitas ATÉ o dia do fechamento (inclusive) entram na fatura que
 *    fecha naquele mês; depois disso, entram na próxima.
 *  · Quando o dia de vencimento é menor ou igual ao de fechamento, a fatura
 *    que fecha no mês M vence no mês M+1.
 */

import type { Cents } from './money';
import {
  addDays,
  addMonthsToMonth,
  compareDate,
  dayInMonth,
  isBetween,
  monthOf,
  monthRange,
  type ISODate,
  type ISOMonth,
} from './dates';
import { cardDelta } from './transaction';
import type { Card, ID, Transaction } from './types';

export type InvoiceStatus = 'empty' | 'open' | 'closed' | 'partial' | 'paid' | 'overdue';

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  empty: 'Sem lançamentos',
  open: 'Aberta',
  closed: 'Fechada',
  partial: 'Parcialmente paga',
  paid: 'Paga',
  overdue: 'Vencida',
};

export interface InvoicePeriod {
  /** Mês de VENCIMENTO — é assim que a fatura é identificada. */
  ref: ISOMonth;
  /** Mês em que a fatura fecha. */
  closeMonth: ISOMonth;
  /** Primeiro dia do período de compras (inclusive). */
  start: ISODate;
  /** Dia do fechamento — último dia do período de compras (inclusive). */
  end: ISODate;
  dueDate: ISODate;
}

export interface Invoice extends InvoicePeriod {
  cardId: ID;
  /** Compras, reembolsos e estornos do período. */
  items: Transaction[];
  /** Soma das compras menos reembolsos/estornos do período. Nunca negativa na prática. */
  totalCents: Cents;
  /** Quanto já foi pago desta fatura. */
  paidCents: Cents;
  /** Quanto falta pagar (total − pago), nunca negativo. */
  openCents: Cents;
  /** Pagamentos alocados a esta fatura. */
  payments: Transaction[];
  status: InvoiceStatus;
}

/**
 * Mês de vencimento da fatura em que o dia da fatura fecha no mês `closeMonth`.
 * Vencimento depois do fechamento → mesmo mês. Caso contrário → mês seguinte.
 */
export function dueMonthForClosing(card: Pick<Card, 'closingDay' | 'dueDay'>, closeMonth: ISOMonth): ISOMonth {
  return card.dueDay > card.closingDay ? closeMonth : addMonthsToMonth(closeMonth, 1);
}

export function closeMonthForDue(card: Pick<Card, 'closingDay' | 'dueDay'>, ref: ISOMonth): ISOMonth {
  return card.dueDay > card.closingDay ? ref : addMonthsToMonth(ref, -1);
}

/** Período completo da fatura identificada por `ref` (mês de vencimento). */
export function invoicePeriod(card: Pick<Card, 'closingDay' | 'dueDay'>, ref: ISOMonth): InvoicePeriod {
  const closeMonth = closeMonthForDue(card, ref);
  const end = dayInMonth(closeMonth, card.closingDay);
  const previousEnd = dayInMonth(addMonthsToMonth(closeMonth, -1), card.closingDay);
  return {
    ref,
    closeMonth,
    start: addDays(previousEnd, 1),
    end,
    dueDate: dayInMonth(ref, card.dueDay),
  };
}

/**
 * Em qual fatura (mês de vencimento) cai uma compra feita em `date`.
 * É a função que responde "essa compra vai cair na fatura de qual mês?".
 */
export function invoiceRefForDate(card: Pick<Card, 'closingDay' | 'dueDay'>, date: ISODate): ISOMonth {
  const month = monthOf(date);
  const closingThisMonth = dayInMonth(month, card.closingDay);
  const closeMonth = compareDate(date, closingThisMonth) <= 0 ? month : addMonthsToMonth(month, 1);
  return dueMonthForClosing(card, closeMonth);
}

/**
 * Distribui os pagamentos entre as faturas do cartão.
 *
 * · Pagamento com `invoiceRef` vai para a fatura indicada.
 * · Pagamento sem referência é alocado da fatura mais antiga em aberto para a
 *   mais nova (FIFO), que é como as operadoras abatem.
 *
 * Nenhum centavo é contado duas vezes: cada pagamento é consumido uma única vez.
 */
export function allocatePayments(
  card: Pick<Card, 'id' | 'closingDay' | 'dueDay'>,
  transactions: readonly Transaction[],
): Map<ISOMonth, { paidCents: Cents; payments: Transaction[] }> {
  const allocation = new Map<ISOMonth, { paidCents: Cents; payments: Transaction[] }>();
  const add = (ref: ISOMonth, cents: Cents, tx: Transaction) => {
    const current = allocation.get(ref) ?? { paidCents: 0, payments: [] };
    current.paidCents += cents;
    if (cents > 0 && !current.payments.includes(tx)) current.payments.push(tx);
    allocation.set(ref, current);
  };

  const payments = transactions
    .filter((tx) => tx.kind === 'card_payment' && tx.cardId === card.id)
    .sort((a, b) => compareDate(a.date, b.date) || a.id.localeCompare(b.id));

  const explicit = payments.filter((p) => p.invoiceRef);
  const implicit = payments.filter((p) => !p.invoiceRef);

  for (const payment of explicit) {
    add(payment.invoiceRef!, payment.amountCents, payment);
  }

  if (implicit.length === 0) return allocation;

  // Quanto de cada pagamento já foi consumido. Local à chamada — nada de
  // estado compartilhado entre cartões.
  const consumed = new Map<ID, Cents>();

  // Faturas com compras, da mais antiga para a mais nova.
  const purchases = transactions.filter(
    (tx) => tx.cardId === card.id && (tx.kind === 'expense' || tx.kind === 'refund' || tx.kind === 'chargeback'),
  );
  const refs = new Set<ISOMonth>();
  for (const tx of purchases) refs.add(invoiceRefForDate(card, tx.date));
  for (const ref of allocation.keys()) refs.add(ref);

  const totals = new Map<ISOMonth, Cents>();
  for (const ref of refs) {
    const period = invoicePeriod(card, ref);
    let total = 0;
    for (const tx of purchases) {
      if (isBetween(tx.date, period.start, period.end)) total += cardDelta(tx, card.id);
    }
    totals.set(ref, total);
  }

  const ordered = Array.from(refs).sort();
  let queue = [...implicit];

  for (const ref of ordered) {
    if (queue.length === 0) break;
    const total = totals.get(ref) ?? 0;
    let remaining = total - (allocation.get(ref)?.paidCents ?? 0);
    if (remaining <= 0) continue;

    while (remaining > 0 && queue.length > 0) {
      const payment = queue[0]!;
      const used = consumed.get(payment.id) ?? 0;
      const availableCents = payment.amountCents - used;
      const applied = Math.min(availableCents, remaining);
      add(ref, applied, payment);
      consumed.set(payment.id, used + applied);
      remaining -= applied;
      if (used + applied >= payment.amountCents) queue = queue.slice(1);
    }
  }

  // Sobra de pagamento (pagou mais do que devia) fica na última fatura conhecida.
  for (const payment of queue) {
    const used = consumed.get(payment.id) ?? 0;
    const leftover = payment.amountCents - used;
    if (leftover > 0) {
      const ref = ordered[ordered.length - 1] ?? invoiceRefForDate(card, payment.date);
      add(ref, leftover, payment);
      consumed.set(payment.id, payment.amountCents);
    }
  }

  return allocation;
}

/** Monta uma fatura completa. */
export function buildInvoice(
  card: Card,
  ref: ISOMonth,
  transactions: readonly Transaction[],
  today: ISODate,
  allocation?: Map<ISOMonth, { paidCents: Cents; payments: Transaction[] }>,
): Invoice {
  const period = invoicePeriod(card, ref);
  const alloc = allocation ?? allocatePayments(card, transactions);

  const items = transactions
    .filter(
      (tx) =>
        tx.cardId === card.id &&
        (tx.kind === 'expense' || tx.kind === 'refund' || tx.kind === 'chargeback') &&
        isBetween(tx.date, period.start, period.end),
    )
    .sort((a, b) => compareDate(a.date, b.date) || a.description.localeCompare(b.description));

  let totalCents = 0;
  for (const tx of items) totalCents += cardDelta(tx, card.id);

  const allocated = alloc.get(ref) ?? { paidCents: 0, payments: [] };
  const paidCents = allocated.paidCents;
  const openCents = Math.max(0, totalCents - paidCents);

  let status: InvoiceStatus;
  if (totalCents === 0 && paidCents === 0) status = 'empty';
  else if (openCents === 0) status = 'paid';
  else if (compareDate(today, period.end) <= 0) status = 'open';
  else if (compareDate(today, period.dueDate) > 0) status = 'overdue';
  else if (paidCents > 0) status = 'partial';
  else status = 'closed';

  return {
    ...period,
    cardId: card.id,
    items,
    totalCents,
    paidCents,
    openCents,
    payments: allocated.payments,
    status,
  };
}

/** Todas as faturas do cartão que tenham lançamentos, da mais antiga à mais nova. */
export function listInvoices(
  card: Card,
  transactions: readonly Transaction[],
  today: ISODate,
  options: { from?: ISOMonth; to?: ISOMonth } = {},
): Invoice[] {
  const refs = new Set<ISOMonth>();
  for (const tx of transactions) {
    if (tx.cardId !== card.id) continue;
    if (tx.kind === 'expense' || tx.kind === 'refund' || tx.kind === 'chargeback') {
      refs.add(invoiceRefForDate(card, tx.date));
    } else if (tx.kind === 'card_payment' && tx.invoiceRef) {
      refs.add(tx.invoiceRef);
    }
  }
  // Garante que a fatura corrente apareça mesmo sem nenhuma compra ainda.
  refs.add(invoiceRefForDate(card, today));

  const sorted = Array.from(refs).sort();
  const first = options.from ?? sorted[0];
  const last = options.to ?? sorted[sorted.length - 1];
  if (!first || !last) return [];

  const allocation = allocatePayments(card, transactions);
  return monthRange(first, last).map((ref) => buildInvoice(card, ref, transactions, today, allocation));
}

/** A fatura em que as compras de hoje estão caindo. */
export function currentInvoice(card: Card, transactions: readonly Transaction[], today: ISODate): Invoice {
  return buildInvoice(card, invoiceRefForDate(card, today), transactions, today);
}

/** Faturas fechadas ou vencidas com saldo em aberto — dinheiro que você já deve. */
export function openInvoices(card: Card, transactions: readonly Transaction[], today: ISODate): Invoice[] {
  return listInvoices(card, transactions, today).filter(
    (inv) => inv.openCents > 0 && compareDate(inv.end, today) < 0,
  );
}

export interface CardUsage {
  cardId: ID;
  limitCents: Cents;
  /** Limite comprometido: tudo que foi comprado e ainda não foi pago. */
  usedCents: Cents;
  availableCents: Cents;
  /** 0..1 */
  usageRatio: number;
}

/**
 * Limite utilizado do cartão.
 *
 * Soma TODAS as compras (inclusive parcelas futuras, que já comprometem limite
 * de verdade) e subtrai reembolsos, estornos e pagamentos. É exatamente o que
 * o app do banco mostra.
 */
export function cardUsage(card: Card, transactions: readonly Transaction[]): CardUsage {
  let usedCents = 0;
  for (const tx of transactions) usedCents += cardDelta(tx, card.id);
  const availableCents = card.limitCents - usedCents;
  return {
    cardId: card.id,
    limitCents: card.limitCents,
    usedCents,
    availableCents,
    usageRatio: card.limitCents > 0 ? usedCents / card.limitCents : 0,
  };
}
