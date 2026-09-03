import { describe, expect, it } from 'vitest';
import { budgetOverall, budgetStatuses, resolveLimit, spentInCategory } from '../src/domain/budget';
import { availability, futureCommitments, installmentPlans } from '../src/domain/commitments';
import { buildCardPayment, buildInstallmentPurchase, buildTransaction } from '../src/domain/transaction';
import { categories, makeAccount, makeCard } from './helpers';
import type { Budget, RecurringRule } from '../src/domain/types';

const budget = (categoryId: string, limitCents: number, month: string | null = null): Budget => ({
  id: `b-${categoryId}-${month ?? 'default'}`,
  categoryId,
  limitCents,
  month,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
});

describe('orçamento', () => {
  const lancamentos = [
    buildTransaction({ kind: 'expense', date: '2024-03-02', description: 'Mercado', amountCents: 40_000, accountId: 'a', categoryId: 'cat-mercado' }),
    buildTransaction({ kind: 'expense', date: '2024-03-10', description: 'Restaurante', amountCents: 25_000, accountId: 'a', categoryId: 'cat-restaurante' }),
    buildTransaction({ kind: 'expense', date: '2024-03-15', description: 'Cinema', amountCents: 8_000, accountId: 'a', categoryId: 'cat-cultura' }),
    buildTransaction({ kind: 'expense', date: '2024-02-15', description: 'Mercado fev', amountCents: 90_000, accountId: 'a', categoryId: 'cat-mercado' }),
  ];

  it('o gasto da categoria SOMA as subcategorias', () => {
    // Alimentação = Mercado + Restaurante
    expect(spentInCategory('cat-alimentacao', '2024-03', lancamentos, categories)).toBe(65_000);
    expect(spentInCategory('cat-mercado', '2024-03', lancamentos, categories)).toBe(40_000);
  });

  it('não mistura meses', () => {
    expect(spentInCategory('cat-mercado', '2024-02', lancamentos, categories)).toBe(90_000);
  });

  it('calcula limite, gasto, restante e percentual', () => {
    const status = budgetStatuses('2024-03', [budget('cat-alimentacao', 100_000)], categories, lancamentos)[0]!;
    expect(status.limitCents).toBe(100_000);
    expect(status.spentCents).toBe(65_000);
    expect(status.remainingCents).toBe(35_000);
    expect(status.usageRatio).toBeCloseTo(0.65, 5);
    expect(status.over).toBe(false);
  });

  it('acusa estouro com o valor excedente', () => {
    const status = budgetStatuses('2024-03', [budget('cat-alimentacao', 50_000)], categories, lancamentos)[0]!;
    expect(status.over).toBe(true);
    expect(status.remainingCents).toBe(-15_000);
  });

  it('avisa quando passa do limite de alerta', () => {
    const status = budgetStatuses('2024-03', [budget('cat-alimentacao', 70_000)], categories, lancamentos, 0.8)[0]!;
    expect(status.warn).toBe(true);
    expect(status.over).toBe(false);
  });

  it('o valor do mês sobrescreve o orçamento padrão', () => {
    const budgets = [budget('cat-mercado', 50_000, null), budget('cat-mercado', 120_000, '2024-03')];
    expect(resolveLimit(budgets, 'cat-mercado', '2024-03')).toEqual({ limitCents: 120_000, fromDefault: false });
    expect(resolveLimit(budgets, 'cat-mercado', '2024-04')).toEqual({ limitCents: 50_000, fromDefault: true });
  });

  it('reembolso devolve orçamento', () => {
    const reembolso = buildTransaction({ kind: 'refund', date: '2024-03-12', description: 'Devolução', amountCents: 10_000, accountId: 'a', categoryId: 'cat-restaurante' });
    expect(spentInCategory('cat-alimentacao', '2024-03', [...lancamentos, reembolso], categories)).toBe(55_000);
  });

  it('consolida o orçamento total', () => {
    const statuses = budgetStatuses('2024-03', [budget('cat-alimentacao', 100_000), budget('cat-lazer', 5_000)], categories, lancamentos);
    const overall = budgetOverall(statuses);
    expect(overall.limitCents).toBe(105_000);
    expect(overall.spentCents).toBe(73_000);
    expect(overall.overCount).toBe(1);
  });
});

