/**
 * Leitura de datas, valores e colunas de arquivos de banco.
 *
 * Cada banco exporta de um jeito. Em vez de pedir que você configure o
 * mapeamento, o sistema tenta reconhecer sozinho — e mostra na prévia o que
 * entendeu, para você conferir antes de confirmar.
 */

import { parseMoney, type Cents } from '../domain/money';
import { fmtDate, isISODate, type ISODate } from '../domain/dates';
import { normalize } from '../domain/text';
import type { ColumnMapping, ParsedRow, ParseIssue } from './types';

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

/**
 * Lê uma data em qualquer formato comum de extrato brasileiro.
 * "15/03/2024" · "15-03-2024" · "2024-03-15" · "15/03/24" · "20240315"
 */
export function parseFlexibleDate(input: string, assumeDayFirst = true): ISODate | null {
  const value = String(input ?? '').trim();
  if (!value) return null;

  if (isISODate(value)) return value;

  // AAAAMMDD (OFX e alguns CSV)
  const compact = /^(\d{4})(\d{2})(\d{2})/.exec(value);
  if (compact) {
    const iso = `${compact[1]}-${compact[2]}-${compact[3]}`;
    return isISODate(iso) ? iso : null;
  }

  const parts = value.match(/^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (!parts) return null;

  let a = Number(parts[1]);
  let b = Number(parts[2]);
  let c = Number(parts[3]);

  // AAAA-MM-DD
  if (parts[1]!.length === 4) {
    const iso = fmtDate({ y: a, m: b, d: c });
    return isISODate(iso) ? iso : null;
  }

  // Ano com dois dígitos: 00-79 → 2000s, 80-99 → 1900s.
  if (c < 100) c += c < 80 ? 2000 : 1900;

  // Dia e mês: usa a ordem indicada, mas corrige quando é impossível.
  let day = assumeDayFirst ? a : b;
  let month = assumeDayFirst ? b : a;
  if (month > 12 && day <= 12) [day, month] = [month, day];

  const iso = fmtDate({ y: c, m: month, d: day });
  return isISODate(iso) ? iso : null;
}

/**
 * Descobre se o arquivo usa dia/mês (padrão brasileiro) ou mês/dia.
 * Se alguma linha tem o primeiro número maior que 12, a ordem está decidida.
 */
export function detectDayFirst(samples: readonly string[]): boolean {
  let dayFirstEvidence = 0;
  let monthFirstEvidence = 0;
  for (const sample of samples) {
    const parts = String(sample ?? '').match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.]/);
    if (!parts) continue;
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    if (a > 12 && b <= 12) dayFirstEvidence++;
    else if (b > 12 && a <= 12) monthFirstEvidence++;
  }
  if (monthFirstEvidence > dayFirstEvidence) return false;
  return true; // empate → formato brasileiro
}

// ---------------------------------------------------------------------------
// Reconhecimento de colunas
// ---------------------------------------------------------------------------

const HEADER_PATTERNS: { key: keyof ColumnMapping; patterns: RegExp[] }[] = [
  { key: 'date', patterns: [/^data/, /^date/, /lancamento.*data/, /^dt/, /data.*(mov|lanc|compra|transacao)/] },
  {
    key: 'description',
    patterns: [/descri/, /^histor/, /lancamento/, /memo/, /estabelec/, /detalhe/, /^titulo/, /^nome/, /transacao/],
  },
  { key: 'amount', patterns: [/^valor$/, /^valor\b/, /^amount/, /^montante/, /^vlr/, /valor.*(rs|brl|total)/] },
  { key: 'debit', patterns: [/debito/, /^saida/, /^saidas/, /^pagamento/] },
  { key: 'credit', patterns: [/credito/, /^entrada/, /^entradas/, /^recebimento/] },
  { key: 'externalId', patterns: [/fitid/, /^identificador/, /^id\b/, /documento/, /^doc$/] },
  { key: 'installment', patterns: [/parcela/, /^parc/] },
];

