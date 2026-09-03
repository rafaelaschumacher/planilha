/**
 * Regras estruturais do lançamento.
 *
 * Aqui mora a regra crítica do produto:
 *
 *   COMPRA NO CARTÃO  ≠  PAGAMENTO DA FATURA
 *
 * A compra é a despesa. O pagamento da fatura só move dinheiro da conta para
 * o cartão e liquida o saldo. Se o pagamento contasse como despesa, todo gasto
 * de cartão seria contado duas vezes.
 *
 * Essa regra não é "lembrada" pela interface: ela é imposta por
 * `pnlEffect()`, que é a ÚNICA fonte de receita e despesa em todo o sistema.
 */

import { assertCents, formatMoney, splitInstallments, type Cents } from './money';
import { addMonths, isISODate, type ISODate, type ISOMonth } from './dates';
import { hash, normalizeMerchant } from './text';
import type {
  CategorySource,
  ID,
  PaymentMethod,
  Transaction,
  TransactionKind,
  TransactionStatus,
} from './types';

// ---------------------------------------------------------------------------
// Identificadores
// ---------------------------------------------------------------------------

let fallbackCounter = 0;

export function newId(prefix = 'tx'): ID {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return `${prefix}_${g.crypto.randomUUID()}`;
  fallbackCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${fallbackCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Efeito no resultado do mês (receita / despesa)
// ---------------------------------------------------------------------------

export interface PnlEffect {
  /** Quanto este lançamento soma de RECEITA. */
  income: Cents;
  /** Quanto este lançamento soma de DESPESA (pode ser negativo em reembolso). */
  expense: Cents;
}

const NO_EFFECT: PnlEffect = { income: 0, expense: 0 };

/**
 * Efeito de um lançamento no resultado (receitas x despesas) do período.
 *
 * ATENÇÃO: `transfer`, `card_payment` e `adjustment` retornam ZERO.
 * É isso que impede a dupla contabilização.
 */
export function pnlEffect(tx: Pick<Transaction, 'kind' | 'amountCents'>): PnlEffect {
  switch (tx.kind) {
    case 'expense':
      return { income: 0, expense: tx.amountCents };
    case 'income':
      return { income: tx.amountCents, expense: 0 };
    case 'refund':
    case 'chargeback':
      // Devolução de dinheiro reduz a despesa da categoria original.
      // Não vira receita — senão receita e despesa ficariam inflados juntos.
      return { income: 0, expense: -tx.amountCents };
    case 'transfer':
      // Dinheiro trocando de bolso não é receita nem despesa.
      return NO_EFFECT;
    case 'card_payment':
      // A despesa já foi contada na COMPRA. Aqui só liquidamos a fatura.
      return NO_EFFECT;
    case 'adjustment':
      // Correção de saldo, não é fato econômico do período.
      return NO_EFFECT;
    default: {
      const never: never = tx.kind;
      throw new Error(`tipo de lançamento desconhecido: ${String(never)}`);
    }
  }
}

/** Quanto este lançamento altera o SALDO da conta `accountId`. */
export function accountDelta(tx: Transaction, accountId: ID): Cents {
  switch (tx.kind) {
    case 'expense':
      // Compra no cartão NÃO sai da conta. Sai quando a fatura é paga.
      return !tx.cardId && tx.accountId === accountId ? -tx.amountCents : 0;
    case 'income':
      return tx.accountId === accountId ? tx.amountCents : 0;
    case 'refund':
    case 'chargeback':
      return !tx.cardId && tx.accountId === accountId ? tx.amountCents : 0;
    case 'transfer':
      if (tx.accountId === accountId) return -tx.amountCents;
      if (tx.toAccountId === accountId) return tx.amountCents;
      return 0;
    case 'card_payment':
      return tx.accountId === accountId ? -tx.amountCents : 0;
    case 'adjustment':
      if (tx.accountId !== accountId) return 0;
      return tx.direction === 'out' ? -tx.amountCents : tx.amountCents;
    default:
      return 0;
  }
}

/** Quanto este lançamento altera o LIMITE UTILIZADO do cartão `cardId`. */
export function cardDelta(tx: Transaction, cardId: ID): Cents {
  if (tx.cardId !== cardId) return 0;
  switch (tx.kind) {
    case 'expense':
      return tx.amountCents; // consome limite
    case 'refund':
    case 'chargeback':
      return -tx.amountCents; // devolve limite
    case 'card_payment':
      return -tx.amountCents; // libera limite
    default:
      return 0;
  }
}

/** `true` quando o lançamento é uma despesa que ainda vai sair da conta via fatura. */
export function isCardExpense(tx: Transaction): boolean {
  return tx.kind === 'expense' && !!tx.cardId;
}

// ---------------------------------------------------------------------------
// Impressão digital (sinal de duplicidade)
// ---------------------------------------------------------------------------

/**
 * Chave determinística de um lançamento.
 *
 * NÃO é uma restrição de unicidade: dois cafés de R$ 10 no mesmo dia e no mesmo
 * lugar são dois lançamentos legítimos com a mesma impressão digital. Serve
 * apenas para o detector de duplicidade LEVANTAR A MÃO — nunca para apagar.
 */
export function computeFingerprint(tx: {
  kind: TransactionKind;
  date: ISODate;
  amountCents: Cents;
  description: string;
  accountId?: ID;
  cardId?: ID;
  installmentNumber?: number;
}): string {
  const source = tx.cardId ?? tx.accountId ?? '-';
  const parcel = tx.installmentNumber ? `#${tx.installmentNumber}` : '';
  return hash(
    [tx.kind, source, tx.date, tx.amountCents, normalizeMerchant(tx.description), parcel].join('|'),
  );
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

/** Retorna a lista de problemas do lançamento. Vazia = válido. */
export function validateTransaction(tx: Transaction): string[] {
  const errors: string[] = [];

  if (!tx.id) errors.push('lançamento sem identificador');
  if (!tx.description?.trim()) errors.push('descrição obrigatória');
  if (!isISODate(tx.date)) errors.push(`data inválida: ${tx.date}`);

  if (!Number.isSafeInteger(tx.amountCents)) {
    errors.push('valor precisa ser inteiro em centavos');
  } else if (tx.amountCents <= 0) {
    errors.push('valor precisa ser maior que zero (o sinal vem do tipo do lançamento)');
  }

  const hasAccount = !!tx.accountId;
  const hasCard = !!tx.cardId;
  const hasTo = !!tx.toAccountId;

  switch (tx.kind) {
    case 'expense':
    case 'refund':
    case 'chargeback':
      if (hasAccount === hasCard) {
        errors.push('informe exatamente uma origem: conta OU cartão');
      }
      if (hasTo) errors.push('conta de destino só existe em transferência');
      break;

    case 'income':
      if (!hasAccount) errors.push('receita precisa de uma conta de destino');
      if (hasCard) errors.push('receita não pode ser lançada em cartão de crédito');
      if (hasTo) errors.push('conta de destino só existe em transferência');
      break;

    case 'transfer':
      if (!hasAccount) errors.push('transferência precisa da conta de origem');
      if (!hasTo) errors.push('transferência precisa da conta de destino');
      if (hasAccount && hasTo && tx.accountId === tx.toAccountId) {
        errors.push('a conta de origem e a de destino precisam ser diferentes');
      }
      if (hasCard) errors.push('transferência não envolve cartão de crédito');
      break;

    case 'card_payment':
      if (!hasAccount) errors.push('pagamento de fatura precisa da conta que pagou');
      if (!hasCard) errors.push('pagamento de fatura precisa do cartão');
      if (hasTo) errors.push('conta de destino só existe em transferência');
      break;

    case 'adjustment':
      if (!hasAccount) errors.push('ajuste precisa de uma conta');
      if (hasCard) errors.push('ajuste não envolve cartão');
      if (tx.direction !== 'in' && tx.direction !== 'out') {
        errors.push('ajuste precisa indicar entrada ou saída');
      }
      break;

    default:
      errors.push(`tipo de lançamento desconhecido: ${String(tx.kind)}`);
  }

  if (tx.installmentGroupId || tx.installmentNumber || tx.installmentTotal) {
    const n = tx.installmentNumber;
    const total = tx.installmentTotal;
    if (!tx.installmentGroupId) errors.push('parcela sem grupo de parcelamento');
    if (!n || !total) {
      errors.push('parcela precisa de número e total');
    } else {
      if (!Number.isInteger(n) || !Number.isInteger(total)) errors.push('parcela precisa de números inteiros');
      else if (n < 1 || total < 1 || n > total) errors.push(`parcela ${n}/${total} é inconsistente`);
    }
    if (tx.kind !== 'expense' && tx.kind !== 'refund' && tx.kind !== 'chargeback') {
      errors.push('só despesas podem ser parceladas');
    }
  }

  if (tx.kind !== 'adjustment' && tx.direction) {
    errors.push('direção só se aplica a ajuste');
  }
  if (tx.invoiceRef && tx.kind !== 'card_payment') {
    errors.push('referência de fatura só se aplica a pagamento de fatura');
  }

  return errors;
}

export function assertValidTransaction(tx: Transaction): Transaction {
  const errors = validateTransaction(tx);
  if (errors.length) {
    throw new Error(`Lançamento inválido: ${errors.join('; ')}`);
  }
  return tx;
}

// ---------------------------------------------------------------------------
// Construtores
// ---------------------------------------------------------------------------

export interface TransactionDraft {
  kind: TransactionKind;
  date: ISODate;
  description: string;
  amountCents: Cents;
  categoryId?: ID;
  categorySource?: CategorySource;
  needsReview?: boolean;
  accountId?: ID;
  cardId?: ID;
  toAccountId?: ID;
  invoiceRef?: ISOMonth;
  direction?: 'in' | 'out';
  paymentMethod?: PaymentMethod;
  status?: TransactionStatus;
  isFixed?: boolean;
  installmentGroupId?: ID;
  installmentNumber?: number;
  installmentTotal?: number;
  purchaseTotalCents?: Cents;
  linkedTransactionId?: ID;
  recurringRuleId?: ID;
  importBatchId?: ID;
  externalId?: string;
  notes?: string;
  id?: ID;
  createdAt?: string;
  updatedAt?: string;
}

function inferPaymentMethod(draft: TransactionDraft): PaymentMethod {
  if (draft.paymentMethod) return draft.paymentMethod;
  if (draft.cardId && draft.kind !== 'card_payment') return 'credit';
  if (draft.kind === 'transfer') return 'transfer';
  if (draft.kind === 'card_payment') return 'debit';
  return 'debit';
}

/** Monta um lançamento completo e VALIDADO a partir de um rascunho. */
export function buildTransaction(draft: TransactionDraft): Transaction {
  const now = new Date().toISOString();
  const amountCents = assertCents(draft.amountCents, 'valor');

  const tx: Transaction = {
    id: draft.id ?? newId('tx'),
    kind: draft.kind,
    date: draft.date,
    description: draft.description.trim(),
    amountCents,
    categorySource: draft.categorySource ?? (draft.categoryId ? 'manual' : 'none'),
    needsReview: draft.needsReview ?? false,
    paymentMethod: inferPaymentMethod(draft),
    status: draft.status ?? 'cleared',
    isFixed: draft.isFixed ?? false,
    fingerprint: '',
    createdAt: draft.createdAt ?? now,
    updatedAt: draft.updatedAt ?? now,
  };

  // Campos opcionais só são gravados quando realmente existem — evita
  // `accountId: undefined` viajando até o IndexedDB e quebrando índices.
  if (draft.categoryId) tx.categoryId = draft.categoryId;
  if (draft.accountId) tx.accountId = draft.accountId;
  if (draft.cardId) tx.cardId = draft.cardId;
  if (draft.toAccountId) tx.toAccountId = draft.toAccountId;
  if (draft.invoiceRef) tx.invoiceRef = draft.invoiceRef;
  if (draft.direction) tx.direction = draft.direction;
  if (draft.installmentGroupId) tx.installmentGroupId = draft.installmentGroupId;
  if (draft.installmentNumber) tx.installmentNumber = draft.installmentNumber;
  if (draft.installmentTotal) tx.installmentTotal = draft.installmentTotal;
  if (draft.purchaseTotalCents !== undefined) tx.purchaseTotalCents = draft.purchaseTotalCents;
  if (draft.linkedTransactionId) tx.linkedTransactionId = draft.linkedTransactionId;
  if (draft.recurringRuleId) tx.recurringRuleId = draft.recurringRuleId;
  if (draft.importBatchId) tx.importBatchId = draft.importBatchId;
  if (draft.externalId) tx.externalId = draft.externalId;
  if (draft.notes) tx.notes = draft.notes;

  tx.fingerprint = computeFingerprint(tx);
  return assertValidTransaction(tx);
}

export interface InstallmentPurchaseInput {
  /** Data da PRIMEIRA parcela (normalmente a data da compra). */
  date: ISODate;
  description: string;
  /** Valor TOTAL da compra. */
  totalCents: Cents;
  installments: number;
  cardId?: ID;
  accountId?: ID;
  categoryId?: ID;
  categorySource?: CategorySource;
  needsReview?: boolean;
  isFixed?: boolean;
  paymentMethod?: PaymentMethod;
  notes?: string;
  importBatchId?: ID;
  groupId?: ID;
}

/**
 * Gera TODAS as parcelas de uma compra parcelada.
 *
 * A soma das parcelas é EXATAMENTE o valor total — o resto de centavos é
 * distribuído nas primeiras parcelas, como fazem as operadoras.
 * Cada parcela cai no mês seguinte, com o dia ajustado para meses curtos
 * (compra em 31/01 em 3x → 31/01, 28/02, 31/03).
 */
export function buildInstallmentPurchase(input: InstallmentPurchaseInput): Transaction[] {
  if (!Number.isInteger(input.installments) || input.installments < 1) {
    throw new Error(`número de parcelas inválido: ${input.installments}`);
  }
  // Não existe parcela de zero centavo. Sem esta guarda, R$ 0,01 em 2x geraria
  // uma parcela vazia e o lançamento seria recusado com uma mensagem obscura.
  if (Math.abs(input.totalCents) < input.installments) {
    throw new Error(
      `Não dá para dividir ${formatMoney(input.totalCents)} em ${input.installments} parcelas: cada parcela ficaria com menos de um centavo.`,
    );
  }
  const groupId = input.groupId ?? newId('parc');
  const parts = splitInstallments(input.totalCents, input.installments);

  return parts.map((amountCents, index) =>
    buildTransaction({
      kind: 'expense',
      date: addMonths(input.date, index),
      description: input.description,
      amountCents,
      categoryId: input.categoryId,
      categorySource: input.categorySource,
      needsReview: input.needsReview,
      accountId: input.accountId,
      cardId: input.cardId,
      paymentMethod: input.paymentMethod,
      isFixed: input.isFixed,
      installmentGroupId: groupId,
      installmentNumber: index + 1,
      installmentTotal: input.installments,
      purchaseTotalCents: input.totalCents,
      notes: input.notes,
      importBatchId: input.importBatchId,
    }),
  );
}

/** Transferência entre contas próprias: um único lançamento, duas pontas. */
export function buildTransfer(input: {
  date: ISODate;
  description?: string;
  amountCents: Cents;
  fromAccountId: ID;
  toAccountId: ID;
  notes?: string;
}): Transaction {
  return buildTransaction({
    kind: 'transfer',
    date: input.date,
    description: input.description?.trim() || 'Transferência entre contas',
    amountCents: input.amountCents,
    accountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    paymentMethod: 'transfer',
    notes: input.notes,
  });
}

/** Pagamento de fatura: sai da conta, liquida o cartão, NÃO é despesa. */
export function buildCardPayment(input: {
  date: ISODate;
  amountCents: Cents;
  accountId: ID;
  cardId: ID;
  invoiceRef?: ISOMonth;
  description?: string;
  paymentMethod?: PaymentMethod;
  notes?: string;
}): Transaction {
  return buildTransaction({
    kind: 'card_payment',
    date: input.date,
    description: input.description?.trim() || 'Pagamento de fatura',
    amountCents: input.amountCents,
    accountId: input.accountId,
    cardId: input.cardId,
    invoiceRef: input.invoiceRef,
    paymentMethod: input.paymentMethod ?? 'debit',
    notes: input.notes,
  });
}
