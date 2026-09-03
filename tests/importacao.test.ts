import { describe, expect, it } from 'vitest';
import { parseCsvStatement, detectDelimiter, parseCsv } from '../src/import/csv';
import { parseOfxStatement } from '../src/import/ofx';
import { extractInstallment, parseFlexibleDate } from '../src/import/parse';
import { buildImportPreview, materializePreview, type ImportContext } from '../src/import/pipeline';
import { buildTransaction } from '../src/domain/transaction';
import { monthSummary } from '../src/domain/engine';
import { defaultRules } from '../src/domain/seed';
import { categoryMap, makeCard } from './helpers';

const rules = defaultRules();

describe('leitura de datas de arquivo', () => {
  it('lê os formatos usados pelos bancos brasileiros', () => {
    expect(parseFlexibleDate('15/03/2024')).toBe('2024-03-15');
    expect(parseFlexibleDate('15-03-2024')).toBe('2024-03-15');
    expect(parseFlexibleDate('2024-03-15')).toBe('2024-03-15');
    expect(parseFlexibleDate('15/03/24')).toBe('2024-03-15');
    expect(parseFlexibleDate('20240315')).toBe('2024-03-15');
  });

  it('corrige a ordem quando o dia é maior que 12', () => {
    expect(parseFlexibleDate('03/15/2024')).toBe('2024-03-15');
  });

  it('recusa data impossível', () => {
    expect(parseFlexibleDate('31/02/2024')).toBeNull();
    expect(parseFlexibleDate('saldo')).toBeNull();
  });

  it('lê a parcela na descrição', () => {
    expect(extractInstallment('NETFLIX PARCELA 2/6')).toEqual({ number: 2, total: 6 });
    expect(extractInstallment('LOJA X 3 de 10')).toEqual({ number: 3, total: 10 });
    expect(extractInstallment('COMPRA 12/03')).toBeNull(); // isso é data, não parcela
  });
});

describe('CSV', () => {
  it('descobre o separador sozinho', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
  });

  it('respeita aspas e separador dentro do campo', () => {
    const rows = parseCsv('a,"b,c",d\n1,"diz ""oi""",3', ',');
    expect(rows[0]).toEqual(['a', 'b,c', 'd']);
    expect(rows[1]).toEqual(['1', 'diz "oi"', '3']);
  });

  it('lê um extrato com coluna única de valor', () => {
    const csv = [
      'Data;Histórico;Valor',
      '01/03/2024;PAGAMENTO SALARIO;5.400,00',
      '02/03/2024;IFOOD *IFD BRASIL;-89,90',
      '05/03/2024;UBER *TRIP;-24,50',
    ].join('\n');
    const result = parseCsvStatement(csv);
    expect(result.issues).toHaveLength(0);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({ date: '2024-03-01', amountCents: 540_000 });
    expect(result.rows[1]).toMatchObject({ date: '2024-03-02', amountCents: -8_990 });
  });

  it('lê um extrato com colunas separadas de débito e crédito', () => {
    const csv = [
      'Data,Descrição,Débito,Crédito',
      '01/03/2024,Salário,,5400.00',
      '02/03/2024,Mercado,320.50,',
    ].join('\n');
    const result = parseCsvStatement(csv);
    expect(result.rows[0]!.amountCents).toBe(540_000);
    expect(result.rows[1]!.amountCents).toBe(-32_050);
  });

  it('ignora cabeçalho do banco antes da tabela e rodapé de saldo', () => {
    const csv = [
      'Extrato de Conta Corrente',
      'Período: 01/03/2024 a 31/03/2024',
      '',
      'Data;Lançamento;Valor',
      '02/03/2024;MERCADO BOM PRECO;-320,50',
      'SALDO FINAL;;',
    ].join('\n');
    const result = parseCsvStatement(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.description).toBe('MERCADO BOM PRECO');
  });

  it('deduz as colunas quando não há cabeçalho', () => {
    const csv = ['01/03/2024;PADARIA DO ZE;-18,00', '02/03/2024;POSTO SHELL;-150,00'].join('\n');
    const result = parseCsvStatement(csv);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.description).toBe('PADARIA DO ZE');
    expect(result.issues[0]?.message).toMatch(/deduzidas/);
  });

  it('relata a linha problemática em vez de descartá-la em silêncio', () => {
    const csv = ['Data;Histórico;Valor', '99/99/2024;LINHA QUEBRADA;-10,00'].join('\n');
    const result = parseCsvStatement(csv);
    expect(result.rows).toHaveLength(0);
    expect(result.issues[0]!.message).toMatch(/Data não reconhecida/);
  });
});

