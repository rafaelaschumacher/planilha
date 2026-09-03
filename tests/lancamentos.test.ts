import { describe, expect, it } from 'vitest';
import {
  accountDelta,
  buildInstallmentPurchase,
  buildTransaction,
  buildTransfer,
  cardDelta,
  computeFingerprint,
  pnlEffect,
  validateTransaction,
} from '../src/domain/transaction';
import { sumCents } from '../src/domain/money';
import { accountBalance, monthSummary } from '../src/domain/engine';
import { categoryMap, makeAccount, makeCard } from './helpers';

describe('validação estrutural', () => {
  const base = {
    kind: 'expense' as const,
    date: '2024-03-10',
    description: 'Teste',
    amountCents: 5_000,
  };

  it('exige valor positivo — o sinal vem do tipo, nunca do valor', () => {
    expect(() => buildTransaction({ ...base, amountCents: -5_000, accountId: 'a' })).toThrow(/maior que zero/);
    expect(() => buildTransaction({ ...base, amountCents: 0, accountId: 'a' })).toThrow(/maior que zero/);
  });

  it('exige valor em centavos inteiros', () => {
    expect(() => buildTransaction({ ...base, amountCents: 50.5, accountId: 'a' })).toThrow(/inteiro/);
  });

  it('exige data que existe no calendário', () => {
    expect(() => buildTransaction({ ...base, date: '2024-02-30', accountId: 'a' })).toThrow(/data inválida/);
  });

  it('despesa precisa de conta OU cartão — nunca os dois, nunca nenhum', () => {
    expect(() => buildTransaction({ ...base })).toThrow(/conta OU cartão/);
    expect(() => buildTransaction({ ...base, accountId: 'a', cardId: 'c' })).toThrow(/conta OU cartão/);
    expect(() => buildTransaction({ ...base, accountId: 'a' })).not.toThrow();
    expect(() => buildTransaction({ ...base, cardId: 'c' })).not.toThrow();
  });

  it('receita não pode ser lançada em cartão de crédito', () => {
    expect(() =>
      buildTransaction({ ...base, kind: 'income', cardId: 'c' }),
    ).toThrow(/cartão de crédito/);
  });

  it('transferência exige duas contas diferentes', () => {
    expect(() => buildTransfer({ date: '2024-03-10', amountCents: 100, fromAccountId: 'a', toAccountId: 'a' })).toThrow(/diferentes/);
    expect(() => buildTransaction({ ...base, kind: 'transfer', accountId: 'a' })).toThrow(/destino/);
  });

  it('pagamento de fatura exige conta e cartão', () => {
    expect(() => buildTransaction({ ...base, kind: 'card_payment', accountId: 'a' })).toThrow(/cartão/);
    expect(() => buildTransaction({ ...base, kind: 'card_payment', cardId: 'c' })).toThrow(/conta/);
  });

  it('ajuste exige direção', () => {
    expect(() => buildTransaction({ ...base, kind: 'adjustment', accountId: 'a' })).toThrow(/entrada ou saída/);
    expect(() => buildTransaction({ ...base, kind: 'adjustment', accountId: 'a', direction: 'in' })).not.toThrow();
  });

  it('parcela incoerente é recusada', () => {
    const bad = buildTransaction({ ...base, accountId: 'a' });
    expect(validateTransaction({ ...bad, installmentGroupId: 'g', installmentNumber: 7, installmentTotal: 3 }))
      .toContain('parcela 7/3 é inconsistente');
  });
});

