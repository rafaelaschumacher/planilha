/**
 * Modelo de domínio.
 *
 * PRINCÍPIO CENTRAL: existe UMA ÚNICA base de lançamentos (`Transaction`).
 * Visão semanal, mensal, por cartão, por categoria e por conta são todas
 * DERIVADAS dessa base. Nada é duplicado, nada é recalculado à mão.
 */

import type { Cents } from './money';
import type { ISODate, ISOMonth } from './dates';

export type ID = string;

// ---------------------------------------------------------------------------
// Conta bancária
// ---------------------------------------------------------------------------

export type AccountType = 'checking' | 'savings' | 'cash' | 'investment';

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  checking: 'Conta corrente',
  savings: 'Poupança',
  cash: 'Dinheiro',
  investment: 'Investimento',
};

export interface Account {
  id: ID;
  name: string;
  institution: string;
  type: AccountType;
  /** Saldo que a conta tinha em `openingDate`. Tudo depois disso vem dos lançamentos. */
  openingBalanceCents: Cents;
  openingDate: ISODate;
  color: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Cartão de crédito
// ---------------------------------------------------------------------------

export interface Card {
  id: ID;
  name: string;
  institution: string;
  limitCents: Cents;
  /** Dia do fechamento da fatura (1-31). Compras a partir dele caem na fatura seguinte. */
  closingDay: number;
  /** Dia do vencimento da fatura (1-31). */
  dueDay: number;
  /** Conta usada por padrão para pagar a fatura. */
  defaultPaymentAccountId?: ID;
  color: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Categoria
// ---------------------------------------------------------------------------

export type CategoryKind = 'expense' | 'income';

export interface Category {
  id: ID;
  name: string;
  /** Preenchido quando esta categoria é uma subcategoria. */
  parentId?: ID;
  kind: CategoryKind;
  color: string;
  /** Marca o gasto como fixo por padrão (aluguel, assinatura, plano de saúde…). */
  isFixed: boolean;
  /** Categorias do sistema não podem ser excluídas (ex.: "Sem categoria"). */
  system?: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export const UNCATEGORIZED_ID = 'cat-sem-categoria';

// ---------------------------------------------------------------------------
// Lançamento — a base única
// ---------------------------------------------------------------------------

export type TransactionKind =
  /** Saída de dinheiro que consome orçamento. Pode sair da conta ou do cartão. */
  | 'expense'
  /** Entrada de dinheiro numa conta. */
  | 'income'
  /** Movimento entre contas próprias. NÃO é receita nem despesa. */
  | 'transfer'
  /** Pagamento de fatura de cartão. NÃO é despesa — a despesa já foi a compra. */
  | 'card_payment'
  /** Dinheiro de volta referente a uma despesa (rateio, devolução). Reduz a despesa. */
  | 'refund'
  /** Cancelamento de uma compra pela operadora. Reduz a despesa. */
  | 'chargeback'
  /** Correção manual de saldo de conta. Não entra em receita nem despesa. */
  | 'adjustment';

export const TRANSACTION_KIND_LABEL: Record<TransactionKind, string> = {
  expense: 'Despesa',
  income: 'Receita',
  transfer: 'Transferência',
  card_payment: 'Pagamento de fatura',
  refund: 'Reembolso',
  chargeback: 'Estorno',
  adjustment: 'Ajuste',
};

export type PaymentMethod =
  | 'debit'
  | 'credit'
  | 'pix'
  | 'cash'
  | 'boleto'
  | 'transfer'
  | 'other';

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  debit: 'Débito',
  credit: 'Crédito',
  pix: 'Pix',
  cash: 'Dinheiro',
  boleto: 'Boleto',
  transfer: 'Transferência',
  other: 'Outro',
};

/** `cleared` = o dinheiro se moveu de fato. `pending` = previsto, ainda não confirmado. */
export type TransactionStatus = 'cleared' | 'pending';

/** De onde veio a categoria — determina se a automação pode sobrescrever. */
export type CategorySource = 'manual' | 'rule' | 'inferred' | 'none';

export interface Transaction {
  id: ID;

  kind: TransactionKind;

  /**
   * Data de COMPETÊNCIA: quando o fato econômico aconteceu.
   * Numa compra de cartão é a data da compra (não a do pagamento da fatura),
   * e numa parcela é a data daquela parcela.
   */
  date: ISODate;

  description: string;

  /** SEMPRE POSITIVO. O sinal é decidido pelo `kind`, nunca pelo valor. */
  amountCents: Cents;

  categoryId?: ID;
  categorySource: CategorySource;
  /** Sinaliza "revisar categoria" quando a automação não teve confiança. */
  needsReview: boolean;

  /**
   * Conta envolvida.
   * expense/income/refund/chargeback/adjustment → a conta movimentada
   * transfer                                    → conta de ORIGEM
   * card_payment                                → conta que pagou a fatura
   */
  accountId?: ID;

  /**
   * Cartão envolvido.
   * expense/refund/chargeback → compra feita no cartão (não movimenta conta)
   * card_payment              → cartão cuja fatura está sendo paga
   */
  cardId?: ID;

  /** Conta de DESTINO. Exclusivo de `transfer`. */
  toAccountId?: ID;

