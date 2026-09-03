/**
 * O TESTE PRINCIPAL DO PRODUTO.
 *
 *   Uma compra no cartão + o pagamento da fatura
 *   =  UMA ÚNICA DESPESA.
 *
 * Se este arquivo falhar, todo número da plataforma está errado.
 */

import { describe, expect, it } from 'vitest';
import { buildCardPayment, buildTransaction, pnlEffect } from '../src/domain/transaction';
import { buildInvoice, cardUsage, invoiceRefForDate } from '../src/domain/invoice';
import { accountBalance, monthSummary } from '../src/domain/engine';
import { categoryMap, makeAccount, makeCard } from './helpers';

describe('compra no cartão ≠ pagamento da fatura', () => {
  const conta = makeAccount({ id: 'acc-1', openingBalanceCents: 500_000, openingDate: '2024-02-01' });
  const cartao = makeCard({ id: 'card-1', closingDay: 20, dueDay: 28, limitCents: 800_000 });

  // Compra de R$ 200 no cartão em 05/03 → cai na fatura que fecha em 20/03
  // e vence em 28/03.
  const compra = buildTransaction({
    kind: 'expense',
    date: '2024-03-05',
    description: 'Mercado Bom Preço',
    amountCents: 20_000,
    cardId: cartao.id,
    categoryId: 'cat-mercado',
  });

  // Pagamento da fatura de R$ 2.000 pela conta bancária.
  const pagamento = buildCardPayment({
    date: '2024-03-28',
    amountCents: 200_000,
    accountId: conta.id,
    cardId: cartao.id,
    invoiceRef: '2024-03',
  });

  const base = [compra, pagamento];

  it('a compra é despesa; o pagamento da fatura NÃO é', () => {
    expect(pnlEffect(compra)).toEqual({ income: 0, expense: 20_000 });
    expect(pnlEffect(pagamento)).toEqual({ income: 0, expense: 0 });
  });

  it('o mês registra R$ 200 de despesa — não R$ 2.200', () => {
    const resumo = monthSummary('2024-03', base, categoryMap);
    expect(resumo.expenseCents).toBe(20_000);
    expect(resumo.cardExpenseCents).toBe(20_000);
    expect(resumo.cardPaymentCents).toBe(200_000); // registrado, mas fora da despesa
  });

  it('a compra no cartão NÃO sai da conta; o pagamento sai', () => {
    // Antes do pagamento: só a compra existe, e ela não toca a conta.
    expect(accountBalance(conta, [compra])).toBe(500_000);
    // Depois do pagamento: R$ 2.000 saem da conta.
    expect(accountBalance(conta, base)).toBe(300_000);
  });

  it('o pagamento libera limite do cartão', () => {
    expect(cardUsage(cartao, [compra]).usedCents).toBe(20_000);
    expect(cardUsage(cartao, base).usedCents).toBe(20_000 - 200_000);
  });

  it('a compra entra na fatura correta', () => {
    expect(invoiceRefForDate(cartao, '2024-03-05')).toBe('2024-03');
    const fatura = buildInvoice(cartao, '2024-03', base, '2024-03-30');
    expect(fatura.items).toHaveLength(1);
    expect(fatura.totalCents).toBe(20_000);
    expect(fatura.paidCents).toBe(200_000);
  });
});

describe('cenário completo de um mês de cartão', () => {
  const conta = makeAccount({ id: 'acc', openingBalanceCents: 1_000_000, openingDate: '2024-02-01' });
  const cartao = makeCard({ id: 'card', closingDay: 20, dueDay: 28 });

  // Fevereiro: três compras que fecham na fatura de 20/02, vencendo 28/02.
  const compras = [
    buildTransaction({ kind: 'expense', date: '2024-02-02', description: 'Mercado', amountCents: 45_000, cardId: 'card', categoryId: 'cat-mercado' }),
    buildTransaction({ kind: 'expense', date: '2024-02-10', description: 'Restaurante', amountCents: 12_000, cardId: 'card', categoryId: 'cat-restaurante' }),
    buildTransaction({ kind: 'expense', date: '2024-02-18', description: 'Farmácia', amountCents: 8_000, cardId: 'card', categoryId: 'cat-farmacia' }),
  ];
  const totalCompras = 45_000 + 12_000 + 8_000; // R$ 650,00

  const pagamentoFatura = buildCardPayment({
    date: '2024-02-28',
    amountCents: totalCompras,
    accountId: 'acc',
    cardId: 'card',
    invoiceRef: '2024-02',
  });

  const base = [...compras, pagamentoFatura];

  it('a despesa do mês é exatamente a soma das compras', () => {
    const resumo = monthSummary('2024-02', base, categoryMap);
    expect(resumo.expenseCents).toBe(totalCompras);
  });

  it('o saldo da conta cai apenas uma vez, no pagamento', () => {
    expect(accountBalance(conta, base)).toBe(1_000_000 - totalCompras);
  });

  it('a fatura fica quitada e o limite volta ao total', () => {
    const fatura = buildInvoice(cartao, '2024-02', base, '2024-03-01');
    expect(fatura.totalCents).toBe(totalCompras);
    expect(fatura.openCents).toBe(0);
    expect(fatura.status).toBe('paid');
    expect(cardUsage(cartao, base).usedCents).toBe(0);
    expect(cardUsage(cartao, base).availableCents).toBe(cartao.limitCents);
  });

  it('somando os dois meses, nada é contado duas vezes', () => {
    const fevereiro = monthSummary('2024-02', base, categoryMap);
    const marco = monthSummary('2024-03', base, categoryMap);
    expect(fevereiro.expenseCents + marco.expenseCents).toBe(totalCompras);
  });
});
