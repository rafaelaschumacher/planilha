/**
 * Assistente de importação.
 *
 *   ARQUIVO → LÊ → NORMALIZA → IDENTIFICA → CATEGORIZA → PROCURA DUPLICIDADES
 *   → MOSTRA PRÉVIA → VOCÊ CONFIRMA → IMPORTA
 *
 * REGRA: nada entra na base sem a sua confirmação. Linhas com forte suspeita
 * de duplicidade já vêm DESMARCADAS, mas continuam visíveis — a decisão é sua.
 */

import { sumCents, type Cents } from '../domain/money';
import { compareDate, type ISODate } from '../domain/dates';
import { normalize } from '../domain/text';
import { suggestCategory } from '../domain/categorize';
import {
  DUPLICATE_STRONG_THRESHOLD,
  DUPLICATE_THRESHOLD,
  findDuplicates,
  type DuplicateMatch,
} from '../domain/duplicates';
import { buildTransaction, type TransactionDraft } from '../domain/transaction';
import { invoiceRefForPaymentDate } from '../domain/invoice';
import type {
  Card,
  CategoryRule,
  ID,
  ImportFormat,
  Transaction,
  TransactionKind,
} from '../domain/types';
import type { ParsedRow, ParseIssue, ParseResult } from './types';

/** Onde as linhas do arquivo vão ser gravadas. */
export type ImportTarget =
  | { type: 'account'; accountId: ID }
  | { type: 'card'; cardId: ID; card: Card };

export interface ImportContext {
  target: ImportTarget;
  existing: readonly Transaction[];
  rules: readonly CategoryRule[];
  /** Conta usada quando uma linha for reconhecida como pagamento de fatura. */
  paymentAccountId?: ID;
  /** Cartão usado quando uma linha do extrato parecer pagamento de fatura. */
  paymentCardId?: ID;
  /**
   * O cartão em si, para descobrir em qual fatura o pagamento cai.
   * Sem ele o pagamento fica sem referência — e a alocação por ordem de
   * vencimento resolve, que é o comportamento correto de reserva.
   */
  paymentCard?: Card;
}

export interface PreviewRow {
  key: string;
  parsed: ParsedRow;
  kind: TransactionKind;
  /** Valor absoluto em centavos — o sinal já virou `kind`. */
  amountCents: Cents;
  date: ISODate;
  description: string;
  categoryId?: ID;
  categorySource: 'manual' | 'rule' | 'inferred' | 'none';
  needsReview: boolean;
  isFixed: boolean;
  duplicates: DuplicateMatch[];
  duplicateScore: number;
  /** Marcada = será importada. */
  selected: boolean;
  warnings: string[];
  invoiceRef?: string;
}

export interface ImportPreview {
  format: ImportFormat;
  rows: PreviewRow[];
  issues: ParseIssue[];
  headers?: string[];
  detectedAccount?: string;
  summary: {
    total: number;
    selected: number;
    duplicates: number;
    needsReview: number;
    incomeCents: Cents;
    expenseCents: Cents;
    firstDate?: ISODate;
    lastDate?: ISODate;
  };
  /** Fração das linhas que já existem na base (0..1). */
  overlapRatio: number;
  /** Aviso de arquivo inteiro já importado. */
  batchWarning?: string;
}

// Padrões que identificam linhas especiais dentro do arquivo.
const INVOICE_PAYMENT_RE =
  /pagamento\s+(de\s+)?fatura|pag(to)?\.?\s+fatura|fatura\s+cart|pagamento\s+recebido|pgto\s+debito\s+autom|pagto\s+cartao/;
const TRANSFER_RE = /\btransfer|\bted\b|\bdoc\b|entre\s+contas|transferencia/;
const CARD_CREDIT_RE = /estorno|devolucao|credito\s+de\s+ajuste|cashback|reembolso/;

/**
 * Decide o tipo de cada linha.
 *
 * O cuidado principal está nas linhas de PAGAMENTO DE FATURA, que aparecem
 * tanto no extrato da conta quanto na fatura do cartão. Importar as duas
 * contaria o mesmo dinheiro duas vezes.
 */