  /** Fatura alvo de um `card_payment`, no formato YYYY-MM (mês de VENCIMENTO). */
  invoiceRef?: ISOMonth;

  /** Direção de um `adjustment`: entrada ou saída. */
  direction?: 'in' | 'out';

  paymentMethod: PaymentMethod;
  status: TransactionStatus;

  /** Gasto fixo (recorrente e previsível) x variável. */
  isFixed: boolean;

  // -- Parcelamento -------------------------------------------------------
  /** Une todas as parcelas de uma mesma compra. */
  installmentGroupId?: ID;
  /** 1-based. */
  installmentNumber?: number;
  installmentTotal?: number;
  /** Valor total da compra parcelada (soma exata de todas as parcelas). */
  purchaseTotalCents?: Cents;

  // -- Vínculos -----------------------------------------------------------
  /** Reembolso/estorno aponta para a despesa original. */
  linkedTransactionId?: ID;
  /** Regra recorrente que originou este lançamento. */
  recurringRuleId?: ID;

  // -- Origem / importação ------------------------------------------------
  importBatchId?: ID;
  /** Identificador do banco (FITID em OFX). Quando existe, é a melhor chave anti-duplicidade. */
  externalId?: string;
  /** Hash determinístico (conta/cartão + data + valor + descrição normalizada). */
  fingerprint: string;
  /** Marcado quando o sistema achou um lançamento muito parecido. Nunca apaga sozinho. */
  possibleDuplicateOf?: ID;

  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Orçamento
// ---------------------------------------------------------------------------

export interface Budget {
  id: ID;
  categoryId: ID;
  limitCents: Cents;
  /**
   * `null` = orçamento padrão, vale para todos os meses.
   * `"2024-03"` = valor específico daquele mês, que sobrescreve o padrão.
   */
  month: ISOMonth | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Regra de categorização automática
// ---------------------------------------------------------------------------

export type MatchType = 'contains' | 'startsWith' | 'regex';

export interface CategoryRule {
  id: ID;
  /** Texto ou expressão procurada na descrição (comparação sem acento e sem caixa). */
  pattern: string;
  matchType: MatchType;
  categoryId: ID;
  /** Aplica também "gasto fixo" quando a regra bate. */
  setIsFixed?: boolean;
  /** Menor número = avaliada primeiro. */
  priority: number;
  active: boolean;
  /** Quantas vezes a regra já classificou algo (para ordenar por utilidade). */
  hits: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Conta recorrente / despesa prevista
// ---------------------------------------------------------------------------

export interface RecurringRule {
  id: ID;
  description: string;
  amountCents: Cents;
  kind: 'expense' | 'income';
  categoryId?: ID;
  /** Dia do mês em que costuma acontecer (1-31, ajustado para meses curtos). */
  dayOfMonth: number;
  accountId?: ID;
  cardId?: ID;
  paymentMethod: PaymentMethod;
  isFixed: boolean;
  startMonth: ISOMonth;
  /** `null` = sem data de término. */
  endMonth: ISOMonth | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Importação
// ---------------------------------------------------------------------------

export type ImportFormat = 'csv' | 'ofx' | 'xlsx';

export interface ImportBatch {
  id: ID;
  fileName: string;
  format: ImportFormat;
  importedAt: string;
  /** Destino escolhido no assistente. */
  accountId?: ID;
  cardId?: ID;
  rowsRead: number;
  rowsImported: number;
  rowsSkipped: number;
}

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------

export type ThemePreference = 'system' | 'light' | 'dark';

export interface Settings {
  id: 'singleton';
  /** 0 = domingo, 1 = segunda. */
  firstDayOfWeek: 0 | 1;
  theme: ThemePreference;
  /** Avisa quando o saldo somado das contas fica abaixo disso. */
  lowBalanceThresholdCents: Cents;
  /** Percentual do orçamento a partir do qual aparece o alerta (0..1). */
  budgetWarnRatio: number;
  /** Quantos meses à frente a projeção de compromissos considera. */
  commitmentHorizonMonths: number;
  /** Esconde valores na tela (modo privacidade). */
  hideAmounts: boolean;
  updatedAt: string;
}

export const DEFAULT_SETTINGS: Settings = {
  id: 'singleton',
  firstDayOfWeek: 0,
  theme: 'system',
  lowBalanceThresholdCents: 50_000, // R$ 500,00
  budgetWarnRatio: 0.8,
  commitmentHorizonMonths: 12,
  hideAmounts: false,
  updatedAt: new Date(0).toISOString(),
};

// ---------------------------------------------------------------------------
// Conjunto completo de dados (usado por relatórios, backup e testes)
// ---------------------------------------------------------------------------

export interface FinanceDataset {
  accounts: Account[];
  cards: Card[];
  categories: Category[];
  transactions: Transaction[];
  budgets: Budget[];
  rules: CategoryRule[];
  recurring: RecurringRule[];
  imports: ImportBatch[];
  settings: Settings;
}

export function emptyDataset(): FinanceDataset {
  return {
    accounts: [],
    cards: [],
    categories: [],
    transactions: [],
    budgets: [],
    rules: [],
    recurring: [],
    imports: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}
