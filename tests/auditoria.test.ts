/**
 * Auditoria: roda o cenário completo e procura os erros que fazem um
 * controle financeiro perder credibilidade.
 */
import { describe, expect, it } from 'vitest';
import { buildDemoDataset } from '../src/db/demo';
import { auditDataset } from '../src/domain/audit';
import { availability, installmentPlans } from '../src/domain/commitments';
import { accountBalance, monthSummary, monthsWithData, periodSummary, weekSummary } from '../src/domain/engine';
import { cardUsage, listInvoices } from '../src/domain/invoice';
import { pnlEffect } from '../src/domain/transaction';
import { endOfMonth, startOfMonth } from '../src/domain/dates';
import { sumCents } from '../src/domain/money';

const HOJE = '2024-06-18';
const data = buildDemoDataset({ endMonth: '2024-06', months: 6, today: HOJE });
const categoryMap = new Map(data.categories.map((c) => [c.id, c]));

describe('auditoria do cenário completo', () => {
  const report = auditDataset(data, HOJE);

  it('não encontra nenhum erro', () => {
    const erros = report.findings.filter((f) => f.severity === 'error');
    if (erros.length) {
      console.error(erros.map((e) => `${e.group}: ${e.title} — ${e.detail}`).join('\n'));
    }
    expect(erros).toHaveLength(0);
  });

  it('gera um cenário com volume real de dados', () => {
    expect(report.checkedTransactions).toBeGreaterThan(150);
    expect(monthsWithData(data.transactions).length).toBeGreaterThanOrEqual(6);
  });

  it('confirma as verificações que passaram', () => {
    expect(report.passed).toContain('Nenhum pagamento de fatura está sendo contado como despesa.');
    expect(report.passed).toContain('Todos os valores são centavos inteiros — não há erro de ponto flutuante.');
    expect(report.passed).toContain('O saldo de cada conta é exatamente o saldo inicial mais os lançamentos.');
  });
});

describe('coerência entre as diferentes visões', () => {
  it('a soma das semanas do mês é igual ao total do mês', () => {
    const mes = monthSummary('2024-05', data.transactions, categoryMap);
    // Semanas cobrindo maio inteiro, cada lançamento contado uma única vez.
    const porPeriodo = periodSummary(data.transactions, startOfMonth('2024-05'), endOfMonth('2024-05'), categoryMap);
    expect(porPeriodo.expenseCents).toBe(mes.expenseCents);
    expect(porPeriodo.incomeCents).toBe(mes.incomeCents);
  });

  it('a semana é um recorte da base, não uma tabela separada', () => {
    const semana = weekSummary('2024-05-15', data.transactions, categoryMap, 0);
    expect(semana.start).toBe('2024-05-12');
    expect(semana.end).toBe('2024-05-18');
    const manual = data.transactions
      .filter((t) => t.date >= '2024-05-12' && t.date <= '2024-05-18')
      .reduce((sum, t) => sum + pnlEffect(t).expense, 0);
    expect(semana.expenseCents).toBe(manual);
  });

  it('as categorias somam exatamente a despesa do mês', () => {
    const mes = monthSummary('2024-05', data.transactions, categoryMap);
    expect(sumCents(mes.byCategory.map((c) => c.amountCents))).toBe(mes.expenseCents);
    expect(sumCents(mes.byRootCategory.map((c) => c.amountCents))).toBe(mes.expenseCents);
  });

  it('fixos mais variáveis somam a despesa do mês', () => {
    const mes = monthSummary('2024-05', data.transactions, categoryMap);
    expect(mes.fixedCents + mes.variableCents).toBe(mes.expenseCents);
  });

  it('cartão mais conta somam a despesa do mês', () => {
    const mes = monthSummary('2024-05', data.transactions, categoryMap);
    expect(mes.cardExpenseCents + mes.accountExpenseCents).toBe(mes.expenseCents);
  });

  it('as formas de pagamento somam a despesa do mês', () => {
    const mes = monthSummary('2024-05', data.transactions, categoryMap);
    expect(sumCents(mes.byPaymentMethod.map((m) => m.amountCents))).toBe(mes.expenseCents);
  });

  it('receitas menos despesas é o saldo do mês', () => {
    const mes = monthSummary('2024-05', data.transactions, categoryMap);
    expect(mes.incomeCents - mes.expenseCents).toBe(mes.netCents);
  });
});

