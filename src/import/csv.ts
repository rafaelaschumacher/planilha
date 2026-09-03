/** Leitura de CSV, incluindo aspas, quebras de linha dentro do campo e BOM. */

import { mapMatrix } from './parse';
import type { ParseResult } from './types';

const DELIMITERS = [',', ';', '\t', '|'] as const;

/** Escolhe o separador que produz o maior número de colunas de forma consistente. */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  if (lines.length === 0) return ',';

  let best = ',';
  let bestScore = -1;
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => splitLine(line, delimiter).length);
    const max = Math.max(...counts);
    if (max < 2) continue;
    // Consistência: quantas linhas têm o número de colunas mais comum.
    const mode = counts.filter((c) => c === max).length / counts.length;
    const score = max * mode;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

function splitLine(line: string, delimiter: string): string[] {
  return parseCsv(line, delimiter)[0] ?? [];
}

/** Analisador CSV conforme RFC 4180: aspas duplas escapam aspas. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\r') {
      // tratado junto com o \n seguinte
    } else {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseCsvStatement(text: string): ParseResult {
  const clean = text.replace(/^﻿/, ''); // remove BOM do Excel
  const delimiter = detectDelimiter(clean);
  const matrix = parseCsv(clean, delimiter).map((row) => row.map((cell) => cell.trim()));
  const { rows, issues, mapping, headers } = mapMatrix(matrix);

  const result: ParseResult = { format: 'csv', rows, issues };
  if (mapping) result.mapping = mapping;
  if (headers.length) result.headers = headers;
  return result;
}
