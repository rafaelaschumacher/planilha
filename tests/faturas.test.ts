import { describe, expect, it } from 'vitest';
import {
  allocatePayments,
  buildInvoice,
  cardUsage,
  currentInvoice,
  invoicePeriod,
  invoiceRefForDate,
  invoiceRefForPaymentDate,
  listInvoices,
  openInvoices,
} from '../src/domain/invoice';
import { buildCardPayment, buildInstallmentPurchase, buildTransaction } from '../src/domain/transaction';
import { makeCard } from './helpers';

describe('ciclo de fechamento e vencimento', () => {
  // Fecha dia 20, vence dia 28 do MESMO mês (vencimento > fechamento).
  const mesmoMes = makeCard({ id: 'c1', closingDay: 20, dueDay: 28 });
  // Fecha dia 25, vence dia 5 do mês SEGUINTE (vencimento <= fechamento).
  const mesSeguinte = makeCard({ id: 'c2', closingDay: 25, dueDay: 5 });

  it('compra antes do fechamento cai na fatura que fecha no mês', () => {
    expect(invoiceRefForDate(mesmoMes, '2024-03-01')).toBe('2024-03');
    expect(invoiceRefForDate(mesmoMes, '2024-03-19')).toBe('2024-03');
    expect(invoiceRefForDate(mesmoMes, '2024-03-20')).toBe('2024-03'); // no dia do fechamento ainda entra
  });

  it('compra depois do fechamento cai na fatura seguinte', () => {
    expect(invoiceRefForDate(mesmoMes, '2024-03-21')).toBe('2024-04');
    expect(invoiceRefForDate(mesmoMes, '2024-03-31')).toBe('2024-04');
  });

  it('quando o vencimento é menor que o fechamento, a fatura vence no mês seguinte', () => {
    expect(invoiceRefForDate(mesSeguinte, '2024-03-10')).toBe('2024-04');
    expect(invoiceRefForDate(mesSeguinte, '2024-03-26')).toBe('2024-05');
  });

  it('o período da fatura é contínuo e sem sobreposição', () => {
    const marco = invoicePeriod(mesmoMes, '2024-03');
    const abril = invoicePeriod(mesmoMes, '2024-04');
    expect(marco.start).toBe('2024-02-21');
    expect(marco.end).toBe('2024-03-20');
    expect(marco.dueDate).toBe('2024-03-28');
    expect(abril.start).toBe('2024-03-21'); // dia seguinte ao fim da anterior
    expect(abril.end).toBe('2024-04-20');
  });

  it('encaixa fechamento dia 31 em fevereiro', () => {
    const card = makeCard({ id: 'c3', closingDay: 31, dueDay: 10 });
    expect(invoicePeriod(card, '2024-03').end).toBe('2024-02-29');
    expect(invoiceRefForDate(card, '2024-02-29')).toBe('2024-03');
  });

  it('toda compra cai em exatamente uma fatura', () => {
    const card = makeCard({ id: 'c4', closingDay: 20, dueDay: 28 });
    // Varre 400 dias e confere que a data sempre cai dentro do período da
    // fatura escolhida — nenhuma compra fica órfã, nenhuma cai em duas.
    let date = '2024-01-01';
    for (let i = 0; i < 400; i++) {
      const ref = invoiceRefForDate(card, date);
      const period = invoicePeriod(card, ref);
      expect(date >= period.start && date <= period.end).toBe(true);
      const day = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + 1));
      date = day.toISOString().slice(0, 10);
    }
  });
});

describe('fatura montada a partir das compras', () => {
  const card = makeCard({ id: 'card', closingDay: 20, dueDay: 28, limitCents: 500_000 });

  const compras = [
    buildTransaction({ kind: 'expense', date: '2024-02-25', description: 'Livraria', amountCents: 9_900, cardId: 'card' }),
    buildTransaction({ kind: 'expense', date: '2024-03-05', description: 'Mercado', amountCents: 45_000, cardId: 'card' }),
    buildTransaction({ kind: 'expense', date: '2024-03-20', description: 'Posto', amountCents: 20_000, cardId: 'card' }),
    buildTransaction({ kind: 'expense', date: '2024-03-21', description: 'Cinema', amountCents: 6_000, cardId: 'card' }),
  ];

  it('agrupa só as compras do período', () => {
    const fatura = buildInvoice(card, '2024-03', compras, '2024-03-25');
    expect(fatura.items.map((i) => i.description)).toEqual(['Livraria', 'Mercado', 'Posto']);
    expect(fatura.totalCents).toBe(9_900 + 45_000 + 20_000);
    // Cinema (21/03) já foi para a fatura de abril.
    expect(buildInvoice(card, '2024-04', compras, '2024-03-25').totalCents).toBe(6_000);
  });

  it('estorno abate da fatura do período', () => {
    const estorno = buildTransaction({ kind: 'chargeback', date: '2024-03-10', description: 'Mercado cancelado', amountCents: 45_000, cardId: 'card' });
    const fatura = buildInvoice(card, '2024-03', [...compras, estorno], '2024-03-25');
    expect(fatura.totalCents).toBe(9_900 + 20_000);
  });

  it('a soma das faturas é igual à soma das compras', () => {
    const total = compras.reduce((sum, c) => sum + c.amountCents, 0);
    const somaFaturas = listInvoices(card, compras, '2024-04-30').reduce((sum, f) => sum + f.totalCents, 0);
    expect(somaFaturas).toBe(total);
  });
});