function classifyRow(row: ParsedRow, context: ImportContext): {
  kind: TransactionKind;
  warnings: string[];
  selected: boolean;
  cardIdOverride?: ID;
} {
  const text = normalize(row.description);
  const warnings: string[] = [];
  const isOutflow = row.amountCents < 0;

  if (context.target.type === 'card') {
    // --- Fatura de cartão ------------------------------------------------
    if (INVOICE_PAYMENT_RE.test(text)) {
      return {
        kind: 'card_payment',
        warnings: [
          'Linha de pagamento da fatura. Ela normalmente já vem no extrato da conta — importar aqui contaria o pagamento duas vezes.',
        ],
        selected: false, // desmarcada por padrão: o risco de duplicar é real
      };
    }
    if (CARD_CREDIT_RE.test(text) || row.amountCents < 0) {
      return { kind: 'chargeback', warnings: [], selected: true };
    }
    return { kind: 'expense', warnings: [], selected: true };
  }

  // --- Extrato de conta --------------------------------------------------
  if (isOutflow && INVOICE_PAYMENT_RE.test(text)) {
    if (context.paymentCardId) {
      return { kind: 'card_payment', warnings: [], selected: true, cardIdOverride: context.paymentCardId };
    }
    warnings.push(
      'Parece pagamento de fatura. Escolha o cartão para não contar o gasto duas vezes — como despesa, ele duplicaria as compras do cartão.',
    );
    return { kind: 'expense', warnings, selected: true };
  }

  if (TRANSFER_RE.test(text)) {
    warnings.push('Pode ser transferência entre suas contas. Se for, reclassifique para não afetar receitas e despesas.');
  }

  return { kind: isOutflow ? 'expense' : 'income', warnings, selected: true };
}

export function buildImportPreview(parsed: ParseResult, context: ImportContext): ImportPreview {
  const rows: PreviewRow[] = [];
  // O histórico de aprendizado cresce com as próprias linhas do arquivo:
  // classificar a primeira "IFOOD" ajuda as seguintes.
  const history: Transaction[] = [...context.existing];

  for (const parsedRow of parsed.rows) {
    const { kind, warnings, selected, cardIdOverride } = classifyRow(parsedRow, context);
    const amountCents = Math.abs(parsedRow.amountCents);

    const accountId = context.target.type === 'account' ? context.target.accountId : undefined;
    const cardId = cardIdOverride ?? (context.target.type === 'card' ? context.target.cardId : undefined);

    const suggestion =
      kind === 'expense' || kind === 'income'
        ? suggestCategory({ description: parsedRow.description, rules: context.rules, history })
        : { categoryId: undefined, source: 'none' as const, confidence: 1, needsReview: false, isFixed: undefined };

    const duplicateSource: Parameters<typeof findDuplicates>[0] = {
      kind,
      date: parsedRow.date,
      description: parsedRow.description,
      amountCents,
    };
    if (accountId && kind !== 'card_payment') duplicateSource.accountId = accountId;
    if (cardId) duplicateSource.cardId = cardId;
    if (parsedRow.externalId) duplicateSource.externalId = parsedRow.externalId;
    if (parsedRow.installmentNumber) duplicateSource.installmentNumber = parsedRow.installmentNumber;

    const duplicates = findDuplicates(duplicateSource, context.existing, DUPLICATE_THRESHOLD);
    const duplicateScore = duplicates[0]?.score ?? 0;

    const rowWarnings = [...warnings];
    if (duplicateScore >= DUPLICATE_STRONG_THRESHOLD) {
      rowWarnings.push('Possível duplicidade: já existe um lançamento praticamente idêntico.');
    } else if (duplicateScore >= DUPLICATE_THRESHOLD) {
      rowWarnings.push('Possível duplicidade — confira antes de importar.');
    }

    const row: PreviewRow = {
      key: `${parsedRow.sourceLine}-${parsedRow.date}-${amountCents}`,
      parsed: parsedRow,
      kind,
      amountCents,
      date: parsedRow.date,
      description: parsedRow.description,
      categorySource: suggestion.source,
      needsReview: suggestion.needsReview,
      isFixed: suggestion.isFixed ?? false,
      duplicates,
      duplicateScore,
      selected: selected && duplicateScore < DUPLICATE_STRONG_THRESHOLD,
      warnings: rowWarnings,
    };
    if (suggestion.categoryId) row.categoryId = suggestion.categoryId;
    if (kind === 'card_payment' && cardId && context.target.type === 'account' && context.paymentCard) {
      row.invoiceRef = invoiceRefForPaymentDate(context.paymentCard, parsedRow.date);
    }

    rows.push(row);

    // Alimenta o histórico para as próximas linhas do mesmo arquivo.
    if (row.categoryId && (row.categorySource === 'rule' || row.categorySource === 'manual')) {
      history.push({
        id: `preview-${row.key}`,
        kind,
        date: row.date,
        description: row.description,
        amountCents,
        categoryId: row.categoryId,
        categorySource: row.categorySource,
        needsReview: false,
        paymentMethod: 'other',
        status: 'cleared',
        isFixed: row.isFixed,
        fingerprint: '',
        createdAt: '',
        updatedAt: '',
      });
    }
  }

  const dates = rows.map((r) => r.date).sort(compareDate);
  const duplicateCount = rows.filter((r) => r.duplicateScore >= DUPLICATE_THRESHOLD).length;
  const overlapRatio = rows.length > 0 ? duplicateCount / rows.length : 0;

  const preview: ImportPreview = {
    format: parsed.format,
    rows,
    issues: parsed.issues,
    summary: {
      total: rows.length,
      selected: rows.filter((r) => r.selected).length,
      duplicates: duplicateCount,
      needsReview: rows.filter((r) => r.needsReview).length,
      incomeCents: sumCents(rows.filter((r) => r.kind === 'income').map((r) => r.amountCents)),
      expenseCents: sumCents(rows.filter((r) => r.kind === 'expense').map((r) => r.amountCents)),
    },
    overlapRatio,
  };

  if (parsed.headers) preview.headers = parsed.headers;
  if (parsed.detectedAccount) preview.detectedAccount = parsed.detectedAccount;
  if (dates.length) {
    preview.summary.firstDate = dates[0]!;
    preview.summary.lastDate = dates[dates.length - 1]!;
  }

  // Detecção em lote: mais confiável que a comparação linha a linha para
  // pegar "importei esse mesmo arquivo de novo".
  if (rows.length >= 4 && overlapRatio >= 0.6) {
    preview.batchWarning = `${Math.round(overlapRatio * 100)}% das linhas já existem na base. Este arquivo provavelmente já foi importado.`;
  }

  return preview;
}

