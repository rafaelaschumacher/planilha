// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseXlsxStatement } from '../src/import/xlsx';

/** Monta um .xlsx mínimo, do jeito que o Excel realmente grava. */
function buildXlsx(rows: (string | number)[][], dateColumns: number[] = []): ArrayBuffer {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const intern = (value: string) => {
    if (!sharedIndex.has(value)) {
      sharedIndex.set(value, shared.length);
      shared.push(value);
    }
    return sharedIndex.get(value)!;
  };

  const colLetter = (i: number) => String.fromCharCode(65 + i);
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${colLetter(c)}${r + 1}`;
          if (typeof value === 'number') {
            // Estilo 1 = formato de data; estilo 0 = número comum.
            const style = dateColumns.includes(c) ? ' s="1"' : '';
            return `<c r="${ref}"${style}><v>${value}</v></c>`;
          }
          return `<c r="${ref}" t="s"><v>${intern(value)}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Extrato" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/sharedStrings.xml': strToU8(
      `<?xml version="1.0"?><sst count="${shared.length}">${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
    ),
    'xl/styles.xml': strToU8(
      '<?xml version="1.0"?><styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
    ),
  };

  const zipped = zipSync(files);
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}

describe('XLSX', () => {
  it('lê uma planilha com datas em texto', () => {
    const file = buildXlsx([
      ['Data', 'Descrição', 'Valor'],
      ['01/03/2024', 'PAGAMENTO SALARIO', '5400,00'],
      ['02/03/2024', 'MERCADO BOM PRECO', '-320,50'],
    ]);
    const result = parseXlsxStatement(file);
    expect(result.issues).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ date: '2024-03-01', amountCents: 540_000 });
    expect(result.rows[1]).toMatchObject({ date: '2024-03-02', amountCents: -32_050 });
  });

  it('converte data guardada como número de série do Excel', () => {
    // 45352 = 01/03/2024 no calendário do Excel.
    const file = buildXlsx(
      [
        ['Data', 'Descrição', 'Valor'],
        [45352, 'NETFLIX.COM', '-55,90'],
      ],
      [0],
    );
    const result = parseXlsxStatement(file);
    expect(result.rows[0]!.date).toBe('2024-03-01');
    expect(result.rows[0]!.amountCents).toBe(-5_590);
  });

  it('avisa quando o arquivo não é uma planilha válida', () => {
    const lixo = new TextEncoder().encode('isso não é um xlsx');
    const result = parseXlsxStatement(lixo.buffer as ArrayBuffer);
    expect(result.rows).toHaveLength(0);
    expect(result.issues[0]!.message).toMatch(/não é um \.xlsx/);
  });
});
