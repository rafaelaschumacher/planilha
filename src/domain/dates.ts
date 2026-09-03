/**
 * Datas.
 *
 * REGRA ABSOLUTA DO PROJETO: datas financeiras são DATAS CIVIS, não instantes.
 * "Comprei dia 31/03" é dia 31/03 em qualquer fuso horário. Por isso trabalhamos
 * com strings "YYYY-MM-DD" e aritmética própria, nunca com `new Date(string)`
 * — que interpreta "2024-03-31" como UTC e, em UTC-3, exibe 30/03.
 *
 * Esse é o bug mais comum em app financeiro: lançamento cai no mês errado.
 */

/** Data civil no formato YYYY-MM-DD. */
export type ISODate = string;
/** Mês no formato YYYY-MM. */
export type ISOMonth = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

export interface CivilDate {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

export function isISODate(v: unknown): v is ISODate {
  return typeof v === 'string' && DATE_RE.test(v) && parseISO(v as ISODate) !== null;
}

export function isISOMonth(v: unknown): v is ISOMonth {
  return typeof v === 'string' && MONTH_RE.test(v);
}

const pad = (n: number, size = 2) => String(n).padStart(size, '0');

export function fmtDate({ y, m, d }: CivilDate): ISODate {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** Converte "YYYY-MM-DD" em partes. Retorna null se a data não existir (ex.: 31/02). */
export function parseISO(iso: ISODate): CivilDate | null {
  const match = DATE_RE.exec(iso);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

/** Igual a parseISO, mas lança em vez de retornar null. */
export function mustParseISO(iso: ISODate): CivilDate {
  const parsed = parseISO(iso);
  if (!parsed) throw new Error(`data inválida: ${iso}`);
  return parsed;
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  switch (m) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12: return 31;
    case 4: case 6: case 9: case 11: return 30;
    case 2: return isLeapYear(y) ? 29 : 28;
    default: throw new Error(`mês inválido: ${m}`);
  }
}

/** Data de hoje no fuso local do usuário, como data civil. */
export function today(now: Date = new Date()): ISODate {
  return fmtDate({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
}

/** Ordena/compara datas civis. Como são strings ISO, a ordem lexicográfica basta. */
export function compareDate(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** a <= x <= b (inclusivo nas duas pontas). */
export function isBetween(x: ISODate, a: ISODate, b: ISODate): boolean {
  return x >= a && x <= b;
}

/** Número de dias desde 1970-01-01 (usado só para diferenças, nunca para exibir). */
export function toEpochDay(iso: ISODate): number {
  const { y, m, d } = mustParseISO(iso);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function fromEpochDay(epochDay: number): ISODate {
  const dt = new Date(epochDay * 86_400_000);
  return fmtDate({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
}

export function addDays(iso: ISODate, days: number): ISODate {
  return fromEpochDay(toEpochDay(iso) + days);
}

export function diffDays(a: ISODate, b: ISODate): number {
  return toEpochDay(a) - toEpochDay(b);
}

/**
 * Soma meses preservando o dia quando possível e "grudando" no último dia
 * do mês quando o dia não existe.
 *
 *   31/01 + 1 mês → 28/02 (ou 29/02 em ano bissexto)
 *   31/03 + 1 mês → 30/04
 *
 * É exatamente o comportamento das parcelas de cartão.
 */
export function addMonths(iso: ISODate, months: number): ISODate {
  const { y, m, d } = mustParseISO(iso);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12 + 12) % 12 + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return fmtDate({ y: ny, m: nm, d: nd });
}

export function monthOf(iso: ISODate): ISOMonth {
  return iso.slice(0, 7);
}

export function yearOf(iso: ISODate | ISOMonth): number {
  return Number(iso.slice(0, 4));
}

export function currentMonth(now: Date = new Date()): ISOMonth {
  return monthOf(today(now));
}

export function parseMonth(month: ISOMonth): { y: number; m: number } {
  const match = MONTH_RE.exec(month);
  if (!match) throw new Error(`mês inválido: ${month}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  if (m < 1 || m > 12) throw new Error(`mês inválido: ${month}`);
  return { y, m };
}

export function fmtMonth(y: number, m: number): ISOMonth {
  return `${pad(y, 4)}-${pad(m)}`;
}

export function addMonthsToMonth(month: ISOMonth, delta: number): ISOMonth {
  const { y, m } = parseMonth(month);
  const total = y * 12 + (m - 1) + delta;
  return fmtMonth(Math.floor(total / 12), (total % 12 + 12) % 12 + 1);
}

export function diffMonths(a: ISOMonth, b: ISOMonth): number {
  const pa = parseMonth(a);
  const pb = parseMonth(b);
  return (pa.y * 12 + pa.m) - (pb.y * 12 + pb.m);
}

export function startOfMonth(month: ISOMonth): ISODate {
  const { y, m } = parseMonth(month);
  return fmtDate({ y, m, d: 1 });
}

export function endOfMonth(month: ISOMonth): ISODate {
  const { y, m } = parseMonth(month);
  return fmtDate({ y, m, d: daysInMonth(y, m) });
}

/**
 * Constrói uma data a partir de um "dia do mês" que pode não existir naquele mês.
 * Dia 31 em fevereiro vira 28/29. Usado para fechamento e vencimento de cartão.
 */
export function dayInMonth(month: ISOMonth, day: number): ISODate {
  const { y, m } = parseMonth(month);
  return fmtDate({ y, m, d: Math.min(Math.max(1, Math.trunc(day)), daysInMonth(y, m)) });
}

/** Lista de meses de `from` até `to`, inclusivo. */
export function monthRange(from: ISOMonth, to: ISOMonth): ISOMonth[] {
  const out: ISOMonth[] = [];
  const n = diffMonths(to, from);
  if (n < 0) return out;
  for (let i = 0; i <= n; i++) out.push(addMonthsToMonth(from, i));
  return out;
}

/** Os `count` meses terminando em `end` (inclusive), do mais antigo ao mais recente. */
export function lastMonths(end: ISOMonth, count: number): ISOMonth[] {
  return monthRange(addMonthsToMonth(end, -(count - 1)), end);
}

// ---------------------------------------------------------------------------
// Semanas
// ---------------------------------------------------------------------------

/** 0 = domingo … 6 = sábado. */
export function dayOfWeek(iso: ISODate): number {
  // 1970-01-01 foi uma quinta-feira (índice 4).
  return ((toEpochDay(iso) % 7) + 7 + 4) % 7;
}

/**
 * Início da semana que contém `iso`.
 * `firstDay` 0 = domingo (padrão brasileiro), 1 = segunda.
 */
export function startOfWeek(iso: ISODate, firstDay: 0 | 1 = 0): ISODate {
  const dow = dayOfWeek(iso);
  const back = (dow - firstDay + 7) % 7;
  return addDays(iso, -back);
}

export function endOfWeek(iso: ISODate, firstDay: 0 | 1 = 0): ISODate {
  return addDays(startOfWeek(iso, firstDay), 6);
}

/** Identificador estável da semana: a própria data de início ("2024-03-03"). */
export function weekKey(iso: ISODate, firstDay: 0 | 1 = 0): ISODate {
  return startOfWeek(iso, firstDay);
}

// ---------------------------------------------------------------------------
// Formatação para a interface
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];
const MONTH_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEKDAY_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** "15/03/2024" */
export function formatDateBR(iso: ISODate): string {
  const { y, m, d } = mustParseISO(iso);
  return `${pad(d)}/${pad(m)}/${y}`;
}

/** "15 mar" */
export function formatDayMonth(iso: ISODate): string {
  const { m, d } = mustParseISO(iso);
  return `${pad(d)} ${MONTH_SHORT[m - 1]}`;
}

/** "sex, 15 mar" */
export function formatDayWeekday(iso: ISODate): string {
  return `${WEEKDAY_SHORT[dayOfWeek(iso)]}, ${formatDayMonth(iso)}`;
}

/** "março de 2024" */
export function formatMonthLong(month: ISOMonth): string {
  const { y, m } = parseMonth(month);
  return `${MONTH_NAMES[m - 1]} de ${y}`;
}

/** "mar/24" */
export function formatMonthShort(month: ISOMonth): string {
  const { y, m } = parseMonth(month);
  return `${MONTH_SHORT[m - 1]}/${String(y).slice(2)}`;
}

/** "3 a 9 de março" */
export function formatWeekRange(start: ISODate): string {
  const end = addDays(start, 6);
  const s = mustParseISO(start);
  const e = mustParseISO(end);
  if (s.m === e.m) return `${s.d} a ${e.d} de ${MONTH_NAMES[s.m - 1]}`;
  return `${s.d} ${MONTH_SHORT[s.m - 1]} a ${e.d} ${MONTH_SHORT[e.m - 1]}`;
}

/** "hoje", "amanhã", "em 3 dias", "há 2 dias" */
export function relativeDay(iso: ISODate, reference: ISODate): string {
  const delta = diffDays(iso, reference);
  if (delta === 0) return 'hoje';
  if (delta === 1) return 'amanhã';
  if (delta === -1) return 'ontem';
  if (delta > 0) return `em ${delta} dias`;
  return `há ${-delta} dias`;
}