/** Converte as linhas marcadas em lançamentos prontos para gravar. */
export function materializePreview(
  preview: ImportPreview,
  context: ImportContext,
  importBatchId: ID,
): Transaction[] {
  const accountId = context.target.type === 'account' ? context.target.accountId : undefined;
  const cardId = context.target.type === 'card' ? context.target.cardId : undefined;

  return preview.rows
    .filter((row) => row.selected)
    .map((row) => {
      const draft: TransactionDraft = {
        kind: row.kind,
        date: row.date,
        description: row.description,
        amountCents: row.amountCents,
        categorySource: row.categorySource,
        needsReview: row.needsReview,
        isFixed: row.isFixed,
        importBatchId,
        status: 'cleared',
      };

      if (row.categoryId) draft.categoryId = row.categoryId;
      if (row.parsed.externalId) draft.externalId = row.parsed.externalId;
      if (row.parsed.installmentNumber && row.parsed.installmentTotal) {
        draft.installmentNumber = row.parsed.installmentNumber;
        draft.installmentTotal = row.parsed.installmentTotal;
        // Cada fatura traz apenas a parcela do mês; o grupo une as que forem
        // importadas ao longo do tempo. A chave inclui o VALOR da parcela para
        // que duas compras diferentes na mesma loja, com o mesmo número de
        // parcelas, não sejam fundidas numa só.
        draft.installmentGroupId = `imp_${normalize(row.description).replace(/\s+/g, '-')}_${row.parsed.installmentTotal}_${row.amountCents}`;
      }

      if (row.kind === 'card_payment') {
        draft.accountId = accountId ?? context.paymentAccountId;
        draft.cardId = cardId ?? context.paymentCardId;
        if (row.invoiceRef) draft.invoiceRef = row.invoiceRef;
        draft.paymentMethod = 'debit';
      } else if (cardId) {
        draft.cardId = cardId;
        draft.paymentMethod = 'credit';
      } else {
        draft.accountId = accountId;
        draft.paymentMethod = row.kind === 'income' ? 'transfer' : 'debit';
      }

      return buildTransaction(draft);
    });
}
