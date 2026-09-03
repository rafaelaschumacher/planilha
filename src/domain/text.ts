/** Normalização de texto usada por regras, deduplicação e busca. */

/** Minúsculas, sem acento, sem pontuação, espaços colapsados. */
export function normalize(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Limpa ruído típico de extrato bancário e fatura de cartão para comparação:
 * códigos de autorização, datas embutidas, sufixos de parcela e termos
 * genéricos que aparecem em todo lançamento ("COMPRA CARTAO", "PGTO").
 *
 * A limpeza das datas e das parcelas acontece ANTES de `normalize`, enquanto
 * a barra de "12/03" e de "2/6" ainda existe — depois ela vira espaço e o
 * padrão deixa de ser reconhecível.
 */
export function normalizeMerchant(input: string): string {
  let s = input
    .replace(/\bparc(?:ela)?\.?\s*\d+\s*(?:de|\/)\s*\d+\b/gi, ' ')
    .replace(/\b\d{1,2}\s*\/\s*\d{1,2}(?:\s*\/\s*\d{2,4})?\b/g, ' ')
    .replace(/\b\d{1,2}\s*de\s*\d{1,2}\b/gi, ' ');

  s = normalize(s);
  s = s.replace(/\b(compra|pagamento|pgto|pag|debito|credito|cartao|com|br|ltda|me|eireli|sa)\b/g, ' ');
  s = s.replace(/\b\d{4,}\b/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  // Tokens puramente numéricos são código de terminal, loja ou autorização.
  const kept = s.split(' ').filter((t) => t && !/^\d+$/.test(t));
  const result = kept.join(' ').trim();

  // Descrições que são só números continuam precisando de uma chave estável.
  return result || normalize(input);
}

/** Tokens únicos com 3+ caracteres. */
export function tokens(input: string): string[] {
  return Array.from(new Set(normalize(input).split(' ').filter((t) => t.length >= 3)));
}

/** Similaridade de Jaccard entre os tokens de dois textos (0..1). */
export function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Hash determinístico e estável (FNV-1a 32 bits) em base36. */
export function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

/** Primeira letra maiúscula de cada palavra, preservando siglas curtas. */
export function titleCase(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}
