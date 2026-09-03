/**
 * Auditoria adversarial: os casos-limite que costumam esconder erro em
 * controle financeiro. Cada teste aqui existe porque é um bug plausível.
 */

import { describe, expect, it } from 'vitest';
import { sumCents, toCents } from '../src/domain/money';
import { addDays, monthOf } from '../src/domain/dates';
import {
  buildCardPayment,
  buildInstallmentPurchase,
  buildTransaction,
  buildTransfer,
} from '../src/domain/transaction';
import { buildInvoice, invoicePeriod, invoiceRefForDate, listInvoices } from '../src/domain/invoice';
import { accountBalance, monthSummary, periodSummary, weekSummary } from '../src/domain/engine';
import { availability, futureCommitments } from '../src/domain/commitments';
import { budgetStatuses } from '../src/domain/budget';
import { auditDataset } from '../src/domain/audit';
import { scanForDuplicates } from '../src/domain/duplicates';
import { buildDemoDataset } from '../src/db/demo';
import { categories, categoryMap, makeAccount, makeCard } from './helpers';
import type { Budget } from '../src/domain/types';

describe('fronteiras do ciclo de fatura', () => {
  it('compra no dia do fechamento e no dia seguinte caem em faturas diferentes', () => {
    const card = makeCard({ closingDay: 20, dueDay: 28 });
    expect(invoiceRefForDate(card, '2024-03-20')).toBe('2024-03');
    expect(invoiceRefForDate(card, '2024-03-21')).toBe('2024-04');
  });

  it('fechamento e vencimento no mesmo dia: a fatura vence no mês seguinte', () => {
    const card = makeCard({ closingDay: 10, dueDay: 10 });
    expect(invoiceRefForDate(card, '2024-03-05')).toBe('2024-04');
    expect(invoicePeriod(card, '2024-04').dueDate).toBe('2024-04-10');
    expect(invoicePeriod(card, '2024-04').end).toBe('2024-03-10');
  });

  it('fechamento no dia 1º não deixa buraco entre períodos', () => {
    const card = makeCard({ closingDay: 1, dueDay: 15 });
    const marco = invoicePeriod(card, '2024-03');
    const abril = invoicePeriod(card, '2024-04');
    expect(marco.end).toBe('2024-03-01');
    expect(abril.start).toBe('2024-03-02');
    expect(addDays(marco.end, 1)).toBe(abril.start);
  });

  it('fechamento no dia 31 encaixa em todo mês curto, sem sobreposição', () => {
    const card = makeCard({ closingDay: 31, dueDay: 10 });
    for (const ref of ['2024-02', '2024-03', '2024-04', '2024-05', '2025-03']) {
      const period = invoicePeriod(card, ref);
      const previous = invoicePeriod(card, monthOf(addDays(period.start, -15)) === ref ? ref : ref);
      expect(period.start <= period.end).toBe(true);
      expect(previous).toBeDefined();
    }
    // Períodos consecutivos encostam sem sobrepor nem deixar vão.
    const fev = invoicePeriod(card, '2024-03'); // fecha 29/02
    const mar = invoicePeriod(card, '2024-04'); // fecha 31/03
    expect(fev.end).toBe('2024-02-29');
    expect(addDays(fev.end, 1)).toBe(mar.start);
  });

  it('toda compra de um ano inteiro cai em exatamente uma fatura', () => {
    for (const [closingDay, dueDay] of [[1, 15], [10, 10], [20, 28], [28, 5], [31, 10]] as const) {
      const card = makeCard({ id: `c-${closingDay}-${dueDay}`, closingDay, dueDay });
      let date = '2024-01-01';
      const seen = new Set<string>();
      for (let i = 0; i < 400; i++) {
        const period = invoicePeriod(card, invoiceRefForDate(card, date));
        expect(date >= period.start && date <= period.end).toBe(true);
        seen.add(date);
        date = addDays(date, 1);
      }
      expect(seen.size).toBe(400);
    }
  });
});

