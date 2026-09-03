/**
 * Dados fictícios para demonstração.
 *
 * NENHUM dado real aparece no repositório. Este gerador cria seis meses de
 * movimentação plausível para você conhecer a plataforma antes de colocar
 * seus números — e para os testes rodarem sobre um cenário completo.
 *
 * Usa um gerador pseudoaleatório com semente fixa: o mesmo cenário toda vez,
 * o que torna qualquer diferença de resultado um sinal de bug de verdade.
 */

import { toCents } from '../domain/money';
import {
  addMonthsToMonth,
  currentMonth,
  dayInMonth,
  monthRange,
  today as todayOf,
  type ISODate,
  type ISOMonth,
} from '../domain/dates';
import {
  buildCardPayment,
  buildInstallmentPurchase,
  buildTransaction,
  buildTransfer,
} from '../domain/transaction';
import { buildInvoice, invoiceRefForDate } from '../domain/invoice';
import { defaultCategories, defaultRules } from '../domain/seed';
import { DEFAULT_SETTINGS, type Account, type Budget, type Card, type FinanceDataset, type RecurringRule, type Transaction } from '../domain/types';

/** Gerador determinístico (mulberry32) — mesmo cenário a cada execução. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const stamp = '2024-01-01T00:00:00.000Z';

const MERCADOS = ['MERCADO BOM PRECO', 'SUPERMERCADO ESTRELA', 'HORTIFRUTI DA ESQUINA'];
const RESTAURANTES = ['RESTAURANTE DO CENTRO', 'PIZZARIA NAPOLI', 'BURGER DA PRACA'];
const DELIVERY = ['IFOOD *IFD BRASIL', 'RAPPI *PEDIDO'];
const TRANSPORTE = ['UBER *TRIP', '99APP *VIAGEM'];
const FARMACIA = ['DROGARIA SAO PAULO', 'FARMACIA POPULAR'];
const PADARIA = ['PADARIA PAO QUENTE', 'CAFETERIA GRAO FINO'];
const LAZER = ['CINEMARK SHOPPING', 'BAR DO ZE', 'LIVRARIA CULTURA'];

export interface DemoOptions {
  /** Mês final do cenário. Padrão: o mês atual. */
  endMonth?: ISOMonth;
  /** Quantos meses gerar. Padrão: 6. */
  months?: number;
  today?: ISODate;
  seed?: number;
}

