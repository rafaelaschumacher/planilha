/**
 * Categorização automática.
 *
 * Hierarquia de confiança, do mais forte ao mais fraco:
 *   1. O que VOCÊ definiu à mão  → nunca é sobrescrito pela automação.
 *   2. Regra configurada          → alta confiança.
 *   3. Histórico idêntico         → alta confiança (você já classificou isso antes).
 *   4. Histórico parecido         → baixa confiança → marca "revisar categoria".
 *   5. Nada                       → sem categoria → marca "revisar categoria".
 */

import { normalize, normalizeMerchant, tokenSimilarity } from './text';
import type { CategoryRule, CategorySource, ID, MatchType, Transaction } from './types';

export interface CategorySuggestion {
  categoryId?: ID;
  source: CategorySource;
  /** 0..1 */
  confidence: number;
  ruleId?: ID;
  isFixed?: boolean;
  /** Sinaliza "revisar categoria" na interface. */
  needsReview: boolean;
  reason?: string;
}

/** Abaixo disso a sugestão é aceita, mas pedindo revisão. */
export const CONFIDENCE_REVIEW_THRESHOLD = 0.75;

export function matches(pattern: string, matchType: MatchType, description: string): boolean {
  const haystack = normalize(description);
  if (matchType === 'regex') {
    try {
      return new RegExp(pattern, 'i').test(description) || new RegExp(pattern, 'i').test(haystack);
    } catch {
      return false; // regra com expressão inválida nunca derruba a importação
    }
  }
  const needle = normalize(pattern);
  if (!needle) return false;
  return matchType === 'startsWith' ? haystack.startsWith(needle) : haystack.includes(needle);
}

/**
 * Primeira regra que bate, respeitando prioridade e, em empate, a regra mais
 * específica (padrão mais longo) — "uber eats" vence "uber".
 */
export function matchRule(description: string, rules: readonly CategoryRule[]): CategoryRule | undefined {
  const ordered = [...rules]
    .filter((r) => r.active)
    .sort((a, b) => a.priority - b.priority || b.pattern.length - a.pattern.length);
  return ordered.find((rule) => matches(rule.pattern, rule.matchType, description));
}

/** Categoria usada antes para uma descrição igual ou parecida. */
export function suggestFromHistory(
  description: string,
  history: readonly Transaction[],
): { categoryId: ID; confidence: number; isFixed: boolean } | undefined {
  const target = normalizeMerchant(description);
  if (!target) return undefined;

  let exact: Transaction | undefined;
  let best: { tx: Transaction; similarity: number } | undefined;

  for (const tx of history) {
    if (!tx.categoryId) continue;
    // Só aprende com o que foi confirmado por você ou por uma regra.
    if (tx.categorySource !== 'manual' && tx.categorySource !== 'rule') continue;
    const candidate = normalizeMerchant(tx.description);
    if (!candidate) continue;
    if (candidate === target) {
      if (!exact || tx.date > exact.date) exact = tx;
      continue;
    }
    const similarity = tokenSimilarity(candidate, target);
    if (similarity >= 0.6 && (!best || similarity > best.similarity)) best = { tx, similarity };
  }

  if (exact) return { categoryId: exact.categoryId!, confidence: 0.9, isFixed: exact.isFixed };
  if (best) return { categoryId: best.tx.categoryId!, confidence: 0.4 + best.similarity * 0.35, isFixed: best.tx.isFixed };
  return undefined;
}

export interface SuggestInput {
  description: string;
  rules: readonly CategoryRule[];
  history: readonly Transaction[];
  /** Categoria já escolhida à mão. Quando presente, vence tudo. */
  manualCategoryId?: ID;
}

export function suggestCategory(input: SuggestInput): CategorySuggestion {
  if (input.manualCategoryId) {
    return {
      categoryId: input.manualCategoryId,
      source: 'manual',
      confidence: 1,
      needsReview: false,
      reason: 'definida por você',
    };
  }

  const rule = matchRule(input.description, input.rules);
  if (rule) {
    const suggestion: CategorySuggestion = {
      categoryId: rule.categoryId,
      source: 'rule',
      confidence: 0.95,
      ruleId: rule.id,
      needsReview: false,
      reason: `regra "${rule.pattern}"`,
    };
    if (rule.setIsFixed !== undefined) suggestion.isFixed = rule.setIsFixed;
    return suggestion;
  }

  const historical = suggestFromHistory(input.description, input.history);
  if (historical) {
    return {
      categoryId: historical.categoryId,
      source: 'inferred',
      confidence: historical.confidence,
      isFixed: historical.isFixed,
      needsReview: historical.confidence < CONFIDENCE_REVIEW_THRESHOLD,
      reason: 'baseada em lançamentos anteriores',
    };
  }

  return {
    source: 'none',
    confidence: 0,
    needsReview: true,
    reason: 'nenhuma regra ou histórico correspondente',
  };
}

/**
 * Cria uma regra a partir de uma correção manual — é assim que a plataforma
 * aprende: você corrige uma vez, ela acerta nas próximas.
 */
export function ruleFromCorrection(
  description: string,
  categoryId: ID,
  options: { priority?: number; id?: ID; setIsFixed?: boolean } = {},
): Omit<CategoryRule, 'createdAt' | 'updatedAt'> {
  // Usa os tokens mais significativos: evita gravar "compra 12/03 auth 887711".
  const pattern = normalizeMerchant(description).split(' ').slice(0, 3).join(' ') || normalize(description);
  const rule: Omit<CategoryRule, 'createdAt' | 'updatedAt'> = {
    id: options.id ?? `rule_${pattern.replace(/\s/g, '-')}_${Math.random().toString(36).slice(2, 7)}`,
    pattern,
    matchType: 'contains',
    categoryId,
    priority: options.priority ?? 100,
    active: true,
    hits: 0,
  };
  if (options.setIsFixed !== undefined) rule.setIsFixed = options.setIsFixed;
  return rule;
}