describe('parcelas em datas difíceis', () => {
  it('parcela iniciada em 31/01 de ano bissexto não repete mês', () => {
    const parcelas = buildInstallmentPurchase({
      date: '2024-01-31', description: 'Sofá', totalCents: 120_000, installments: 13, cardId: 'card',
    });
    const meses = parcelas.map((p) => monthOf(p.date));
    expect(new Set(meses).size).toBe(13);
    expect(parcelas[1]!.date).toBe('2024-02-29');
    expect(parcelas[12]!.date).toBe('2025-01-31');
  });

  it('recusa dividir um valor menor que o número de parcelas', () => {
    // R$ 0,01 em 2x daria uma parcela de zero centavo.
    expect(() =>
      buildInstallmentPurchase({ date: '2024-01-15', description: 'X', totalCents: 1, installments: 2, cardId: 'card' }),
    ).toThrow(/menos de um centavo/);
    expect(() =>
      buildInstallmentPurchase({ date: '2024-01-15', description: 'X', totalCents: 11, installments: 12, cardId: 'card' }),
    ).toThrow(/menos de um centavo/);
    // No limite exato ainda funciona: 12 centavos em 12x.
    expect(
      buildInstallmentPurchase({ date: '2024-01-15', description: 'X', totalCents: 12, installments: 12, cardId: 'card' }),
    ).toHaveLength(12);
  });

  it('a soma bate mesmo em valores que não dividem bem', () => {
    for (const total of [7, 99, 100, 9_999, 123_457]) {
      for (const n of [2, 3, 7, 12, 24]) {
        if (total < n) continue;
        const parcelas = buildInstallmentPurchase({
          date: '2024-01-15', description: 'X', totalCents: total, installments: n, cardId: 'card',
        });
        expect(sumCents(parcelas.map((p) => p.amountCents))).toBe(total);
      }
    }
  });

  it('parcelas atravessam o ano sem sumir do relatório', () => {
    const parcelas = buildInstallmentPurchase({
      date: '2024-11-10', description: 'TV', totalCents: 60_000, installments: 4, cardId: 'card',
      categoryId: 'cat-eletronicos',
    });
    expect(monthSummary('2024-12', parcelas, categoryMap).expenseCents).toBe(15_000);
    expect(monthSummary('2025-01', parcelas, categoryMap).expenseCents).toBe(15_000);
    expect(monthSummary('2025-02', parcelas, categoryMap).expenseCents).toBe(15_000);
  });
});