export function buildDemoDataset(options: DemoOptions = {}): FinanceDataset {
  const today = options.today ?? todayOf();
  const endMonth = options.endMonth ?? currentMonth();
  const monthsBack = (options.months ?? 6) - 1;
  const months = monthRange(addMonthsToMonth(endMonth, -monthsBack), endMonth);
  const random = makeRandom(options.seed ?? 20240315);

  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const between = (min: number, max: number) => toCents(min + random() * (max - min));

  const contaCorrente: Account = {
    id: 'demo-conta-corrente',
    name: 'Conta corrente',
    institution: 'Banco Fictício',
    type: 'checking',
    openingBalanceCents: toCents(3_200),
    openingDate: `${months[0]}-01`,
    color: '#6366f1',
    archived: false,
    createdAt: stamp,
    updatedAt: stamp,
  };

  const reserva: Account = {
    id: 'demo-reserva',
    name: 'Reserva de emergência',
    institution: 'Banco Fictício',
    type: 'savings',
    openingBalanceCents: toCents(8_000),
    openingDate: `${months[0]}-01`,
    color: '#10b981',
    archived: false,
    createdAt: stamp,
    updatedAt: stamp,
  };

  const cartao: Card = {
    id: 'demo-cartao',
    name: 'Cartão principal',
    institution: 'Banco Fictício',
    limitCents: toCents(12_000),
    closingDay: 20,
    dueDay: 28,
    defaultPaymentAccountId: contaCorrente.id,
    color: '#0ea5e9',
    archived: false,
    createdAt: stamp,
    updatedAt: stamp,
  };

  const transactions: Transaction[] = [];
  const add = (tx: Transaction | Transaction[]) => {
    if (Array.isArray(tx)) transactions.push(...tx);
    else transactions.push(tx);
  };

  for (const month of months) {
    const isCurrent = month === endMonth;

    // --- Receitas --------------------------------------------------------
    add(buildTransaction({
      kind: 'income', date: dayInMonth(month, 5), description: 'Pagamento salário',
      amountCents: toCents(7_400), accountId: contaCorrente.id, categoryId: 'cat-salario',
      categorySource: 'rule', isFixed: true, paymentMethod: 'transfer',
    }));

    if (random() > 0.5) {
      add(buildTransaction({
        kind: 'income', date: dayInMonth(month, 18), description: 'Projeto freelance',
        amountCents: between(600, 2_200), accountId: contaCorrente.id, categoryId: 'cat-extra',
        categorySource: 'manual', paymentMethod: 'pix',
      }));
    }

    // --- Contas fixas ----------------------------------------------------
    const fixas: [string, number, string, number][] = [
      ['Aluguel', 2_100, 'cat-aluguel', 10],
      ['Condomínio', 620, 'cat-condominio', 10],
      ['Energia elétrica CEMIG', 180, 'cat-energia', 15],
      ['Internet fibra VIVO', 119.9, 'cat-internet', 12],
      ['Plano de saúde UNIMED', 480, 'cat-plano-saude', 8],
    ];
    for (const [description, value, categoryId, day] of fixas) {
      add(buildTransaction({
        kind: 'expense', date: dayInMonth(month, day), description,
        amountCents: toCents(value * (0.97 + random() * 0.06)),
        accountId: contaCorrente.id, categoryId, categorySource: 'rule',
        isFixed: true, paymentMethod: 'debit',
      }));
    }

    // --- Assinaturas no cartão -------------------------------------------
    add(buildTransaction({
      kind: 'expense', date: dayInMonth(month, 15), description: 'NETFLIX.COM',
      amountCents: toCents(55.9), cardId: cartao.id, categoryId: 'cat-streaming',
      categorySource: 'rule', isFixed: true,
    }));
    add(buildTransaction({
      kind: 'expense', date: dayInMonth(month, 3), description: 'SPOTIFY BR',
      amountCents: toCents(21.9), cardId: cartao.id, categoryId: 'cat-streaming',
      categorySource: 'rule', isFixed: true,
    }));
    add(buildTransaction({
      kind: 'expense', date: dayInMonth(month, 7), description: 'SMARTFIT ACADEMIA',
      amountCents: toCents(109.9), cardId: cartao.id, categoryId: 'cat-academia',
      categorySource: 'rule', isFixed: true,
    }));

    // --- Gastos variáveis ------------------------------------------------
    const variaveis: [readonly string[], string, number, number, number][] = [
      [MERCADOS, 'cat-mercado', 4, 120, 480],
      [RESTAURANTES, 'cat-restaurante', 3, 45, 180],
      [DELIVERY, 'cat-delivery', 4, 32, 110],
      [TRANSPORTE, 'cat-app-transporte', 6, 12, 48],
      [PADARIA, 'cat-padaria', 5, 8, 35],
      [FARMACIA, 'cat-farmacia', 2, 25, 160],
      [LAZER, 'cat-cultura', 2, 40, 220],
    ];

    for (const [names, categoryId, count, min, max] of variaveis) {
      const howMany = Math.max(1, Math.round(count * (0.6 + random() * 0.8)));
      for (let i = 0; i < howMany; i++) {
        const day = 1 + Math.floor(random() * 27);
        const date = dayInMonth(month, day);
        // No mês corrente, não inventa gasto em dia que ainda não chegou.
        if (isCurrent && date > today) continue;
        const noCartao = random() > 0.35;
        add(buildTransaction({
          kind: 'expense', date, description: pick(names), amountCents: between(min, max),
          categoryId, categorySource: 'rule',
          ...(noCartao ? { cardId: cartao.id } : { accountId: contaCorrente.id, paymentMethod: 'pix' as const }),
        }));
      }
    }

    // --- Reserva ---------------------------------------------------------
    add(buildTransfer({
      date: dayInMonth(month, 6), amountCents: toCents(800),
      fromAccountId: contaCorrente.id, toAccountId: reserva.id,
      description: 'Aporte na reserva',
    }));
  }

  // --- Uma compra parcelada, para ver o comprometimento futuro ------------
  add(buildInstallmentPurchase({
    date: dayInMonth(addMonthsToMonth(endMonth, -2), 12),
    description: 'NOTEBOOK LOJA ELETRO',
    totalCents: toCents(4_800),
    installments: 8,
    cardId: cartao.id,
    categoryId: 'cat-eletronicos',
    categorySource: 'manual',
  }));

  // --- Um lançamento sem categoria, para exercitar a revisão --------------
  add(buildTransaction({
    kind: 'expense', date: dayInMonth(endMonth, Math.min(9, Number(today.slice(8, 10)))),
    description: 'PAGSEGURO *XPTO4471', amountCents: toCents(87.4),
    accountId: contaCorrente.id, needsReview: true, categorySource: 'none', paymentMethod: 'pix',
  }));

  // --- Um reembolso ------------------------------------------------------
  const jantar = buildTransaction({
    kind: 'expense', date: dayInMonth(addMonthsToMonth(endMonth, -1), 14),
    description: 'RESTAURANTE DO CENTRO', amountCents: toCents(268),
    cardId: cartao.id, categoryId: 'cat-restaurante', categorySource: 'rule',
  });
  add(jantar);
  add(buildTransaction({
    kind: 'refund', date: dayInMonth(addMonthsToMonth(endMonth, -1), 15),
    description: 'Rateio do jantar', amountCents: toCents(134),
    accountId: contaCorrente.id, categoryId: 'cat-restaurante', categorySource: 'manual',
    linkedTransactionId: jantar.id, paymentMethod: 'pix',
  }));

  // --- Pagamento das faturas já fechadas ---------------------------------
  // Calculado a partir das compras: é o mesmo caminho que a plataforma usa,
  // então o cenário nasce consistente.
  const faturaAtual = invoiceRefForDate(cartao, today);
  for (const month of months) {
    const ref = month;
    if (ref >= faturaAtual) continue;
    const invoice = buildInvoice(cartao, ref, transactions, today);
    if (invoice.totalCents <= 0) continue;
    add(buildCardPayment({
      date: invoice.dueDate,
      amountCents: invoice.totalCents,
      accountId: contaCorrente.id,
      cardId: cartao.id,
      invoiceRef: ref,
      description: `Pagamento fatura ${cartao.name}`,
    }));
  }

  // --- Orçamentos --------------------------------------------------------
  const budgets: Budget[] = [
    ['cat-alimentacao', 1_800], ['cat-transporte', 500], ['cat-lazer', 400],
    ['cat-compras', 600], ['cat-saude', 700],
  ].map(([categoryId, limit]) => ({
    id: `demo-budget-${categoryId}`,
    categoryId: categoryId as string,
    limitCents: toCents(limit as number),
    month: null,
    createdAt: stamp,
    updatedAt: stamp,
  }));

  // --- Contas fixas cadastradas -----------------------------------------
  const recurring: RecurringRule[] = [
    ['Aluguel', 2_100, 'cat-aluguel', 10],
    ['Condomínio', 620, 'cat-condominio', 10],
    ['Plano de saúde UNIMED', 480, 'cat-plano-saude', 8],
    ['Internet fibra VIVO', 119.9, 'cat-internet', 12],
  ].map(([description, value, categoryId, day], index) => ({
    id: `demo-recurring-${index}`,
    description: description as string,
    amountCents: toCents(value as number),
    kind: 'expense' as const,
    categoryId: categoryId as string,
    dayOfMonth: day as number,
    accountId: contaCorrente.id,
    paymentMethod: 'debit' as const,
    isFixed: true,
    startMonth: months[0]!,
    endMonth: null,
    active: true,
    createdAt: stamp,
    updatedAt: stamp,
  }));

  return {
    accounts: [contaCorrente, reserva],
    cards: [cartao],
    categories: defaultCategories(),
    transactions,
    budgets,
    rules: defaultRules(),
    recurring,
    imports: [],
    settings: { ...DEFAULT_SETTINGS, updatedAt: stamp },
  };
}