/** Casa os cabeçalhos do arquivo com os campos que o sistema precisa. */
export function mapHeaders(headers: readonly string[]): ColumnMapping | null {
  const normalized = headers.map((h) => normalize(h));
  const mapping: Partial<ColumnMapping> = {};

  for (const { key, patterns } of HEADER_PATTERNS) {
    for (let i = 0; i < normalized.length; i++) {
      const header = normalized[i]!;
      if (!header) continue;
      if (mapping[key] !== undefined) break;
      if (patterns.some((p) => p.test(header))) mapping[key] = i;
    }
  }

  if (mapping.date === undefined || mapping.description === undefined) return null;
  if (mapping.amount === undefined && mapping.debit === undefined && mapping.credit === undefined) return null;
  return mapping as ColumnMapping;
}

/**
 * Quando não há cabeçalho reconhecível, deduz pelas próprias linhas:
 * a coluna que sempre parece data é a data, a que sempre parece dinheiro é o
 * valor, e a coluna de texto mais longa é a descrição.
 */
export function inferMapping(rows: readonly string[][]): ColumnMapping | null {
  const sample = rows.slice(0, 30).filter((r) => r.length >= 2);
  if (sample.length === 0) return null;
  const width = Math.max(...sample.map((r) => r.length));

  let dateColumn = -1;
  let amountColumn = -1;
  let descriptionColumn = -1;
  let bestTextScore = -1;

  for (let col = 0; col < width; col++) {
    const values = sample.map((r) => r[col] ?? '').filter((v) => v.trim());
    if (values.length === 0) continue;

    const dateHits = values.filter((v) => parseFlexibleDate(v) !== null).length / values.length;
    const moneyHits = values.filter((v) => parseMoney(v) !== null).length / values.length;
    const textScore = values.reduce((sum, v) => sum + (/[a-zA-Zà-ú]{3,}/.test(v) ? v.length : 0), 0) / values.length;

    if (dateHits > 0.8 && dateColumn === -1) dateColumn = col;
    else if (moneyHits > 0.8 && amountColumn === -1 && dateHits < 0.5) amountColumn = col;
    else if (textScore > bestTextScore) {
      bestTextScore = textScore;
      descriptionColumn = col;
    }
  }

  if (dateColumn === -1 || amountColumn === -1 || descriptionColumn === -1) return null;
  return { date: dateColumn, description: descriptionColumn, amount: amountColumn };
}

/** Uma linha parece cabeçalho quando quase nada nela é data ou dinheiro. */
export function looksLikeHeader(row: readonly string[]): boolean {
  const filled = row.filter((c) => c.trim());
  if (filled.length < 2) return false;
  const dataLike = filled.filter((c) => parseFlexibleDate(c) !== null || parseMoney(c) !== null).length;
  return dataLike / filled.length < 0.3;
}

const INSTALLMENT_RE = /(?:^|[\s(-])(\d{1,2})\s*(?:\/|\s+de\s+)\s*(\d{1,2})(?:$|[\s)-])/;

/** Lê "PARCELA 2/6" ou "2 de 6" na descrição. */
export function extractInstallment(description: string): { number: number; total: number } | null {
  const match = INSTALLMENT_RE.exec(description);
  if (!match) return null;
  const number = Number(match[1]);
  const total = Number(match[2]);
  if (!number || !total || number > total || total < 2 || total > 99) return null;
  return { number, total };
}

export interface MapRowsOptions {
  /** Força um mapeamento em vez de deduzir. */
  mapping?: ColumnMapping;
  headers?: string[];
}

export interface MapRowsResult {
  rows: ParsedRow[];
  issues: ParseIssue[];
  mapping: ColumnMapping | null;
  headers: string[];
}

/**
 * Converte a matriz de células (vinda de CSV ou de XLSX) em linhas prontas.
 * Linhas que não dão para entender viram avisos — nunca somem em silêncio.
 */