describe('saldo e compromissos não se sobrepõem nem deixam buraco', () => {
  const conta = makeAccount({ id: 'acc', openingBalanceCents: 100_000, openingDate: '2024-01-01' });
  const card = makeCard({ id: 'card', closingDay: 20, dueDay: 28 });
  const hoje = '2024-03-10';

  it('despesa agendada para o futuro sai do saldo E entra nos compromissos — uma vez cada', () => {
    const agendada = buildTransaction({
      kind: 'expense', date: '2024-03-25', description: 'IPTU', amountCents: 30_000, accountId: 'acc',
    });
    // Não entra no saldo de hoje…
    expect(accountBalance(conta, [agendada], { asOf: hoje })).toBe(100_000);
    // …mas está nos compromissos, exatamente uma vez.
    const c = futureCommitments({ cards: [], transactions: [agendada], recurring: [], today: hoje, horizonMonth: '2024-03' });
    expect(c.items).toHaveLength(1);
    expect(c.totalCents).toBe(30_000);
  });

  it('despesa prevista e vencida aparece como atrasada, não some', () => {
    const vencida = buildTransaction({
      kind: 'expense', date: '2024-03-01', description: 'Boleto atrasado', amountCents: 20_000,
      accountId: 'acc', status: 'pending',
    });
    expect(accountBalance(conta, [vencida], { asOf: hoje })).toBe(100_000);
    const c = futureCommitments({ cards: [], transactions: [vencida], recurring: [], today: hoje, horizonMonth: '2024-03' });
    expect(c.items[0]?.overdue).toBe(true);
    expect(c.totalCents).toBe(20_000);
  });

  it('compra de cartão nunca é contada como saldo e como compromisso ao mesmo tempo', () => {
    const compra = buildTransaction({
      kind: 'expense', date: '2024-03-05', description: 'Loja', amountCents: 50_000, cardId: 'card',
    });
    expect(accountBalance(conta, [compra], { asOf: hoje })).toBe(100_000); // não toca a conta
    const c = futureCommitments({ cards: [card], transactions: [compra], recurring: [], today: hoje, horizonMonth: '2024-03' });
    expect(c.totalCents).toBe(50_000); // aparece só via fatura
    expect(c.items).toHaveLength(1);
  });

  it('fatura paga sai dos compromissos e o dinheiro sai do saldo — sem contar duas vezes', () => {
    const compra = buildTransaction({
      kind: 'expense', date: '2024-02-05', description: 'Loja', amountCents: 50_000, cardId: 'card',
    });
    const pagamento = buildCardPayment({
      date: '2024-02-28', amountCents: 50_000, accountId: 'acc', cardId: 'card', invoiceRef: '2024-02',
    });
    const view = availability({
      accounts: [conta], cards: [card], transactions: [compra, pagamento], recurring: [], today: hoje,
      availabilityMonth: '2024-03',
    });
    expect(view.balanceCents).toBe(50_000); // saiu uma vez
    expect(view.committedCents).toBe(0);    // nada mais a pagar
    expect(view.availableCents).toBe(50_000);
  });

  it('transferência não muda o patrimônio somado', () => {
    const a = makeAccount({ id: 'a', openingBalanceCents: 100_000, openingDate: '2024-01-01' });
    const b = makeAccount({ id: 'b', openingBalanceCents: 0, openingDate: '2024-01-01' });
    const t = buildTransfer({ date: '2024-03-01', amountCents: 40_000, fromAccountId: 'a', toAccountId: 'b' });
    expect(accountBalance(a, [t]) + accountBalance(b, [t])).toBe(100_000);
  });
});

describe('reembolso maior que a despesa', () => {
  it('a categoria fica negativa e o total do mês acompanha, sem virar receita', () => {
    const despesa = buildTransaction({
      kind: 'expense', date: '2024-03-05', description: 'Jantar', amountCents: 10_000,
      accountId: 'a', categoryId: 'cat-restaurante',
    });
    const reembolso = buildTransaction({
      kind: 'refund', date: '2024-03-06', description: 'Devolução integral e mais', amountCents: 15_000,
      accountId: 'a', categoryId: 'cat-restaurante',
    });
    const resumo = monthSummary('2024-03', [despesa, reembolso], categoryMap);
    expect(resumo.expenseCents).toBe(-5_000);
    expect(resumo.incomeCents).toBe(0);
    // As categorias continuam somando exatamente o total.
    expect(sumCents(resumo.byCategory.map((c) => c.amountCents))).toBe(resumo.expenseCents);
  });
});

describe('semanas na virada de mês e de ano', () => {
  it('uma semana que cruza a virada do ano conta os dois lados', () => {
    const dez = buildTransaction({ kind: 'expense', date: '2024-12-31', description: 'A', amountCents: 1_000, accountId: 'a' });
    const jan = buildTransaction({ kind: 'expense', date: '2025-01-01', description: 'B', amountCents: 2_000, accountId: 'a' });
    const semana = weekSummary('2024-12-31', [dez, jan], categoryMap, 0);
    expect(semana.start).toBe('2024-12-29');
    expect(semana.end).toBe('2025-01-04');
    expect(semana.expenseCents).toBe(3_000);
    // Nos meses, cada um fica no seu.
    expect(monthSummary('2024-12', [dez, jan], categoryMap).expenseCents).toBe(1_000);
    expect(monthSummary('2025-01', [dez, jan], categoryMap).expenseCents).toBe(2_000);
  });

  it('a soma de todos os meses do ano é igual ao ano inteiro', () => {
    const data = buildDemoDataset({ endMonth: '2024-06', months: 6, today: '2024-06-18' });
    const meses = ['2024-01', '2024-02', '2024-03', '2024-04', '2024-05', '2024-06'];
    const soma = sumCents(meses.map((m) => monthSummary(m, data.transactions, categoryMap).expenseCents));
    const periodo = periodSummary(data.transactions, '2024-01-01', '2024-06-30', categoryMap);
    expect(soma).toBe(periodo.expenseCents);
  });
});