describe('estados da fatura', () => {
  const card = makeCard({ id: 'card', closingDay: 20, dueDay: 28 });
  const compra = buildTransaction({ kind: 'expense', date: '2024-03-05', description: 'Compra', amountCents: 50_000, cardId: 'card' });

  it('aberta enquanto não fechou', () => {
    expect(buildInvoice(card, '2024-03', [compra], '2024-03-15').status).toBe('open');
  });

  it('fechada depois do fechamento e antes do vencimento', () => {
    expect(buildInvoice(card, '2024-03', [compra], '2024-03-22').status).toBe('closed');
  });

  it('vencida quando passou do vencimento sem pagar', () => {
    expect(buildInvoice(card, '2024-03', [compra], '2024-04-01').status).toBe('overdue');
  });

  it('paga quando quitada', () => {
    const pg = buildCardPayment({ date: '2024-03-28', amountCents: 50_000, accountId: 'a', cardId: 'card', invoiceRef: '2024-03' });
    const fatura = buildInvoice(card, '2024-03', [compra, pg], '2024-04-01');
    expect(fatura.status).toBe('paid');
    expect(fatura.openCents).toBe(0);
  });

  it('parcialmente paga quando o pagamento não cobre tudo', () => {
    const pg = buildCardPayment({ date: '2024-03-28', amountCents: 20_000, accountId: 'a', cardId: 'card', invoiceRef: '2024-03' });
    const fatura = buildInvoice(card, '2024-03', [compra, pg], '2024-03-27');
    expect(fatura.status).toBe('partial');
    expect(fatura.openCents).toBe(30_000);
  });
});

describe('alocação de pagamentos', () => {
  const card = makeCard({ id: 'card', closingDay: 20, dueDay: 28 });
  const compraMarco = buildTransaction({ kind: 'expense', date: '2024-03-05', description: 'A', amountCents: 30_000, cardId: 'card' });
  const compraAbril = buildTransaction({ kind: 'expense', date: '2024-04-05', description: 'B', amountCents: 40_000, cardId: 'card' });

  it('pagamento sem referência abate a fatura mais antiga primeiro', () => {
    const pg = buildCardPayment({ date: '2024-04-28', amountCents: 50_000, accountId: 'a', cardId: 'card' });
    const alloc = allocatePayments(card, [compraMarco, compraAbril, pg]);
    expect(alloc.get('2024-03')?.paidCents).toBe(30_000);
    expect(alloc.get('2024-04')?.paidCents).toBe(20_000);
  });

  it('cada centavo de um pagamento é usado uma única vez', () => {
    const pg = buildCardPayment({ date: '2024-04-28', amountCents: 50_000, accountId: 'a', cardId: 'card' });
    const alloc = allocatePayments(card, [compraMarco, compraAbril, pg]);
    const total = Array.from(alloc.values()).reduce((sum, v) => sum + v.paidCents, 0);
    expect(total).toBe(50_000);
  });

  it('pagamento com referência vai para a fatura indicada', () => {
    const pg = buildCardPayment({ date: '2024-04-28', amountCents: 40_000, accountId: 'a', cardId: 'card', invoiceRef: '2024-04' });
    const alloc = allocatePayments(card, [compraMarco, compraAbril, pg]);
    expect(alloc.get('2024-04')?.paidCents).toBe(40_000);
    expect(alloc.get('2024-03')).toBeUndefined();
  });

  it('faturas em aberto listam apenas o que já fechou e não foi pago', () => {
    const abertas = openInvoices(card, [compraMarco, compraAbril], '2024-04-10');
    expect(abertas.map((f) => f.ref)).toEqual(['2024-03']);
  });
});

