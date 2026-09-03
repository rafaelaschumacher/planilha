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
import { addMonths, compareDate, diffDays, type ISODate } from '../domain/dates';
import { normalize, normalizeMerchant } from '../domain/text';
import { suggestCategory } from '../domain/categorize';
import {
  DUPLICATE_STRONG_THRESHOLD,
  DUPLICATE_THRESHOLD,
  findDuplicates,
  type DuplicateCandidate,
  type DuplicateMatch,
} from '../domain/duplicates';
import { buildTransaction, newId, type TransactionDraft } from '../domain/transaction';
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
  /** Cartão sugerido quando uma linha do extrato parecer pagamento de fatura. */
  paymentCardId?: ID;
  /**
   * Todos os cartões cadastrados. Necessário porque você pode escolher, numa
   * linha específica, um cartão diferente do sugerido — e cada cartão tem seu
   * próprio ciclo de fechamento, que decide em qual fatura o pagamento cai.
   */
  cards?: readonly Card[];
}

export interface PreviewRow {
  key: string;
  parsed: ParsedRow;
  /**
   * Tipo da movimentação. Começa no que o sistema reconheceu e pode ser
   * TROCADO por você na prévia — é assim que uma transferência entre suas
   * contas para de ser lida como despesa.
   */
  kind: TransactionKind;
  /** Tipos que fazem sentido para esta linha, dado o destino da importação. */
  availableKinds: TransactionKind[];
  /** Valor absoluto em centavos — o sinal já virou `kind`. */
  amountCents: Cents;
  date: ISODate;
  description: string;
  categoryId?: ID;
  categorySource: 'manual' | 'rule' | 'inferred' | 'none';
  needsReview: boolean;
  isFixed: boolean;
  /** A outra conta, quando o tipo é transferência. */
  counterAccountId?: ID;
  /** O cartão, quando o tipo é pagamento de fatura. */
  paymentCardId?: ID;
  duplicates: DuplicateMatch[];
  duplicateScore: number;
  /** Marcada = será importada. */
  selected: boolean;
  /** Avisos de classificação, com código: saem de cena quando você age. */
  hints: Hint[];
  /** Texto final dos avisos, recalculado a cada edição sua. */
  warnings: string[];
  invoiceRef?: string;
  /**
   * Preenchido quando falta uma informação para gravar (a conta de destino de
   * uma transferência, por exemplo). Enquanto existir, a linha não é importada.
   */
  blocked?: string;
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
    /** Linhas que precisam de uma escolha sua antes de poderem ser importadas. */
    blocked: number;
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

/** Tipos oferecidos na prévia, conforme o destino da importação. */
const ACCOUNT_KINDS: TransactionKind[] = [
  'expense', 'income', 'transfer', 'card_payment', 'refund', 'chargeback',
];
const CARD_KINDS: TransactionKind[] = ['expense', 'chargeback', 'refund', 'card_payment'];

/**
 * Aviso de classificação, com código.
 *
 * O código existe para o aviso DESAPARECER quando você já agiu sobre ele:
 * um "parece transferência" que continua na tela depois de você trocar o tipo
 * ensina a ignorar avisos.
 */
export type HintCode = 'maybe-transfer' | 'needs-card' | 'payment-on-invoice';

export interface Hint {
  code: HintCode;
  text: string;
}

export interface Classification {
  kind: TransactionKind;
  hints: Hint[];
  selected: boolean;
  paymentCardId?: ID;
}

/**
 * Decide o tipo de cada linha.
 *
 * É um PALPITE, não um veredito: a prévia deixa você trocar o tipo. O que o
 * código faz aqui é acertar o caso comum e, nos casos em que errar sairia
 * caro, vir DESMARCADO em vez de arriscar.
 *
 * O cuidado principal está nas linhas de PAGAMENTO DE FATURA, que aparecem
 * tanto no extrato da conta quanto na fatura do cartão. Importar as duas
 * contaria o mesmo dinheiro duas vezes.
 */
export function classifyRow(row: ParsedRow, context: ImportContext): Classification {
  const text = normalize(row.description);
  const hints: Hint[] = [];
  const isOutflow = row.amountCents < 0;

  if (context.target.type === 'card') {
    // --- Fatura de cartão ------------------------------------------------
    if (INVOICE_PAYMENT_RE.test(text)) {
      return {
        kind: 'card_payment',
        hints: [
          {
            code: 'payment-on-invoice',
            text: 'Linha de pagamento da fatura. Ela normalmente já vem no extrato da conta — importar aqui contaria o pagamento duas vezes.',
          },
        ],
        selected: false, // desmarcada por padrão: o risco de duplicar é real
      };
    }
    if (CARD_CREDIT_RE.test(text) || row.amountCents < 0) {
      return { kind: 'chargeback', hints: [], selected: true };
    }
    return { kind: 'expense', hints: [], selected: true };
  }

  // --- Extrato de conta --------------------------------------------------
  if (isOutflow && INVOICE_PAYMENT_RE.test(text)) {
    if (context.paymentCardId) {
      return { kind: 'card_payment', hints: [], selected: true, paymentCardId: context.paymentCardId };
    }
    // Sem saber o cartão, esta linha viraria despesa comum e duplicaria TODAS
    // as compras daquela fatura. Vem desmarcada: um "Importar" distraído não
    // pode custar isso.
    return {
      kind: 'card_payment',
      hints: [
        {
          code: 'needs-card',
          text: 'Parece pagamento de fatura. Escolha o cartão ao lado para importar — como despesa comum, esta linha duplicaria todas as compras daquele cartão.',
        },
      ],
      selected: false,
    };
  }

  if (TRANSFER_RE.test(text)) {
    hints.push({
      code: 'maybe-transfer',
      text: 'Parece transferência entre suas contas. Se for, troque o tipo para "Transferência" e escolha a outra conta — assim ela não entra como despesa nem como receita.',
    });
  }

  return { kind: isOutflow ? 'expense' : 'income', hints, selected: true };
}

/**
 * Verifica se falta algo para a linha poder ser gravada.
 * Transferência sem a outra conta e pagamento de fatura sem cartão não têm
 * como virar lançamento válido.
 */
export function blockingReason(row: PreviewRow, context: ImportContext): string | undefined {
  if (row.kind === 'transfer') {
    if (context.target.type !== 'account') return 'Transferência só faz sentido num extrato de conta.';
    if (!row.counterAccountId) return 'Escolha a outra conta da transferência.';
    if (row.counterAccountId === context.target.accountId) {
      return 'A outra conta precisa ser diferente desta.';
    }
  }
  if (row.kind === 'card_payment') {
    const card = context.target.type === 'card' ? context.target.cardId : (row.paymentCardId ?? context.paymentCardId);
    if (!card) return 'Escolha o cartão cuja fatura foi paga.';
    if (context.target.type === 'card' && !context.paymentAccountId) {
      return 'Escolha a conta que pagou a fatura.';
    }
  }
  return undefined;
}

/** O cartão de uma linha: o escolhido nela, o sugerido, ou o próprio destino. */
function cardForRow(row: PreviewRow, context: ImportContext): Card | undefined {
  if (context.target.type === 'card') return context.target.card;
  const id = row.paymentCardId ?? context.paymentCardId;
  if (!id) return undefined;
  return context.cards?.find((c) => c.id === id);
}

/**
 * Recalcula o que depende das escolhas feitas na prévia: duplicidade, avisos e
 * o que ainda falta preencher.
 *
 * Precisa rodar a cada edição sua. A duplicidade de uma transferência, por
 * exemplo, só pode ser avaliada DEPOIS que você diz qual é a outra conta —
 * é o par de contas que identifica o movimento nos dois extratos.
 */
export function refreshRow(row: PreviewRow, context: ImportContext): PreviewRow {
  const next: PreviewRow = { ...row };
  // Se a linha estava fora só por faltar uma informação, completar essa
  // informação devolve a marcação — igual ao que acontece quando o cartão é
  // escolhido no campo do topo.
  const estavaBloqueada = Boolean(row.blocked);

  const targetAccountId = context.target.type === 'account' ? context.target.accountId : undefined;
  const targetCardId = context.target.type === 'card' ? context.target.cardId : undefined;

  const candidate: DuplicateCandidate = {
    kind: next.kind,
    date: next.date,
    description: next.description,
    amountCents: next.amountCents,
  };
  if (next.parsed.externalId) candidate.externalId = next.parsed.externalId;
  if (next.parsed.installmentNumber) candidate.installmentNumber = next.parsed.installmentNumber;

  if (next.kind === 'transfer') {
    // As duas pontas, na ordem real do movimento.
    if (next.parsed.amountCents < 0) {
      if (targetAccountId) candidate.accountId = targetAccountId;
      if (next.counterAccountId) candidate.toAccountId = next.counterAccountId;
    } else {
      if (next.counterAccountId) candidate.accountId = next.counterAccountId;
      if (targetAccountId) candidate.toAccountId = targetAccountId;
    }
  } else if (next.kind === 'card_payment') {
    const cardId = targetCardId ?? next.paymentCardId ?? context.paymentCardId;
    if (cardId) candidate.cardId = cardId;
    // A fatura quitada depende do ciclo daquele cartão, então é recalculada
    // sempre que você troca o cartão da linha.
    const card = cardForRow(next, context);
    if (card) next.invoiceRef = invoiceRefForPaymentDate(card, next.date);
    else delete next.invoiceRef;
  } else {
    if (targetCardId) candidate.cardId = targetCardId;
    else if (targetAccountId) candidate.accountId = targetAccountId;
  }

  next.duplicates = findDuplicates(candidate, context.existing, DUPLICATE_THRESHOLD);
  next.duplicateScore = next.duplicates[0]?.score ?? 0;

  // Reconstrói os avisos do zero. Um conselho que você já seguiu sai da tela.
  const warnings: string[] = [];
  for (const hint of next.hints) {
    if (hint.code === 'maybe-transfer' && next.kind === 'transfer') continue;
    if (hint.code === 'needs-card' && cardForRow(next, context)) continue;
    if (hint.code === 'payment-on-invoice' && next.kind !== 'card_payment') continue;
    warnings.push(hint.text);
  }
  if (next.duplicateScore >= DUPLICATE_STRONG_THRESHOLD) {
    warnings.push('Possível duplicidade: já existe um lançamento praticamente idêntico.');
  } else if (next.duplicateScore >= DUPLICATE_THRESHOLD) {
    warnings.push('Possível duplicidade — confira antes de importar.');
  }
  next.warnings = warnings;

  const blocked = blockingReason(next, context);
  if (blocked) {
    next.blocked = blocked;
    next.selected = false;
  } else {
    delete next.blocked;
    if (next.duplicateScore >= DUPLICATE_STRONG_THRESHOLD) next.selected = false;
    else if (estavaBloqueada) next.selected = true;
  }
  return next;
}

/** Aplica uma troca de tipo feita por você, recalculando o que depende dela. */
export function changeRowKind(
  row: PreviewRow,
  kind: TransactionKind,
  context: ImportContext,
): PreviewRow {
  const next: PreviewRow = { ...row, kind };

  // Categoria só existe em despesa e receita.
  if (kind !== 'expense' && kind !== 'income' && kind !== 'refund' && kind !== 'chargeback') {
    delete next.categoryId;
    next.categorySource = 'none';
    next.needsReview = false;
  }
  if (kind !== 'transfer') delete next.counterAccountId;
  if (kind !== 'card_payment') {
    delete next.paymentCardId;
    delete next.invoiceRef;
  } else if (context.paymentCardId && !next.paymentCardId) {
    next.paymentCardId = context.paymentCardId;
  }

  return refreshRow(next, context);
}


// ---------------------------------------------------------------------------
// Reconciliação de parcelas entre importações
// ---------------------------------------------------------------------------

/** Tolerância de dias entre a data esperada de uma parcela e a data real. */
const INSTALLMENT_DATE_TOLERANCE_DAYS = 6;

/**
 * Descobre a qual compra parcelada uma parcela recém-importada pertence.
 *
 * A fatura de cada mês traz UMA parcela ("NOTEBOOK LOJA ELETRO 03/08"). Para
 * que as oito parcelas formem uma única compra, é preciso reconhecer que a
 * parcela deste mês continua a que veio no mês passado.
 *
 * Não serve derivar a chave da descrição: ela carrega o número da parcela, que
 * muda todo mês. Nem incluir o valor: o centavo de resto faz a primeira
 * parcela ser um centavo maior que as outras.
 *
 * A reconciliação usa três coisas que de fato identificam a compra:
 *  · o mesmo estabelecimento (já sem o sufixo de parcela);
 *  · o mesmo número TOTAL de parcelas;
 *  · a data compatível — a parcela 5 tem de cair cinco meses depois da 1.
 *
 * E exige que aquele número de parcela ainda não exista no grupo, para que duas
 * compras diferentes na mesma loja, com o mesmo número de parcelas, não sejam
 * fundidas numa só.
 */
export function resolveInstallmentGroup(
  row: { description: string; date: ISODate; installmentNumber: number; installmentTotal: number; cardId?: ID },
  known: readonly Transaction[],
): ID {
  const merchant = normalizeMerchant(row.description);

  const candidates = known.filter(
    (tx) =>
      tx.installmentGroupId &&
      tx.installmentTotal === row.installmentTotal &&
      tx.cardId === row.cardId &&
      normalizeMerchant(tx.description) === merchant,
  );

  const byGroup = new Map<ID, Transaction[]>();
  for (const tx of candidates) {
    const list = byGroup.get(tx.installmentGroupId!) ?? [];
    list.push(tx);
    byGroup.set(tx.installmentGroupId!, list);
  }

  let best: { groupId: ID; distance: number } | undefined;
  for (const [groupId, members] of byGroup) {
    // Aquele número de parcela já está no grupo: é outra compra.
    if (members.some((m) => m.installmentNumber === row.installmentNumber)) continue;

    for (const member of members) {
      if (!member.installmentNumber) continue;
      const expected = addMonths(member.date, row.installmentNumber - member.installmentNumber);
      const distance = Math.abs(diffDays(row.date, expected));
      if (distance > INSTALLMENT_DATE_TOLERANCE_DAYS) continue;
      if (!best || distance < best.distance) best = { groupId, distance };
    }
  }

  return best?.groupId ?? newId('parc');
}

export function buildImportPreview(parsed: ParseResult, context: ImportContext): ImportPreview {
  const rows: PreviewRow[] = [];
  // O histórico de aprendizado cresce com as próprias linhas do arquivo:
  // classificar a primeira "IFOOD" ajuda as seguintes.
  const history: Transaction[] = [...context.existing];

  for (const parsedRow of parsed.rows) {
    const classification = classifyRow(parsedRow, context);
    const { kind } = classification;
    const amountCents = Math.abs(parsedRow.amountCents);


    const suggestion =
      kind === 'expense' || kind === 'income'
        ? suggestCategory({ description: parsedRow.description, rules: context.rules, history })
        : { categoryId: undefined, source: 'none' as const, confidence: 1, needsReview: false, isFixed: undefined };

    const draftRow: PreviewRow = {
      key: `${parsedRow.sourceLine}-${parsedRow.date}-${amountCents}`,
      parsed: parsedRow,
      kind,
      amountCents,
      date: parsedRow.date,
      description: parsedRow.description,
      categorySource: suggestion.source,
      needsReview: suggestion.needsReview,
      isFixed: suggestion.isFixed ?? false,
      availableKinds: context.target.type === 'card' ? CARD_KINDS : ACCOUNT_KINDS,
      duplicates: [],
      duplicateScore: 0,
      selected: classification.selected,
      hints: classification.hints,
      warnings: [],
    };
    if (suggestion.categoryId) draftRow.categoryId = suggestion.categoryId;
    if (classification.paymentCardId) draftRow.paymentCardId = classification.paymentCardId;

    // Duplicidade, avisos e bloqueio saem do mesmo lugar que roda depois de
    // cada edição sua — assim a prévia inicial e a editada seguem a mesma regra.
    const row = refreshRow(draftRow, context);
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
      blocked: rows.filter((r) => r.blocked).length,
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
  // A reconciliação de parcelas cresce durante a própria importação: uma fatura
  // pode trazer duas parcelas da mesma compra, e a segunda precisa reconhecer a
  // primeira.
  const known: Transaction[] = [...context.existing];
  const created: Transaction[] = [];

  for (const row of preview.rows) {
    if (!row.selected) continue;
    const tx = buildTransaction(draftFromRow(row, context, importBatchId, known));
    known.push(tx);
    created.push(tx);
  }

  return created;
}

/** Monta o rascunho de um lançamento a partir de uma linha da prévia. */
function draftFromRow(
  row: PreviewRow,
  context: ImportContext,
  importBatchId: ID,
  known: readonly Transaction[],
): TransactionDraft {
  const targetAccountId = context.target.type === 'account' ? context.target.accountId : undefined;
  const targetCardId = context.target.type === 'card' ? context.target.cardId : undefined;

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
    draft.installmentGroupId = resolveInstallmentGroup(
      {
        description: row.description,
        date: row.date,
        installmentNumber: row.parsed.installmentNumber,
        installmentTotal: row.parsed.installmentTotal,
        cardId: targetCardId,
      },
      known,
    );
  }

  switch (row.kind) {
    case 'card_payment':
      draft.accountId = targetAccountId ?? context.paymentAccountId;
      draft.cardId = targetCardId ?? row.paymentCardId ?? context.paymentCardId;
      if (row.invoiceRef) draft.invoiceRef = row.invoiceRef;
      draft.paymentMethod = 'debit';
      break;

    case 'transfer':
      // A ponta da transferência depende do sinal da linha no arquivo: uma
      // saída parte da conta importada; uma entrada chega nela.
      if (row.parsed.amountCents < 0) {
        draft.accountId = targetAccountId;
        draft.toAccountId = row.counterAccountId;
      } else {
        draft.accountId = row.counterAccountId;
        draft.toAccountId = targetAccountId;
      }
      draft.paymentMethod = 'transfer';
      break;

    default:
      if (targetCardId) {
        draft.cardId = targetCardId;
        draft.paymentMethod = 'credit';
      } else {
        draft.accountId = targetAccountId;
        draft.paymentMethod = row.kind === 'income' ? 'transfer' : 'debit';
      }
      break;
  }

  return draft;
}