export function mapMatrix(matrix: readonly string[][], options: MapRowsOptions = {}): MapRowsResult {
  const issues: ParseIssue[] = [];
  const nonEmpty = matrix.filter((r) => r.some((c) => c.trim()));
  if (nonEmpty.length === 0) {
    return { rows: [], issues: [{ line: 0, message: 'Arquivo vazio.' }], mapping: null, headers: [] };
  }

  let headers = options.headers ?? [];
  let mapping = options.mapping ?? null;
  let bodyStart = 0;

  if (!mapping) {
    // Procura o cabeçalho nas primeiras linhas — extratos costumam ter
    // cabeçalho de banco ("Extrato de conta", "Período") antes da tabela.
    for (let i = 0; i < Math.min(15, nonEmpty.length); i++) {
      const candidate = nonEmpty[i]!;
      if (!looksLikeHeader(candidate)) continue;
      const attempt = mapHeaders(candidate);
      if (attempt) {
        mapping = attempt;
        headers = candidate;
        bodyStart = i + 1;
        break;
      }
    }
  }

  if (!mapping) {
    const skipFirst = looksLikeHeader(nonEmpty[0]!) ? 1 : 0;
    mapping = inferMapping(nonEmpty.slice(skipFirst));
    if (mapping) {
      bodyStart = skipFirst;
      headers = skipFirst ? nonEmpty[0]! : [];
      issues.push({
        line: 0,
        message: 'Cabeçalho não reconhecido. As colunas foram deduzidas pelo conteúdo — confira a prévia.',
      });
    }
  }

  if (!mapping) {
    return {
      rows: [],
      issues: [
        ...issues,
        { line: 0, message: 'Não foi possível identificar as colunas de data, descrição e valor.' },
      ],
      mapping: null,
      headers,
    };
  }

  const body = nonEmpty.slice(bodyStart);
  const dayFirst = detectDayFirst(body.map((r) => r[mapping!.date] ?? ''));
  const rows: ParsedRow[] = [];

  body.forEach((cells, index) => {
    const line = bodyStart + index + 1;
    const rawDate = (cells[mapping!.date] ?? '').trim();
    const description = (cells[mapping!.description] ?? '').trim();

    if (!rawDate && !description) return; // linha em branco

    const date = parseFlexibleDate(rawDate, dayFirst);
    if (!date) {
      // Rodapés como "Saldo final" caem aqui e não devem virar erro barulhento.
      if (description && !cells.some((c) => parseMoney(c) !== null)) return;
      issues.push({ line, message: `Data não reconhecida: "${rawDate}"`, raw: cells.join(' | ') });
      return;
    }

    let amountCents: Cents | null = null;
    if (mapping!.amount !== undefined) {
      amountCents = parseMoney(cells[mapping!.amount] ?? '');
    }
    if (amountCents === null && (mapping!.debit !== undefined || mapping!.credit !== undefined)) {
      const debit = mapping!.debit !== undefined ? parseMoney(cells[mapping!.debit] ?? '') : null;
      const credit = mapping!.credit !== undefined ? parseMoney(cells[mapping!.credit] ?? '') : null;
      if (debit && debit !== 0) amountCents = -Math.abs(debit);
      else if (credit && credit !== 0) amountCents = Math.abs(credit);
    }

    if (amountCents === null) {
      issues.push({ line, message: `Valor não reconhecido na linha ${line}.`, raw: cells.join(' | ') });
      return;
    }
    if (amountCents === 0) return; // linhas de saldo

    const raw: Record<string, string> = {};
    cells.forEach((cell, i) => {
      const key = headers[i]?.trim() || `coluna ${i + 1}`;
      if (cell.trim()) raw[key] = cell.trim();
    });

    const row: ParsedRow = {
      date,
      description: description || 'Lançamento importado',
      amountCents,
      raw,
      sourceLine: line,
    };

    if (mapping!.externalId !== undefined) {
      const id = (cells[mapping!.externalId] ?? '').trim();
      if (id) row.externalId = id;
    }

    const installment =
      extractInstallment(description) ??
      (mapping!.installment !== undefined ? extractInstallment(cells[mapping!.installment] ?? '') : null);
    if (installment) {
      row.installmentNumber = installment.number;
      row.installmentTotal = installment.total;
    }

    rows.push(row);
  });

  return { rows, issues, mapping, headers };
}
