/**
 * Detecção de duplicidade.
 *
 * REGRA: o sistema NUNCA apaga nem descarta sozinho. Ele levanta a mão e
 * espera a confirmação. Um lançamento marcado errado como duplicado some do
 * seu histórico sem você perceber — o custo do falso positivo é alto demais.
 */

import { compareDate, diffDays, type ISODate } from './dates';
import { tokenSimilarity } from './text';
import type { Transaction } from './types';

export interface DuplicateScore {
  /** 0..1 */
  score: number;
  reasons: string[];
}

export interface DuplicateMatch {
  existing: Transaction;
  score: number;
  reasons: string[];
}

/** A partir daqui o par é apresentado como "possível duplicidade". */
export const DUPLICATE_THRESHOLD = 0.7;
/** A partir daqui a linha já vem desmarcada na prévia de importação. */
export const DUPLICATE_STRONG_THRESHOLD = 0.9;

export interface DuplicateCandidate {
  kind: Transaction['kind'];
  date: ISODate;
  amountCents: number;
  description: string;
  accountId?: string;
  cardId?: string;
  /** Conta de destino, quando o lançamento é uma transferência. */
  toAccountId?: string;
  externalId?: string;
  installmentNumber?: number;
}

/**
 * Compara dois lançamentos e devolve a chance de serem o mesmo fato.
 *
 * Valores diferentes = fatos diferentes, ponto final. É a única regra rígida:
 * ela evita que duas compras parecidas no mesmo dia sejam fundidas.
 */
export function scoreDuplicate(a: DuplicateCandidate, b: Transaction): DuplicateScore {
  const reasons: string[] = [];

  if (a.kind !== b.kind) return { score: 0, reasons: [] };

  // Identificador do banco é prova, nos dois sentidos.
  if (a.externalId && b.externalId) {
    if (a.externalId === b.externalId) {
      return { score: 1, reasons: ['mesmo identificador do banco'] };
    }
    return { score: 0, reasons: [] };
  }

  if (a.amountCents !== b.amountCents) return { score: 0, reasons: [] };
  reasons.push('mesmo valor');
  let score = 0.45;

  // A MESMA transferência aparece nos dois extratos: como saída na conta de
  // origem e como entrada na de destino. Depois de reclassificada, o par de
  // contas identifica o movimento — e as descrições ("TRANSFERENCIA ENVIADA"
  // x "TRANSFERENCIA RECEBIDA") são diferentes de propósito, então comparar
  // texto não resolveria.
  if (a.kind === 'transfer' && b.kind === 'transfer') {
    const parA = [a.accountId, a.toAccountId].filter(Boolean).sort().join('|');
    const parB = [b.accountId, b.toAccountId].filter(Boolean).sort().join('|');
    if (parA && parA === parB) {
      const dias = Math.abs(diffDays(a.date, b.date));
      if (dias <= 2) {
        return { score: 1, reasons: ['mesma transferência entre as duas contas'] };
      }
    }
    return { score: 0, reasons: [] };
  }

  const days = Math.abs(diffDays(a.date, b.date));
  if (days === 0) {
    score += 0.3;
    reasons.push('mesma data');
  } else if (days <= 2) {
    score += 0.2;
    reasons.push(`datas próximas (${days} dia${days > 1 ? 's' : ''})`);
  } else if (days <= 4) {
    score += 0.1;
    reasons.push(`datas próximas (${days} dias)`);
  } else {
    return { score: 0, reasons: [] };
  }

  const aSource = a.cardId ?? a.accountId;
  const bSource = b.cardId ?? b.accountId;
  if (aSource && bSource) {
    if (aSource === bSource) {
      score += 0.1;
      reasons.push('mesma conta/cartão');
    } else {
      // Mesmo valor e data em CONTAS DIFERENTES quase nunca é duplicidade: é
      // transferência, ou dois gastos de verdade. Marcar aqui geraria alarme
      // falso constante. Reimportar um arquivo na conta errada é pego pela
      // detecção em lote da importação, que é muito mais confiável.
      score -= 0.35;
    }
  }

  const similarity = tokenSimilarity(a.description, b.description);
  if (similarity >= 0.99) {
    score += 0.25;
    reasons.push('mesma descrição');
  } else if (similarity >= 0.5) {
    score += 0.25 * similarity;
    reasons.push('descrição parecida');
  }

  if (a.installmentNumber && b.installmentNumber && a.installmentNumber !== b.installmentNumber) {
    return { score: 0, reasons: [] };
  }

  return { score: Math.max(0, Math.min(1, score)), reasons };
}

/** Lançamentos existentes parecidos com o candidato, do mais provável ao menos. */
export function findDuplicates(
  candidate: DuplicateCandidate,
  existing: readonly Transaction[],
  threshold = DUPLICATE_THRESHOLD,
): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];
  for (const tx of existing) {
    const { score, reasons } = scoreDuplicate(candidate, tx);
    if (score >= threshold) matches.push({ existing: tx, score, reasons });
  }
  return matches.sort((a, b) => b.score - a.score);
}

/**
 * Varre a base inteira procurando pares suspeitos.
 * Usado na auditoria e no painel de inconsistências.
 */
export function scanForDuplicates(
  transactions: readonly Transaction[],
  threshold = DUPLICATE_THRESHOLD,
): { a: Transaction; b: Transaction; score: number; reasons: string[] }[] {
  // Agrupa por valor: só faz sentido comparar lançamentos de mesmo valor.
  const buckets = new Map<number, Transaction[]>();
  for (const tx of transactions) {
    const list = buckets.get(tx.amountCents) ?? [];
    list.push(tx);
    buckets.set(tx.amountCents, list);
  }

  const pairs: { a: Transaction; b: Transaction; score: number; reasons: string[] }[] = [];
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    list.sort((x, y) => compareDate(x.date, y.date) || x.id.localeCompare(y.id));
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]!;
        // A lista está ordenada por data e o cálculo zera acima de 4 dias:
        // passando disso, nenhum par seguinte pode pontuar. Sem esta saída,
        // uma base com muitos valores repetidos vira uma varredura quadrática.
        if (Math.abs(diffDays(a.date, b.date)) > 4) break;
        // Parcelas do mesmo parcelamento nunca são duplicatas entre si.
        if (a.installmentGroupId && a.installmentGroupId === b.installmentGroupId) continue;
        const { score, reasons } = scoreDuplicate(a, b);
        if (score >= threshold) pairs.push({ a, b, score, reasons });
      }
    }
  }
  return pairs.sort((x, y) => y.score - x.score);
}