describe('orçamento em situações-limite', () => {
  const budget = (categoryId: string, limitCents: number, month: string | null): Budget => ({
    id: `b-${categoryId}-${month ?? 'd'}`, categoryId, limitCents, month,
    createdAt: '', updatedAt: '',
  });

  it('gasto exatamente igual ao limite ainda não é estouro', () => {
    const tx = buildTransaction({
      kind: 'expense', date: '2024-03-05', description: 'X', amountCents: 50_000,
      accountId: 'a', categoryId: 'cat-mercado',
    });
    const status = budgetStatuses('2024-03', [budget('cat-mercado', 50_000, null)], categories, [tx])[0]!;
    expect(status.over).toBe(false);
    expect(status.remainingCents).toBe(0);
    expect(status.usageRatio).toBe(1);
  });

  it('limite específico do mês não vaza para os outros meses', () => {
    const budgets = [budget('cat-mercado', 50_000, null), budget('cat-mercado', 200_000, '2024-03')];
    expect(budgetStatuses('2024-03', budgets, categories, [])[0]!.limitCents).toBe(200_000);
    expect(budgetStatuses('2024-04', budgets, categories, [])[0]!.limitCents).toBe(50_000);
  });

  it('compra de cartão consome orçamento no mês da compra, não no do pagamento', () => {
    const compra = buildTransaction({
      kind: 'expense', date: '2024-03-25', description: 'Mercado', amountCents: 30_000,
      cardId: 'card', categoryId: 'cat-mercado',
    });
    const pagamento = buildCardPayment({
      date: '2024-04-28', amountCents: 30_000, accountId: 'a', cardId: 'card', invoiceRef: '2024-04',
    });
    const marco = budgetStatuses('2024-03', [budget('cat-mercado', 50_000, null)], categories, [compra, pagamento])[0]!;
    const abril = budgetStatuses('2024-04', [budget('cat-mercado', 50_000, null)], categories, [compra, pagamento])[0]!;
    expect(marco.spentCents).toBe(30_000);
    expect(abril.spentCents).toBe(0);
  });
});

describe('pagamento a maior e fatura sem compras', () => {
  const card = makeCard({ id: 'card', closingDay: 20, dueDay: 28 });

  it('pagar mais que a fatura não deixa saldo negativo em aberto', () => {
    const compra = buildTransaction({
      kind: 'expense', date: '2024-03-05', description: 'X', amountCents: 10_000, cardId: 'card',
    });
    const pagamento = buildCardPayment({
      date: '2024-03-28', amountCents: 15_000, accountId: 'a', cardId: 'card', invoiceRef: '2024-03',
    });
    const fatura = buildInvoice(card, '2024-03', [compra, pagamento], '2024-04-01');
    expect(fatura.openCents).toBe(0);
    expect(fatura.status).toBe('paid');
  });

  it('a auditoria avisa sobre pagamento a maior em vez de esconder', () => {
    const compra = buildTransaction({
      kind: 'expense', date: '2024-03-05', description: 'X', amountCents: 10_000, cardId: 'card',
    });
    const pagamento = buildCardPayment({
      date: '2024-03-28', amountCents: 15_000, accountId: 'acc', cardId: 'card', invoiceRef: '2024-03',
    });
    const report = auditDataset(
      {
        accounts: [makeAccount({ id: 'acc' })], cards: [card], categories,
        transactions: [compra, pagamento], budgets: [], rules: [], recurring: [], imports: [],
        settings: { id: 'singleton', firstDayOfWeek: 0, theme: 'system', lowBalanceThresholdCents: 0,
          budgetWarnRatio: 0.8, commitmentHorizonMonths: 12, hideAmounts: false, updatedAt: '' },
      },
      '2024-04-01',
    );
    expect(report.findings.some((f) => f.id.startsWith('invoice-overpaid'))).toBe(true);
  });
});