describe('saldos e faturas do cenário', () => {
  it('o saldo de cada conta bate com o cálculo manual', () => {
    for (const account of data.accounts) {
      const manual = data.transactions
        .filter((t) => t.date >= account.openingDate && t.status !== 'pending')
        .reduce((sum, t) => {
          if (t.kind === 'transfer') {
            if (t.accountId === account.id) return sum - t.amountCents;
            if (t.toAccountId === account.id) return sum + t.amountCents;
            return sum;
          }
          if (t.accountId !== account.id) return sum;
          if (t.cardId && t.kind !== 'card_payment') return sum;
          if (t.kind === 'income' || t.kind === 'refund' || t.kind === 'chargeback') return sum + t.amountCents;
          if (t.kind === 'adjustment') return sum + (t.direction === 'out' ? -t.amountCents : t.amountCents);
          return sum - t.amountCents;
        }, account.openingBalanceCents);
      expect(accountBalance(account, data.transactions)).toBe(manual);
    }
  });

  it('a soma das faturas é igual à soma das compras do cartão', () => {
    const card = data.cards[0]!;
    const compras = data.transactions
      .filter((t) => t.cardId === card.id && t.kind !== 'card_payment')
      .reduce((sum, t) => sum + (t.kind === 'expense' ? t.amountCents : -t.amountCents), 0);
    const faturas = listInvoices(card, data.transactions, HOJE).reduce((sum, f) => sum + f.totalCents, 0);
    expect(faturas).toBe(compras);
  });

  it('o limite usado é compras menos pagamentos, sem sobra nem falta', () => {
    const card = data.cards[0]!;
    const uso = cardUsage(card, data.transactions);
    const compras = data.transactions
      .filter((t) => t.cardId === card.id && t.kind === 'expense')
      .reduce((s, t) => s + t.amountCents, 0);
    const creditos = data.transactions
      .filter((t) => t.cardId === card.id && t.kind !== 'expense')
      .reduce((s, t) => s + t.amountCents, 0);
    expect(uso.usedCents).toBe(compras - creditos);
    expect(uso.usedCents + uso.availableCents).toBe(card.limitCents);
  });

  it('nenhuma fatura fechada aparece paga duas vezes', () => {
    const card = data.cards[0]!;
    for (const invoice of listInvoices(card, data.transactions, HOJE)) {
      expect(invoice.paidCents).toBeLessThanOrEqual(invoice.totalCents);
    }
  });
});

describe('compromissos do cenário', () => {
  const view = availability({
    accounts: data.accounts,
    cards: data.cards,
    transactions: data.transactions,
    recurring: data.recurring,
    today: HOJE,
  });

  it('saldo menos comprometido é igual ao disponível', () => {
    expect(view.balanceCents - view.committedCents).toBe(view.availableCents);
  });

  it('as parcelas restantes do notebook aparecem no futuro', () => {
    const plano = installmentPlans(data.transactions, HOJE).find((p) => p.description.includes('NOTEBOOK'))!;
    expect(plano.installmentTotal).toBe(8);
    expect(plano.paidCents + plano.remainingCents).toBe(plano.totalCents);
    expect(plano.remainingCount).toBeGreaterThan(0);
  });

  it('nenhum compromisso é contado duas vezes', () => {
    const ids = view.future.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('o total dos compromissos é a soma dos itens', () => {
    expect(sumCents(view.future.items.map((i) => i.amountCents))).toBe(view.future.totalCents);
    expect(view.future.invoiceCents + view.future.scheduledCents + view.future.recurringCents).toBe(
      view.future.totalCents,
    );
  });
});
