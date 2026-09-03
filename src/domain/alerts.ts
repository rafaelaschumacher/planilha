/**
 * Alertas.
 *
 * Menos é mais: alerta que aparece toda hora vira ruído e deixa de ser lido.
 * Só entra aqui o que é (a) verdadeiro, (b) relevante agora e (c) acionável.
 */

import { formatMoney, type Cents } from './money';
import { addDays, compareDate, diffDays, formatMonthShort, monthOf, type ISODate } from './dates';
import { budgetOverall, budgetStatuses } from './budget';
import { availability } from './commitments';
import { cardUsage, listInvoices } from './invoice';
import { scanForDuplicates } from './duplicates';
import { accountBalance } from './engine';
import type { FinanceDataset } from './types';

export type AlertSeverity = 'info' | 'warn' | 'danger';

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  /** Rota para resolver o alerta. */
  href?: string;
  actionLabel?: string;
}

const SEVERITY_WEIGHT: Record<AlertSeverity, number> = { danger: 0, warn: 1, info: 2 };

export function buildAlerts(data: FinanceDataset, today: ISODate): Alert[] {
  const alerts: Alert[] = [];
  const month = monthOf(today);
  const categoriesById = new Map(data.categories.map((c) => [c.id, c]));

  // --- Orçamento ---------------------------------------------------------
  const statuses = budgetStatuses(
    month,
    data.budgets,
    data.categories,
    data.transactions,
    data.settings.budgetWarnRatio,
  );
  for (const status of statuses) {
    if (status.over) {
      alerts.push({
        id: `budget-over-${status.categoryId}`,
        severity: 'danger',
        title: `${status.categoryName} estourou o orçamento`,
        message: `Gastou ${formatMoney(status.spentCents)} de ${formatMoney(status.limitCents)} — ${formatMoney(-status.remainingCents)} acima do limite.`,
        href: '#/orcamento',
        actionLabel: 'Ver orçamento',
      });
    } else if (status.warn) {
      alerts.push({
        id: `budget-warn-${status.categoryId}`,
        severity: 'warn',
        title: `${status.categoryName} perto do limite`,
        message: `Restam ${formatMoney(status.remainingCents)} de ${formatMoney(status.limitCents)} neste mês.`,
        href: '#/orcamento',
        actionLabel: 'Ver orçamento',
      });
    }
  }

  const overall = budgetOverall(statuses);
  if (overall.limitCents > 0 && overall.usageRatio >= 1 && statuses.length > 1) {
    alerts.push({
      id: 'budget-overall',
      severity: 'warn',
      title: 'Orçamento total do mês consumido',
      message: `${formatMoney(overall.spentCents)} gastos contra ${formatMoney(overall.limitCents)} planejados.`,
      href: '#/orcamento',
    });
  }

  // --- Saldo -------------------------------------------------------------
  const view = availability({
    accounts: data.accounts,
    cards: data.cards,
    transactions: data.transactions,
    recurring: data.recurring,
    today,
    horizonMonths: data.settings.commitmentHorizonMonths,
  });

  if (view.balanceCents < data.settings.lowBalanceThresholdCents) {
    alerts.push({
      id: 'low-balance',
      severity: view.balanceCents < 0 ? 'danger' : 'warn',
      title: 'Saldo baixo nas contas',
      message: `Você tem ${formatMoney(view.balanceCents)} disponíveis em conta.`,
      href: '#/contas',
      actionLabel: 'Ver contas',
    });
  }

  if (view.availableCents < 0) {
    alerts.push({
      id: 'negative-available',
      severity: 'danger',
      title: 'Compromissos maiores que o saldo',
      message: `Faltam ${formatMoney(-view.availableCents)} para cobrir o que já está comprometido até o fim do mês.`,
      href: '#/futuro',
      actionLabel: 'Ver compromissos',
    });
  }

  for (const account of data.accounts) {
    if (account.archived) continue;
    const balance = accountBalance(account, data.transactions, { asOf: today });
    if (balance < 0) {
      alerts.push({
        id: `negative-account-${account.id}`,
        severity: 'danger',
        title: `${account.name} está negativa`,
        message: `Saldo de ${formatMoney(balance)}.`,
        href: '#/contas',
      });
    }
  }

  // --- Cartões -----------------------------------------------------------
  for (const card of data.cards) {
    if (card.archived) continue;
    const usage = cardUsage(card, data.transactions);
    if (card.limitCents > 0 && usage.usageRatio >= 0.85) {
      alerts.push({
        id: `card-limit-${card.id}`,
        severity: usage.usageRatio >= 1 ? 'danger' : 'warn',
        title: `${card.name} com limite quase no fim`,
        message: `${formatMoney(usage.usedCents)} usados de ${formatMoney(card.limitCents)} — restam ${formatMoney(usage.availableCents)}.`,
        href: '#/cartoes',
      });
    }

    const invoices = listInvoices(card, data.transactions, today);
    const closed = invoices.filter((inv) => inv.openCents > 0 && compareDate(inv.end, today) < 0);

    for (const invoice of closed) {
      if (compareDate(invoice.dueDate, today) < 0) {
        alerts.push({
          id: `invoice-overdue-${card.id}-${invoice.ref}`,
          severity: 'danger',
          title: `Fatura ${card.name} vencida`,
          message: `${formatMoney(invoice.openCents)} em aberto desde ${invoice.dueDate.slice(8, 10)}/${invoice.dueDate.slice(5, 7)}.`,
          href: '#/cartoes',
          actionLabel: 'Pagar fatura',
        });
      } else if (diffDays(invoice.dueDate, today) <= 5) {
        alerts.push({
          id: `invoice-due-${card.id}-${invoice.ref}`,
          severity: 'warn',
          title: `Fatura ${card.name} vence em ${diffDays(invoice.dueDate, today)} dia(s)`,
          message: `${formatMoney(invoice.openCents)} a pagar em ${invoice.dueDate.slice(8, 10)}/${invoice.dueDate.slice(5, 7)}.`,
          href: '#/cartoes',
          actionLabel: 'Pagar fatura',
        });
      }
    }

    // Fatura atual bem acima da média das últimas fechadas.
    const history = invoices.filter((inv) => compareDate(inv.end, today) < 0 && inv.totalCents > 0).slice(-4);
    const current = invoices.find((inv) => inv.status === 'open');
    if (current && history.length >= 2) {
      const average = Math.round(history.reduce((sum, inv) => sum + inv.totalCents, 0) / history.length);
      if (average > 0 && current.totalCents > average * 1.3) {
        alerts.push({
          id: `invoice-high-${card.id}`,
          severity: 'warn',
          title: `Fatura de ${card.name} acima do normal`,
          message: `${formatMoney(current.totalCents)} até agora, contra média de ${formatMoney(average)} nas últimas faturas.`,
          href: '#/cartoes',
        });
      }
    }
  }

  // --- Compromissos próximos --------------------------------------------
  const soon = view.future.items.filter(
    (item) => compareDate(item.dueDate, addDays(today, 7)) <= 0 && compareDate(item.dueDate, today) >= 0,
  );
  const soonTotal: Cents = soon.reduce((sum, item) => sum + item.amountCents, 0);
  if (soon.length > 0 && soonTotal > view.balanceCents) {
    alerts.push({
      id: 'commitments-week',
      severity: 'warn',
      title: 'Contas dos próximos 7 dias somam mais que o saldo',
      message: `${formatMoney(soonTotal)} a pagar em ${soon.length} compromisso(s), com ${formatMoney(view.balanceCents)} em conta.`,
      href: '#/futuro',
    });
  }

  const nextMonthKey = view.future.byMonth.find((m) => m.month > month);
  if (nextMonthKey && nextMonthKey.amountCents > view.balanceCents * 1.5 && view.balanceCents > 0) {
    alerts.push({
      id: 'commitments-next-month',
      severity: 'info',
      title: `${formatMonthShort(nextMonthKey.month)} já tem ${formatMoney(nextMonthKey.amountCents)} comprometidos`,
      message: 'Vale conferir antes de assumir novas parcelas.',
      href: '#/futuro',
    });
  }

  // --- Qualidade dos dados ----------------------------------------------
  const needsReview = data.transactions.filter((tx) => tx.needsReview || (!tx.categoryId && tx.kind === 'expense'));
  if (needsReview.length > 0) {
    alerts.push({
      id: 'needs-review',
      severity: needsReview.length > 20 ? 'warn' : 'info',
      title: `${needsReview.length} lançamento(s) para revisar`,
      message: 'Estão sem categoria ou com categoria de baixa confiança.',
      href: '#/lancamentos?revisar=1',
      actionLabel: 'Revisar agora',
    });
  }

  const duplicates = scanForDuplicates(data.transactions);
  if (duplicates.length > 0) {
    alerts.push({
      id: 'duplicates',
      severity: 'warn',
      title: `${duplicates.length} possível(is) duplicidade(s)`,
      message: 'Nada foi apagado. Confira e decida o que fazer.',
      href: '#/diagnostico',
      actionLabel: 'Ver diagnóstico',
    });
  }

  const orphans = data.transactions.filter(
    (tx) =>
      (tx.categoryId && !categoriesById.has(tx.categoryId)) ||
      (tx.accountId && !data.accounts.some((a) => a.id === tx.accountId)) ||
      (tx.cardId && !data.cards.some((c) => c.id === tx.cardId)),
  );
  if (orphans.length > 0) {
    alerts.push({
      id: 'orphans',
      severity: 'danger',
      title: `${orphans.length} lançamento(s) apontando para item inexistente`,
      message: 'Conta, cartão ou categoria foi removido e deixou lançamentos órfãos.',
      href: '#/diagnostico',
      actionLabel: 'Ver diagnóstico',
    });
  }

  return alerts.sort((a, b) => SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity]);
}