describe('a auditoria realmente pega os erros que promete pegar', () => {
  const base = {
    accounts: [makeAccount({ id: 'acc', openingBalanceCents: 0, openingDate: '2024-01-01' })],
    cards: [makeCard({ id: 'card' })],
    categories,
    budgets: [] as Budget[],
    rules: [],
    recurring: [],
    imports: [],
    settings: { id: 'singleton' as const, firstDayOfWeek: 0 as const, theme: 'system' as const,
      lowBalanceThresholdCents: 0, budgetWarnRatio: 0.8, commitmentHorizonMonths: 12,
      hideAmounts: false, updatedAt: '' },
  };

  it('pega despesa que na verdade é pagamento de fatura', () => {
    const errado = buildTransaction({
      kind: 'expense', date: '2024-03-28', description: 'PAGAMENTO FATURA CARTAO',
      amountCents: 200_000, accountId: 'acc',
    });
    const report = auditDataset({ ...base, transactions: [errado] }, '2024-04-01');
    expect(report.findings.some((f) => f.id === 'invoice-payment-as-expense')).toBe(true);
    expect(report.errorCount).toBeGreaterThan(0);
  });

  it('pega despesa que parece transferência entre contas', () => {
    const suspeita = buildTransaction({
      kind: 'expense', date: '2024-03-10', description: 'TED ENVIADA PARA MINHA POUPANCA',
      amountCents: 100_000, accountId: 'acc',
    });
    const report = auditDataset({ ...base, transactions: [suspeita] }, '2024-04-01');
    expect(report.findings.some((f) => f.id === 'suspicious-transfer')).toBe(true);
  });

  it('pega lançamento órfão depois de excluir a categoria', () => {
    const orfao = buildTransaction({
      kind: 'expense', date: '2024-03-10', description: 'X', amountCents: 1_000,
      accountId: 'acc', categoryId: 'categoria-que-nao-existe',
    });
    const report = auditDataset({ ...base, transactions: [orfao] }, '2024-04-01');
    expect(report.findings.some((f) => f.group === 'Referências')).toBe(true);
  });

  it('pega parcelas que não somam o total da compra', () => {
    const parcelas = buildInstallmentPurchase({
      date: '2024-01-10', description: 'Notebook', totalCents: 120_000, installments: 6, cardId: 'card',
    });
    // Simula alguém editando uma parcela e quebrando a soma.
    const quebrado = parcelas.map((p, i) => (i === 0 ? { ...p, amountCents: 19_000 } : p));
    const report = auditDataset({ ...base, transactions: quebrado }, '2024-04-01');
    expect(report.findings.some((f) => f.id.startsWith('installment-sum'))).toBe(true);
  });

  it('pega parcela faltando', () => {
    const parcelas = buildInstallmentPurchase({
      date: '2024-01-10', description: 'Notebook', totalCents: 120_000, installments: 6, cardId: 'card',
    });
    const report = auditDataset({ ...base, transactions: parcelas.slice(0, 4) }, '2024-04-01');
    expect(report.findings.some((f) => f.id.startsWith('installment-count'))).toBe(true);
  });

  it('pega valor que não é centavo inteiro', () => {
    const bom = buildTransaction({
      kind: 'expense', date: '2024-03-10', description: 'X', amountCents: 1_000, accountId: 'acc',
    });
    const report = auditDataset({ ...base, transactions: [{ ...bom, amountCents: 10.5 }] }, '2024-04-01');
    expect(report.findings.some((f) => f.id === 'non-integer-cents')).toBe(true);
  });

  it('pega lançamento anterior à abertura da conta, que sumiria do saldo em silêncio', () => {
    const antigo = buildTransaction({
      kind: 'expense', date: '2023-12-01', description: 'Antigo', amountCents: 5_000, accountId: 'acc',
    });
    const report = auditDataset({ ...base, transactions: [antigo] }, '2024-04-01');
    expect(report.findings.some((f) => f.id.startsWith('before-opening'))).toBe(true);
  });

  it('não acusa nada num conjunto correto', () => {
    const compra = buildTransaction({
      kind: 'expense', date: '2024-03-05', description: 'Mercado', amountCents: 20_000,
      cardId: 'card', categoryId: 'cat-mercado',
    });
    const salario = buildTransaction({
      kind: 'income', date: '2024-03-05', description: 'Salário', amountCents: 500_000,
      accountId: 'acc', categoryId: 'cat-salario',
    });
    const report = auditDataset({ ...base, transactions: [compra, salario] }, '2024-04-01');
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(0);
  });
});