describe('compromissos futuros', () => {
  const card = makeCard({ id: 'card', closingDay: 20, dueDay: 28, limitCents: 1_000_000 });
  const conta = makeAccount({ id: 'acc', openingBalanceCents: 500_000, openingDate: '2024-01-01' });
  const hoje = '2024-03-10';

  const parcelas = buildInstallmentPurchase({
    date: '2024-02-10',
    description: 'Geladeira',
    totalCents: 120_000,
    installments: 6,
    cardId: 'card',
  });

  it('parcelas futuras entram pelas faturas, sem contar duas vezes', () => {
    const resultado = futureCommitments({
      cards: [card],
      transactions: parcelas,
      recurring: [],
      today: hoje,
      horizonMonth: '2024-08',
    });
    // 6 parcelas de R$ 200 = R$ 1.200 comprometidos, contados uma única vez.
    expect(resultado.totalCents).toBe(120_000);
    expect(resultado.invoiceCents).toBe(120_000);
    expect(resultado.scheduledCents).toBe(0);
  });

  it('o horizonte limita o que é considerado', () => {
    const curto = futureCommitments({ cards: [card], transactions: parcelas, recurring: [], today: hoje, horizonMonth: '2024-03' });
    // Só as faturas com vencimento até 31/03: fevereiro e março.
    expect(curto.totalCents).toBe(40_000);
  });

  it('despesa prevista em conta entra como agendada', () => {
    const boleto = buildTransaction({ kind: 'expense', date: '2024-03-25', description: 'IPTU', amountCents: 60_000, accountId: 'acc', status: 'pending' });
    const resultado = futureCommitments({ cards: [], transactions: [boleto], recurring: [], today: hoje, horizonMonth: '2024-03' });
    expect(resultado.scheduledCents).toBe(60_000);
  });

  it('conta fixa é projetada enquanto não é lançada', () => {
    const regra: RecurringRule = {
      id: 'r1', description: 'Aluguel', amountCents: 180_000, kind: 'expense',
      categoryId: 'cat-aluguel', dayOfMonth: 5, accountId: 'acc', paymentMethod: 'debit',
      isFixed: true, startMonth: '2024-01', endMonth: null, active: true,
      createdAt: '', updatedAt: '',
    };
    const semLancamento = futureCommitments({ cards: [], transactions: [], recurring: [regra], today: hoje, horizonMonth: '2024-04' });
    expect(semLancamento.recurringCents).toBe(360_000); // março + abril

    // Depois de lançar o aluguel de março, a projeção some daquele mês.
    const lancado = buildTransaction({ kind: 'expense', date: '2024-03-05', description: 'Aluguel', amountCents: 180_000, accountId: 'acc', categoryId: 'cat-aluguel', recurringRuleId: 'r1' });
    const comLancamento = futureCommitments({ cards: [], transactions: [lancado], recurring: [regra], today: hoje, horizonMonth: '2024-04' });
    expect(comLancamento.recurringCents).toBe(180_000); // só abril
  });

  it('reconhece a conta fixa lançada à mão pela descrição', () => {
    const regra: RecurringRule = {
      id: 'r2', description: 'Netflix', amountCents: 5_990, kind: 'expense',
      categoryId: 'cat-streaming', dayOfMonth: 15, cardId: 'card', paymentMethod: 'credit',
      isFixed: true, startMonth: '2024-01', endMonth: null, active: true,
      createdAt: '', updatedAt: '',
    };
    const manual = buildTransaction({ kind: 'expense', date: '2024-03-15', description: 'NETFLIX.COM', amountCents: 5_990, cardId: 'card', categoryId: 'cat-streaming' });
    const resultado = futureCommitments({ cards: [], transactions: [manual], recurring: [regra], today: hoje, horizonMonth: '2024-03' });
    expect(resultado.recurringCents).toBe(0);
  });

  it('SALDO − COMPROMISSOS = DISPONÍVEL', () => {
    const view = availability({
      accounts: [conta],
      cards: [card],
      transactions: parcelas,
      recurring: [],
      today: hoje,
      availabilityMonth: '2024-03',
    });
    expect(view.balanceCents).toBe(500_000);
    expect(view.committedCents).toBe(40_000); // faturas de fev e mar
    expect(view.availableCents).toBe(460_000);
    expect(view.balanceCents - view.committedCents).toBe(view.availableCents);
  });

  it('mostra disponível negativo quando os compromissos passam do saldo', () => {
    const pobre = makeAccount({ id: 'acc2', openingBalanceCents: 10_000, openingDate: '2024-01-01' });
    const view = availability({ accounts: [pobre], cards: [card], transactions: parcelas, recurring: [], today: hoje, availabilityMonth: '2024-03' });
    expect(view.availableCents).toBe(10_000 - 40_000);
  });

  it('fatura paga sai dos compromissos', () => {
    const pg = buildCardPayment({ date: '2024-02-28', amountCents: 20_000, accountId: 'acc', cardId: 'card', invoiceRef: '2024-02' });
    const resultado = futureCommitments({ cards: [card], transactions: [...parcelas, pg], recurring: [], today: hoje, horizonMonth: '2024-08' });
    expect(resultado.totalCents).toBe(100_000);
  });
});

describe('andamento das parcelas', () => {
  it('mostra pagas, restantes e valor futuro', () => {
    const parcelas = buildInstallmentPurchase({ date: '2024-01-10', description: 'Notebook', totalCents: 120_000, installments: 6, cardId: 'card' });
    const plano = installmentPlans(parcelas, '2024-03-15')[0]!;
    expect(plano.installmentTotal).toBe(6);
    expect(plano.paidCount).toBe(3);        // jan, fev, mar
    expect(plano.remainingCount).toBe(3);   // abr, mai, jun
    expect(plano.paidCents).toBe(60_000);
    expect(plano.remainingCents).toBe(60_000);
    expect(plano.paidCents + plano.remainingCents).toBe(plano.totalCents);
    expect(plano.nextDate).toBe('2024-04-10');
    expect(plano.lastDate).toBe('2024-06-10');
  });

  it('compra à vista não vira plano de parcelas', () => {
    const avista = buildTransaction({ kind: 'expense', date: '2024-03-10', description: 'Café', amountCents: 1_500, cardId: 'card' });
    expect(installmentPlans([avista], '2024-03-15')).toHaveLength(0);
  });
});