describe('limite do cartão', () => {
  const card = makeCard({ id: 'card', limitCents: 300_000, closingDay: 20, dueDay: 28 });

  it('parcelas futuras já comprometem o limite hoje', () => {
    const parcelas = buildInstallmentPurchase({ date: '2024-03-10', description: 'Notebook', totalCents: 120_000, installments: 6, cardId: 'card' });
    const uso = cardUsage(card, parcelas);
    expect(uso.usedCents).toBe(120_000);
    expect(uso.availableCents).toBe(180_000);
  });

  it('pagar a fatura devolve limite', () => {
    const compra = buildTransaction({ kind: 'expense', date: '2024-03-10', description: 'X', amountCents: 100_000, cardId: 'card' });
    const pg = buildCardPayment({ date: '2024-03-28', amountCents: 100_000, accountId: 'a', cardId: 'card', invoiceRef: '2024-03' });
    expect(cardUsage(card, [compra, pg]).availableCents).toBe(300_000);
  });

  it('a fatura corrente aparece mesmo sem nenhuma compra', () => {
    const fatura = currentInvoice(card, [], '2024-03-10');
    expect(fatura.ref).toBe('2024-03');
    expect(fatura.totalCents).toBe(0);
    expect(fatura.status).toBe('empty');
  });
});

describe('pagamento quita a fatura certa', () => {
  // Cartão que fecha dia 5 e vence dia 15 — o caso em que a regra de COMPRA
  // daria a resposta errada para um PAGAMENTO.
  const card = makeCard({ id: 'card', closingDay: 5, dueDay: 15 });

  it('pagar no dia do vencimento quita a fatura daquele mês', () => {
    expect(invoiceRefForPaymentDate(card, '2024-03-15')).toBe('2024-03');
    // Pela regra de compra, 15/03 já pertenceria à fatura de abril.
    expect(invoiceRefForDate(card, '2024-03-15')).toBe('2024-04');
  });

  it('pagar alguns dias antes ou depois ainda quita a mesma fatura', () => {
    expect(invoiceRefForPaymentDate(card, '2024-03-12')).toBe('2024-03');
    expect(invoiceRefForPaymentDate(card, '2024-03-18')).toBe('2024-03');
  });

  it('pende para a fatura vencida, não para a que ainda nem fechou', () => {
    // Em 28/02 a fatura de fevereiro venceu há 13 dias e a de março vence em
    // 16. Quem paga nesse dia está quitando a atrasada.
    expect(invoiceRefForPaymentDate(card, '2024-02-28')).toBe('2024-02');
    // Em 02/04 a de março está atrasada e a de abril nem fechou (fecha 05/04).
    expect(invoiceRefForPaymentDate(card, '2024-04-02')).toBe('2024-03');
    // Já em 20/04, a de abril venceu no dia 15: é essa.
    expect(invoiceRefForPaymentDate(card, '2024-04-20')).toBe('2024-04');
  });

  it('aceita pagamento adiantado dentro de uma semana do vencimento', () => {
    expect(invoiceRefForPaymentDate(card, '2024-04-10')).toBe('2024-04');
  });

  it('a fatura de fato fica quitada, sem ficar eternamente em aberto', () => {
    const compra = buildTransaction({
      kind: 'expense', date: '2024-02-10', description: 'Compra', amountCents: 50_000, cardId: 'card',
    });
    const pagamento = buildCardPayment({
      date: '2024-03-15',
      amountCents: 50_000,
      accountId: 'acc',
      cardId: 'card',
      invoiceRef: invoiceRefForPaymentDate(card, '2024-03-15'),
    });
    // A compra de 10/02 fecha em 05/03 e vence em 15/03.
    expect(invoiceRefForDate(card, '2024-02-10')).toBe('2024-03');
    const fatura = buildInvoice(card, '2024-03', [compra, pagamento], '2024-03-20');
    expect(fatura.totalCents).toBe(50_000);
    expect(fatura.openCents).toBe(0);
    expect(fatura.status).toBe('paid');
  });

  it('funciona também no cartão que fecha e vence no mesmo mês', () => {
    const simples = makeCard({ id: 'c2', closingDay: 20, dueDay: 28 });
    expect(invoiceRefForPaymentDate(simples, '2024-03-28')).toBe('2024-03');
    expect(invoiceRefForPaymentDate(simples, '2024-04-01')).toBe('2024-03');
  });
});