describe('duplicidade em cenário grande', () => {
  it('o cenário fictício inteiro não gera falso positivo', () => {
    const data = buildDemoDataset({ endMonth: '2024-06', months: 6, today: '2024-06-18' });
    expect(scanForDuplicates(data.transactions)).toHaveLength(0);
  });

  it('reimportar o mesmo lançamento é detectado', () => {
    const original = buildTransaction({
      kind: 'expense', date: '2024-03-10', description: 'MERCADO BOM PRECO', amountCents: 32_050, accountId: 'acc',
    });
    const copia = buildTransaction({
      kind: 'expense', date: '2024-03-10', description: 'MERCADO BOM PRECO', amountCents: 32_050, accountId: 'acc',
    });
    expect(scanForDuplicates([original, copia])).toHaveLength(1);
  });
});

describe('valores grandes e pequenos', () => {
  it('um centavo é tratado corretamente', () => {
    const tx = buildTransaction({
      kind: 'expense', date: '2024-03-10', description: 'Arredondamento', amountCents: 1,
      accountId: 'a', categoryId: 'cat-outros',
    });
    expect(monthSummary('2024-03', [tx], categoryMap).expenseCents).toBe(1);
  });

  it('valores altos não perdem precisão', () => {
    const grande = toCents(9_999_999.99);
    const tx = buildTransaction({
      kind: 'income', date: '2024-03-10', description: 'Venda de imóvel', amountCents: grande, accountId: 'a',
    });
    expect(monthSummary('2024-03', [tx], categoryMap).incomeCents).toBe(999_999_999);
  });

  it('mil lançamentos de R$ 0,07 somam exatamente R$ 70,00', () => {
    const lista = Array.from({ length: 1000 }, (_, i) =>
      buildTransaction({
        kind: 'expense', date: '2024-03-10', description: `Café ${i}`, amountCents: 7,
        accountId: 'a', categoryId: 'cat-padaria',
      }),
    );
    expect(monthSummary('2024-03', lista, categoryMap).expenseCents).toBe(7_000);
  });
});

describe('faturas e listagem em massa', () => {
  it('a soma das faturas fecha com as compras em qualquer configuração de cartão', () => {
    for (const [closingDay, dueDay] of [[1, 15], [10, 10], [20, 28], [28, 5], [31, 10]] as const) {
      const card = makeCard({ id: `c${closingDay}${dueDay}`, closingDay, dueDay });
      const compras = Array.from({ length: 60 }, (_, i) =>
        buildTransaction({
          kind: 'expense',
          date: addDays('2024-01-01', i * 5),
          description: `Compra ${i}`,
          amountCents: 1_000 + i,
          cardId: card.id,
        }),
      );
      const total = sumCents(compras.map((c) => c.amountCents));
      const faturas = listInvoices(card, compras, '2024-12-31').reduce((s, f) => s + f.totalCents, 0);
      expect(faturas).toBe(total);
    }
  });
});