describe('OFX', () => {
  const ofx = `
OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<BANKACCTFROM><BANKID>001<ACCTID>12345-6</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240302120000[-3:BRT]<TRNAMT>-89.90<FITID>202403020001<MEMO>IFOOD *IFD BRASIL</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240301<TRNAMT>5400.00<FITID>202403010001<MEMO>PAGAMENTO SALARIO</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  it('lê o formato SGML antigo com tags não fechadas', () => {
    const result = parseOfxStatement(ofx);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      date: '2024-03-02',
      amountCents: -8_990,
      externalId: '202403020001',
      description: 'IFOOD *IFD BRASIL',
    });
  });

  it('lê o formato XML novo', () => {
    const xml = `<OFX><STMTTRN><DTPOSTED>20240305</DTPOSTED><TRNAMT>-24.50</TRNAMT><FITID>ABC1</FITID><NAME>UBER TRIP</NAME></STMTTRN></OFX>`;
    const result = parseOfxStatement(xml);
    expect(result.rows[0]).toMatchObject({ date: '2024-03-05', amountCents: -2_450, externalId: 'ABC1' });
  });

  it('identifica a conta do arquivo', () => {
    expect(parseOfxStatement(ofx).detectedAccount).toBe('001 · 12345-6');
  });

  it('avisa quando não encontra transação', () => {
    expect(parseOfxStatement('<OFX></OFX>').issues[0]!.message).toMatch(/Nenhuma transação/);
  });
});

describe('assistente de importação', () => {
  const contexto = (over: Partial<ImportContext> = {}): ImportContext => ({
    target: { type: 'account', accountId: 'acc' },
    existing: [],
    rules,
    ...over,
  });

  const extrato = parseCsvStatement(
    [
      'Data;Histórico;Valor',
      '01/03/2024;PAGAMENTO SALARIO;5.400,00',
      '02/03/2024;IFOOD *IFD BRASIL;-89,90',
      '05/03/2024;UBER *TRIP SAO PAULO;-24,50',
      '10/03/2024;XPTO PAGAMENTOS 4471;-55,00',
    ].join('\n'),
  );

  it('identifica entrada como receita e saída como despesa', () => {
    const preview = buildImportPreview(extrato, contexto());
    expect(preview.rows[0]!.kind).toBe('income');
    expect(preview.rows[1]!.kind).toBe('expense');
    expect(preview.rows.every((r) => r.amountCents > 0)).toBe(true); // sinal virou tipo
  });

  it('categoriza sozinho o que reconhece', () => {
    const preview = buildImportPreview(extrato, contexto());
    expect(preview.rows[1]!.categoryId).toBe('cat-delivery');
    expect(preview.rows[2]!.categoryId).toBe('cat-app-transporte');
    expect(preview.rows[1]!.categorySource).toBe('rule');
  });

  it('marca "revisar" o que não reconhece, sem chutar', () => {
    const preview = buildImportPreview(extrato, contexto());
    const desconhecido = preview.rows[3]!;
    expect(desconhecido.categoryId).toBeUndefined();
    expect(desconhecido.needsReview).toBe(true);
    expect(desconhecido.selected).toBe(true); // continua importável
  });

  it('sinaliza duplicidade e já desmarca a linha, sem apagar nada', () => {
    const jaExiste = buildTransaction({
      kind: 'expense', date: '2024-03-02', description: 'IFOOD *IFD BRASIL',
      amountCents: 8_990, accountId: 'acc',
    });
    const preview = buildImportPreview(extrato, contexto({ existing: [jaExiste] }));
    const linha = preview.rows[1]!;
    expect(linha.duplicateScore).toBeGreaterThanOrEqual(0.9);
    expect(linha.selected).toBe(false);
    expect(linha.warnings.join(' ')).toMatch(/duplicidade/i);
    // O lançamento existente continua intacto.
    expect(preview.rows).toHaveLength(4);
  });

  it('avisa quando o arquivo inteiro já foi importado', () => {
    const existing = materializePreview(buildImportPreview(extrato, contexto()), contexto(), 'lote-1');
    const segundaVez = buildImportPreview(extrato, contexto({ existing }));
    expect(segundaVez.batchWarning).toMatch(/já foi importado/);
    expect(segundaVez.rows.every((r) => !r.selected)).toBe(true);
  });

  it('NUNCA importa nada sem seleção', () => {
    const preview = buildImportPreview(extrato, contexto());
    preview.rows.forEach((r) => (r.selected = false));
    expect(materializePreview(preview, contexto(), 'lote')).toHaveLength(0);
  });

  it('alerta sobre linha que parece transferência', () => {
    const csv = parseCsvStatement('Data;Histórico;Valor\n03/03/2024;TED ENVIADA JOAO;-200,00');
    const preview = buildImportPreview(csv, contexto());
    expect(preview.rows[0]!.warnings.join(' ')).toMatch(/transferência/i);
  });
});

describe('importação de fatura de cartão', () => {
  const card = makeCard({ id: 'card', closingDay: 20, dueDay: 28 });
  const contexto: ImportContext = {
    target: { type: 'card', cardId: 'card', card },
    existing: [],
    rules,
  };

  const fatura = parseCsvStatement(
    [
      'Data;Descrição;Valor',
      '02/03/2024;MERCADO BOM PRECO;450,00',
      '05/03/2024;NETFLIX.COM;55,90',
      '08/03/2024;LOJA MOVEIS PARCELA 2/6;200,00',
      '10/03/2024;PAGAMENTO RECEBIDO;-1.200,00',
      '12/03/2024;ESTORNO COMPRA CANCELADA;-90,00',
    ].join('\n'),
  );

  it('a linha de pagamento da fatura vem DESMARCADA para não duplicar', () => {
    const preview = buildImportPreview(fatura, contexto);
    const pagamento = preview.rows.find((r) => r.description.includes('PAGAMENTO RECEBIDO'))!;
    expect(pagamento.kind).toBe('card_payment');
    expect(pagamento.selected).toBe(false);
    expect(pagamento.warnings.join(' ')).toMatch(/duas vezes/);
  });

  it('estorno vira estorno, não receita', () => {
    const preview = buildImportPreview(fatura, contexto);
    const estorno = preview.rows.find((r) => r.description.includes('ESTORNO'))!;
    expect(estorno.kind).toBe('chargeback');
  });

  it('reconhece a parcela na descrição sem inventar as outras', () => {
    const preview = buildImportPreview(fatura, contexto);
    const parcela = preview.rows.find((r) => r.description.includes('PARCELA'))!;
    expect(parcela.parsed.installmentNumber).toBe(2);
    expect(parcela.parsed.installmentTotal).toBe(6);
    // Só a parcela do mês entra — as outras virão nas próximas faturas.
    const gravados = materializePreview(preview, contexto, 'lote');
    expect(gravados.filter((t) => t.installmentTotal === 6)).toHaveLength(1);
  });

  it('importar a fatura NÃO infla a despesa com o pagamento', () => {
    const preview = buildImportPreview(fatura, contexto);
    const gravados = materializePreview(preview, contexto, 'lote');
    const resumo = monthSummary('2024-03', gravados, categoryMap);
    // 450 + 55,90 + 200 de compras, menos 90 de estorno. O pagamento de
    // R$ 1.200 ficou de fora porque a linha veio desmarcada.
    expect(resumo.expenseCents).toBe(45_000 + 5_590 + 20_000 - 9_000);
    expect(resumo.cardPaymentCents).toBe(0);
  });
});
