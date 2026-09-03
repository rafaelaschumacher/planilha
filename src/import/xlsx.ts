/**
 * Leitura de XLSX sem dependência de biblioteca de planilha.
 *
 * Um .xlsx é um ZIP com XML dentro. Descompactamos com `fflate` e lemos as
 * partes necessárias. Isso evita trazer uma dependência grande (e com
 * histórico de vulnerabilidades) para dentro de um app que lida com dados
 * financeiros.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { mapMatrix } from './parse';
import type { ParseResult } from './types';

/** 1899-12-30 é a época do Excel (inclui o bug do ano bissexto de 1900). */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

function excelSerialToISO(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 80_000) return null;
  const date = new Date(EXCEL_EPOCH_UTC + Math.round(serial) * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

/** Converte "C7" em índice de coluna 0-based (A=0, B=1 … AA=26). */
function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A';
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/** Formatos de número que indicam data — usados para converter o serial. */
function dateFormatIds(styles: Document | null): Set<number> {
  const ids = new Set<number>([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
  if (!styles) return ids;

  const customDateIds = new Set<number>();
  for (const node of Array.from(styles.getElementsByTagName('numFmt'))) {
    const code = node.getAttribute('formatCode') ?? '';
    const id = Number(node.getAttribute('numFmtId'));
    if (Number.isFinite(id) && /[dmyDMY]/.test(code) && !/[hs]/.test(code.replace(/[^hs]/g, ''))) {
      customDateIds.add(id);
    }
  }

  const result = new Set<number>();
  const cellXfs = styles.getElementsByTagName('cellXfs')[0];
  if (!cellXfs) return ids;
  Array.from(cellXfs.getElementsByTagName('xf')).forEach((xf, index) => {
    const numFmtId = Number(xf.getAttribute('numFmtId') ?? '0');
    if (ids.has(numFmtId) || customDateIds.has(numFmtId)) result.add(index);
  });
  return result;
}

export function parseXlsxStatement(buffer: ArrayBuffer): ParseResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    return {
      format: 'xlsx',
      rows: [],
      issues: [{ line: 0, message: 'Não foi possível abrir o arquivo. Ele está corrompido ou não é um .xlsx.' }],
    };
  }

  const read = (path: string) => (files[path] ? strFromU8(files[path]!) : null);

  // Textos compartilhados ficam num arquivo separado no formato XLSX.
  const sharedStrings: string[] = [];
  const sharedXml = read('xl/sharedStrings.xml');
  if (sharedXml) {
    for (const si of Array.from(parseXml(sharedXml).getElementsByTagName('si'))) {
      sharedStrings.push(
        Array.from(si.getElementsByTagName('t'))
          .map((t) => t.textContent ?? '')
          .join(''),
      );
    }
  }

  // Primeira planilha do arquivo, resolvida pelo relacionamento do workbook.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const workbookXml = read('xl/workbook.xml');
  const relsXml = read('xl/_rels/workbook.xml.rels');
  if (workbookXml && relsXml) {
    const firstSheet = parseXml(workbookXml).getElementsByTagName('sheet')[0];
    const relId = firstSheet?.getAttribute('r:id') ?? firstSheet?.getAttribute('id');
    if (relId) {
      const rel = Array.from(parseXml(relsXml).getElementsByTagName('Relationship')).find(
        (r) => r.getAttribute('Id') === relId,
      );
      const target = rel?.getAttribute('Target');
      if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    }
  }

  const sheetXml = read(sheetPath) ?? read('xl/worksheets/sheet1.xml');
  if (!sheetXml) {
    return { format: 'xlsx', rows: [], issues: [{ line: 0, message: 'Planilha não encontrada dentro do arquivo.' }] };
  }

  const stylesXml = read('xl/styles.xml');
  const dateStyles = dateFormatIds(stylesXml ? parseXml(stylesXml) : null);

  const matrix: string[][] = [];
  for (const rowNode of Array.from(parseXml(sheetXml).getElementsByTagName('row'))) {
    const cells: string[] = [];
    for (const cellNode of Array.from(rowNode.getElementsByTagName('c'))) {
      const index = columnIndex(cellNode.getAttribute('r') ?? 'A');
      const type = cellNode.getAttribute('t');
      const styleIndex = Number(cellNode.getAttribute('s') ?? '-1');

      let value = '';
      if (type === 'inlineStr') {
        value = Array.from(cellNode.getElementsByTagName('t'))
          .map((t) => t.textContent ?? '')
          .join('');
      } else {
        const raw = cellNode.getElementsByTagName('v')[0]?.textContent ?? '';
        if (type === 's') {
          value = sharedStrings[Number(raw)] ?? '';
        } else if (type === 'str' || type === 'e') {
          value = raw;
        } else {
          // Número: pode ser uma data guardada como serial.
          const asDate = dateStyles.has(styleIndex) ? excelSerialToISO(Number(raw)) : null;
          value = asDate ?? raw;
        }
      }

      while (cells.length < index) cells.push('');
      cells[index] = value.trim();
    }
    matrix.push(cells);
  }

  const { rows, issues, mapping, headers } = mapMatrix(matrix);
  const result: ParseResult = { format: 'xlsx', rows, issues };
  if (mapping) result.mapping = mapping;
  if (headers.length) result.headers = headers;
  return result;
}