describe('efeito de cada tipo de lançamento', () => {
  const a = 'acc-a';
  const b = 'acc-b';

  it('receita entra na conta e conta como receita', () => {
    const t = buildTransaction({ kind: 'income', date: '2024-03-05', description: 'Salário', amountCents: 600_000, accountId: a, categoryId: 'cat-salario' });
    expect(pnlEffect(t)).toEqual({ income: 600_000, expense: 0 });
    expect(accountDelta(t, a)).toBe(600_000);
  });

  it('despesa no débito sai da conta na hora', () => {
    const t = buildTransaction({ kind: 'expense', date: '2024-03-05', description: 'Padaria', amountCents: 2_500, accountId: a, paymentMethod: 'debit' });
    expect(pnlEffect(t).expense).toBe(2_500);
    expect(accountDelta(t, a)).toBe(-2_500);
  });

  it('despesa no crédito NÃO sai da conta, mas consome limite', () => {
    const t = buildTransaction({ kind: 'expense', date: '2024-03-05', description: 'Loja', amountCents: 30_000, cardId: 'card' });
    expect(pnlEffect(t).expense).toBe(30_000);
    expect(accountDelta(t, a)).toBe(0);
    expect(cardDelta(t, 'card')).toBe(30_000);
  });

  it('transferência move o dinheiro sem virar receita nem despesa', () => {
    const t = buildTransfer({ date: '2024-03-05', amountCents: 100_000, fromAccountId: a, toAccountId: b });
    expect(pnlEffect(t)).toEqual({ income: 0, expense: 0 });
    expect(accountDelta(t, a)).toBe(-100_000);
    expect(accountDelta(t, b)).toBe(100_000);
    // A soma das duas pontas é zero: o patrimônio não muda.
    expect(accountDelta(t, a) + accountDelta(t, b)).toBe(0);
  });

  it('reembolso devolve dinheiro e REDUZ a despesa (não vira receita)', () => {
    const t = buildTransaction({ kind: 'refund', date: '2024-03-08', description: 'Rateio do jantar', amountCents: 6_000, accountId: a, categoryId: 'cat-restaurante' });
    expect(pnlEffect(t)).toEqual({ income: 0, expense: -6_000 });
    expect(accountDelta(t, a)).toBe(6_000);
  });

  it('estorno no cartão devolve limite e reduz a despesa', () => {
    const t = buildTransaction({ kind: 'chargeback', date: '2024-03-08', description: 'Compra cancelada', amountCents: 15_000, cardId: 'card' });
    expect(pnlEffect(t).expense).toBe(-15_000);
    expect(cardDelta(t, 'card')).toBe(-15_000);
    expect(accountDelta(t, a)).toBe(0);
  });

  it('ajuste corrige o saldo sem mexer no resultado do mês', () => {
    const up = buildTransaction({ kind: 'adjustment', date: '2024-03-08', description: 'Acerto', amountCents: 1_000, accountId: a, direction: 'in' });
    const down = buildTransaction({ kind: 'adjustment', date: '2024-03-08', description: 'Acerto', amountCents: 1_000, accountId: a, direction: 'out' });
    expect(pnlEffect(up)).toEqual({ income: 0, expense: 0 });
    expect(accountDelta(up, a)).toBe(1_000);
    expect(accountDelta(down, a)).toBe(-1_000);
  });
});

describe('reembolso no fluxo real', () => {
  it('jantar de R$ 200 com R$ 120 devolvidos custa R$ 80 no mês', () => {
    const jantar = buildTransaction({ kind: 'expense', date: '2024-03-10', description: 'Jantar', amountCents: 20_000, accountId: 'a', categoryId: 'cat-restaurante' });
    const rateio = buildTransaction({ kind: 'refund', date: '2024-03-11', description: 'Rateio jantar', amountCents: 12_000, accountId: 'a', categoryId: 'cat-restaurante', linkedTransactionId: jantar.id });
    const resumo = monthSummary('2024-03', [jantar, rateio], categoryMap);
    expect(resumo.expenseCents).toBe(8_000);
    expect(resumo.incomeCents).toBe(0); // não infla a receita
    const categoria = resumo.byCategory.find((c) => c.categoryId === 'cat-restaurante');
    expect(categoria?.amountCents).toBe(8_000);
  });
});

