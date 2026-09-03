/**
 * Dinheiro.
 *
 * REGRA ABSOLUTA DO PROJETO: todo valor monetário é um INTEIRO em CENTAVOS.
 * Nunca usamos float para dinheiro. `0.1 + 0.2 !== 0.3` em ponto flutuante,
 * e num sistema financeiro isso vira centavo perdido em relatório.
 *
 * Conversão para reais acontece apenas na borda (formatação e parsing de input).
 */

/** Valor monetário em centavos. Sempre inteiro. */
export type Cents = number;

const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

export function isCents(v: unknown): v is Cents {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

/** Garante que um número é um valor em centavos válido. Lança se não for. */
export function assertCents(v: number, label = 'valor'): Cents {
  if (!Number.isFinite(v)) throw new Error(`${label}: valor não é um número finito`);
  if (!Number.isInteger(v)) throw new Error(`${label}: valor monetário precisa ser inteiro em centavos (recebido ${v})`);
  if (Math.abs(v) > MAX_SAFE_CENTS) throw new Error(`${label}: valor fora do intervalo seguro`);
  return v;
}

/** Converte reais (número) para centavos, arredondando meio-para-cima em valor absoluto. */
export function toCents(reais: number): Cents {
  if (!Number.isFinite(reais)) throw new Error('valor inválido');
  // Math.round(-0.5) === -0 (arredonda para cima). Usamos sinal explícito para
  // que -1.005 e 1.005 arredondem simetricamente.
  const sign = reais < 0 ? -1 : 1;
  // Multiplicação com correção de erro binário: 19.99 * 100 === 1998.9999999999998
  return sign * Math.round(Math.abs(reais) * 100 + Number.EPSILON * Math.abs(reais) * 100);
}

/** Converte centavos para reais (apenas para exibição / export). */
export function toReais(cents: Cents): number {
  return cents / 100;
}

/**
 * Interpreta texto digitado pelo usuário ou vindo de extrato.
 * Aceita: "1.234,56" · "1234,56" · "1,234.56" · "1234.56" · "R$ 1.234,56"
 *         "-50" · "(50)" (parênteses = negativo, comum em extratos)
 *         "1.234,56 D" / "1.234,56 C" (débito/crédito, comum em OFX/CSV de banco)
 * Retorna null quando não há número reconhecível.
 */
export function parseMoney(input: string | number | null | undefined): Cents | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? toCents(input) : null;

  let s = String(input).trim();
  if (!s) return null;

  let sign = 1;

  // Sufixo D/C usado por bancos brasileiros (Débito / Crédito)
  const dcMatch = s.match(/\s([DC])$/i);
  if (dcMatch) {
    if (dcMatch[1]!.toUpperCase() === 'D') sign = -1;
    s = s.slice(0, -2).trim();
  }

  // Parênteses contábeis
  if (/^\(.*\)$/.test(s)) {
    sign = -sign;
    s = s.slice(1, -1).trim();
  }

  // Remove tudo que não seja dígito, separador ou sinal
  s = s.replace(/[R$\s ]/gi, '');

  if (s.startsWith('-')) {
    sign = -sign;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  // Sinal no fim ("50-") aparece em alguns extratos
  if (s.endsWith('-')) {
    sign = -sign;
    s = s.slice(0, -1);
  }

  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  let normalized: string;
  if (lastComma === -1 && lastDot === -1) {
    normalized = s;
  } else if (lastComma > lastDot) {
    // Padrão brasileiro: vírgula é decimal, ponto é milhar
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    // Padrão americano: ponto é decimal, vírgula é milhar
    normalized = s.replace(/,/g, '');
  } else {
    normalized = s;
  }

  // "1.234" sem decimais: se o separador restante divide grupos de 3, é milhar.
  const onlySep = normalized.match(/^(\d+)\.(\d+)$/);
  if (onlySep && onlySep[2]!.length === 3 && lastComma === -1) {
    normalized = onlySep[1]! + onlySep[2]!;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return sign * toCents(value);
}

const BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const BRL_NO_SYMBOL = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const BRL_COMPACT = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  notation: 'compact',
  maximumFractionDigits: 1,
});

export interface FormatMoneyOptions {
  /** Omite o "R$". */
  noSymbol?: boolean;
  /** Usa notação compacta (R$ 1,2 mil) — só para eixos de gráfico. */
  compact?: boolean;
  /** Força o sinal "+" em valores positivos. */
  signed?: boolean;
}

export function formatMoney(cents: Cents, opts: FormatMoneyOptions = {}): string {
  const value = toReais(cents);
  const fmt = opts.compact ? BRL_COMPACT : opts.noSymbol ? BRL_NO_SYMBOL : BRL;
  const out = fmt.format(value);
  if (opts.signed && cents > 0) return `+${out}`;
  return out;
}

/** Soma segura de centavos. */
export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * Divide um total em `count` parcelas SEM PERDER CENTAVOS.
 *
 * R$ 100,00 em 3x  →  33,34 · 33,33 · 33,33  (soma exata = 100,00)
 * O resto é distribuído nas PRIMEIRAS parcelas, que é como as operadoras
 * de cartão brasileiras fazem.
 */
export function splitInstallments(totalCents: Cents, count: number): Cents[] {
  assertCents(totalCents, 'total');
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`número de parcelas inválido: ${count}`);
  }
  const sign = totalCents < 0 ? -1 : 1;
  const abs = Math.abs(totalCents);
  const base = Math.floor(abs / count);
  const remainder = abs - base * count;

  const parts: Cents[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(sign * (base + (i < remainder ? 1 : 0)));
  }
  return parts;
}

/** Percentual de `part` sobre `whole`, em 0..1. Retorna 0 quando `whole` é 0. */
export function ratio(part: Cents, whole: Cents): number {
  if (whole === 0) return 0;
  return part / whole;
}

/** Formata um percentual (0..1) como "42,3%". */
export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('pt-BR', {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}