describe('compra parcelada', () => {
  const parcelas = buildInstallmentPurchase({
    date: '2024-03-15',
    description: 'Notebook',
    totalCents: 120_000, // R$ 1.200,00
    installments: 6,
    cardId: 'card',
    categoryId: 'cat-eletronicos',
  });

  it('gera uma parcela por mês, com valor por parcela correto', () => {
    expect(parcelas).toHaveLength(6);
    expect(parcelas.every((p) => p.amountCents === 20_000)).toBe(true);
    expect(parcelas.map((p) => p.date)).toEqual([
      '2024-03-15', '2024-04-15', '2024-05-15', '2024-06-15', '2024-07-15', '2024-08-15',
    ]);
  });

  it('a soma das parcelas é EXATAMENTE o valor da compra', () => {
    expect(sumCents(parcelas.map((p) => p.amountCents))).toBe(120_000);
    const quebrado = buildInstallmentPurchase({ date: '2024-03-15', description: 'Curso', totalCents: 100_000, installments: 3, cardId: 'card' });
    expect(sumCents(quebrado.map((p) => p.amountCents))).toBe(100_000);
    expect(quebrado.map((p) => p.amountCents)).toEqual([33_334, 33_333, 33_333]);
  });

  it('cada parcela vira despesa do SEU mês, não tudo no mês da compra', () => {
    expect(monthSummary('2024-03', parcelas, categoryMap).expenseCents).toBe(20_000);
    expect(monthSummary('2024-06', parcelas, categoryMap).expenseCents).toBe(20_000);
    expect(monthSummary('2024-09', parcelas, categoryMap).expenseCents).toBe(0);
  });

  it('numera as parcelas e guarda o total da compra', () => {
    expect(parcelas.map((p) => p.installmentNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parcelas.every((p) => p.installmentTotal === 6)).toBe(true);
    expect(parcelas.every((p) => p.purchaseTotalCents === 120_000)).toBe(true);
    expect(new Set(parcelas.map((p) => p.installmentGroupId)).size).toBe(1);
  });

  it('ajusta o dia em meses curtos', () => {
    const p = buildInstallmentPurchase({ date: '2024-01-31', description: 'Sofá', totalCents: 90_000, installments: 3, cardId: 'card' });
    expect(p.map((x) => x.date)).toEqual(['2024-01-31', '2024-02-29', '2024-03-31']);
  });

  it('compra em 1x continua sendo uma compra simples', () => {
    const p = buildInstallmentPurchase({ date: '2024-03-15', description: 'Livro', totalCents: 8_900, installments: 1, cardId: 'card' });
    expect(p).toHaveLength(1);
    expect(p[0]!.amountCents).toBe(8_900);
  });
});

describe('impressão digital', () => {
  it('é igual para o mesmo fato e diferente entre parcelas', () => {
    const a = computeFingerprint({ kind: 'expense', date: '2024-03-01', amountCents: 100, description: 'Café da Esquina', accountId: 'x' });
    const b = computeFingerprint({ kind: 'expense', date: '2024-03-01', amountCents: 100, description: 'CAFÉ DA ESQUINA', accountId: 'x' });
    const c = computeFingerprint({ kind: 'expense', date: '2024-03-01', amountCents: 100, description: 'Café da Esquina', accountId: 'x', installmentNumber: 2 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('saldo da conta', () => {
  const conta = makeAccount({ id: 'acc', openingBalanceCents: 100_000, openingDate: '2024-03-01' });
  const cartao = makeCard({ id: 'card' });

  it('ignora lançamentos anteriores à abertura (evita somar duas vezes)', () => {
    const antigo = buildTransaction({ kind: 'expense', date: '2024-02-20', description: 'Antigo', amountCents: 50_000, accountId: 'acc' });
    expect(accountBalance(conta, [antigo])).toBe(100_000);
  });

  it('respeita a data de corte', () => {
    const t1 = buildTransaction({ kind: 'expense', date: '2024-03-05', description: 'A', amountCents: 10_000, accountId: 'acc' });
    const t2 = buildTransaction({ kind: 'expense', date: '2024-03-25', description: 'B', amountCents: 20_000, accountId: 'acc' });
    expect(accountBalance(conta, [t1, t2], { asOf: '2024-03-10' })).toBe(90_000);
    expect(accountBalance(conta, [t1, t2])).toBe(70_000);
  });

  it('ignora previstos por padrão e inclui quando pedido', () => {
    const previsto = buildTransaction({ kind: 'expense', date: '2024-03-20', description: 'Boleto', amountCents: 30_000, accountId: 'acc', status: 'pending' });
    expect(accountBalance(conta, [previsto])).toBe(100_000);
    expect(accountBalance(conta, [previsto], { includePending: true })).toBe(70_000);
  });

  it('compras no cartão nunca mexem no saldo da conta', () => {
    const compra = buildTransaction({ kind: 'expense', date: '2024-03-05', description: 'Loja', amountCents: 40_000, cardId: cartao.id });
    expect(accountBalance(conta, [compra])).toBe(100_000);
  });
});
