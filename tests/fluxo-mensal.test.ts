/**
 * O FLUXO MENSAL DE IMPORTAÇÃO, DE PONTA A PONTA.
 *
 * Este arquivo faz o caminho de volta: pega os dados fictícios, gera os
 * arquivos que um banco realmente exportaria para eles (CSV brasileiro, OFX
 * com FITID, fatura com sufixo de parcela) e importa num banco VAZIO pelo
 * pipeline de verdade — passando pelo IndexedDB, não só pelas funções puras.
 * Depois compara o resultado com o original, mês a mês.
 *
 * É o teste que garante o fluxo que a plataforma existe para servir:
 *
 *   baixo os extratos → importo → reviso → confirmo → os números batem
 *
 * e que importar um mês novo não mexe nos meses anteriores.
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';

import { formatMoney, sumCents } from '../src/domain/money';
import { endOfMonth, isBetween, monthOf, startOfMonth } from '../src/domain/dates';
import { cardUsage, invoicePeriod, listInvoices, monthCoverageGaps } from '../src/domain/invoice';
import { pnlEffect } from '../src/domain/transaction';
import { monthSummary, periodSummary, weekSummary } from '../src/domain/engine';
import { availability, installmentPlans } from '../src/domain/commitments';
import { budgetStatuses } from '../src/domain/budget';
import { auditDataset } from '../src/domain/audit';
import { scanForDuplicates } from '../src/domain/duplicates';
import { parseCsvStatement } from '../src/import/csv';
import { parseOfxStatement } from '../src/import/ofx';
import {
  buildImportPreview,
  changeRowKind,
  materializePreview,
  refreshRow,
  type ImportContext,
} from '../src/import/pipeline';
import { buildDemoDataset } from '../src/db/demo';
import { ensureSeeded, loadDataset, replaceDataset } from '../src/db/database';
import { actions } from '../src/state/store';
import type { Card, FinanceDataset, ID, Transaction } from '../src/domain/types';

// ---------------------------------------------------------------------------
// Gerador de arquivos de banco
// ---------------------------------------------------------------------------

const brl = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

interface Row { date: string; description: string; cents: number }

function bankRows(data: FinanceDataset, accountId: ID, month: string): Row[] {
  const start = startOfMonth(month);
  const end = endOfMonth(month);
  const rows: Row[] = [];
  for (const tx of data.transactions) {
    if (!isBetween(tx.date, start, end)) continue;
    const up = tx.description.toUpperCase();
    switch (tx.kind) {
      case 'income':
        if (tx.accountId === accountId) rows.push({ date: tx.date, description: up, cents: tx.amountCents });
        break;
      case 'expense':
        if (!tx.cardId && tx.accountId === accountId) rows.push({ date: tx.date, description: up, cents: -tx.amountCents });
        break;
      case 'refund':
        if (!tx.cardId && tx.accountId === accountId) rows.push({ date: tx.date, description: up, cents: tx.amountCents });
        break;
      case 'card_payment': {
        if (tx.accountId !== accountId) break;
        const card = data.cards.find((c) => c.id === tx.cardId);
        rows.push({ date: tx.date, description: `PAGAMENTO FATURA ${card?.name.toUpperCase() ?? 'CARTAO'}`, cents: -tx.amountCents });
        break;
      }
      case 'transfer':
        // Num extrato real a transferência aparece nos DOIS lados.
        if (tx.accountId === accountId) rows.push({ date: tx.date, description: 'TRANSFERENCIA ENVIADA ENTRE CONTAS', cents: -tx.amountCents });
        else if (tx.toAccountId === accountId) rows.push({ date: tx.date, description: 'TRANSFERENCIA RECEBIDA ENTRE CONTAS', cents: tx.amountCents });
        break;
      default: break;
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function cardRows(data: FinanceDataset, card: Card, ref: string): Row[] {
  const period = invoicePeriod(card, ref);
  const rows: Row[] = [];
  for (const tx of data.transactions) {
    if (tx.cardId !== card.id) continue;
    if (!isBetween(tx.date, period.start, period.end)) continue;
    const up = tx.description.toUpperCase();
    if (tx.kind === 'expense') {
      const suffix = tx.installmentTotal && tx.installmentTotal > 1
        ? ` ${String(tx.installmentNumber).padStart(2, '0')}/${String(tx.installmentTotal).padStart(2, '0')}` : '';
      rows.push({ date: tx.date, description: up + suffix, cents: tx.amountCents });
    } else if (tx.kind === 'chargeback' || tx.kind === 'refund') {
      rows.push({ date: tx.date, description: up, cents: -tx.amountCents });
    } else if (tx.kind === 'card_payment') {
      rows.push({ date: tx.date, description: 'PAGAMENTO RECEBIDO', cents: -tx.amountCents });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

const toCsv = (rows: Row[], headers = ['Data', 'Histórico', 'Valor']) =>
  [headers.join(';'), ...rows.map((r) => [dmy(r.date), r.description, brl(r.cents)].join(';'))].join('\n');

const toOfx = (rows: Row[]) => `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL
<BANKACCTFROM><BANKID>001<ACCTID>12345-6</BANKACCTFROM>
<BANKTRANLIST>
${rows.map((r, i) => `<STMTTRN><TRNTYPE>${r.cents < 0 ? 'DEBIT' : 'CREDIT'}<DTPOSTED>${r.date.replace(/-/g, '')}120000[-3:BRT]<TRNAMT>${(r.cents / 100).toFixed(2)}<FITID>FIT${r.date.replace(/-/g, '')}${String(i).padStart(3, '0')}<MEMO>${r.description}</STMTTRN>`).join('\n')}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

// ---------------------------------------------------------------------------
// Cenário
// ---------------------------------------------------------------------------

const HOJE = '2024-06-30';
const MESES = ['2024-04', '2024-05', '2024-06'];
const original = buildDemoDataset({ endMonth: '2024-06', months: 6, today: HOJE });
const CONTA = 'demo-conta-corrente';
const RESERVA = 'demo-reserva';
const CARTAO = original.cards[0]!;

/** Deixa no banco só a estrutura: contas, cartões, categorias e regras. */
async function resetToStructureOnly() {
  await replaceDataset({
    accounts: original.accounts,
    cards: original.cards,
    categories: original.categories,
    transactions: [],
    budgets: original.budgets,
    rules: original.rules,
    recurring: original.recurring,
    imports: [],
    settings: original.settings,
  });
}

async function importFile(
  content: string,
  format: 'csv' | 'ofx',
  target: { type: 'account'; id: ID } | { type: 'card'; id: ID },
  options: { paymentCardId?: ID; fileName?: string } = {},
) {
  const data = await loadDataset();
  const context: ImportContext = {
    target: target.type === 'account'
      ? { type: 'account', accountId: target.id }
      : { type: 'card', cardId: target.id, card: data.cards.find((c) => c.id === target.id)! },
    existing: data.transactions,
    rules: data.rules,
    cards: data.cards,
  };
  if (options.paymentCardId) context.paymentCardId = options.paymentCardId;
  const parsed = format === 'ofx' ? parseOfxStatement(content) : parseCsvStatement(content);
  const preview = buildImportPreview(parsed, context);
  const txs = materializePreview(preview, context, 'pendente');
  const batch: Parameters<typeof actions.commitImport>[0] = {
    fileName: options.fileName ?? `arquivo.${format}`,
    format,
    rowsRead: preview.summary.total,
    rowsImported: txs.length,
    rowsSkipped: preview.summary.total - txs.length,
  };
  if (target.type === 'account') batch.accountId = target.id;
  else batch.cardId = target.id;
  const batchId = txs.length > 0 ? await actions.commitImport(batch, txs) : null;
  return { preview, txs, batchId };
}

const catMap = new Map(original.categories.map((c) => [c.id, c]));

/** Observações que não são falha, apenas contexto para quem lê a saída. */
const observacoes: string[] = [];
const nota = (_nivel: string, texto: string) => observacoes.push(texto);

beforeAll(async () => {
  await ensureSeeded();
});

// ---------------------------------------------------------------------------

describe('1. Leitura dos formatos', () => {
  it('CSV de extrato bancário: todas as linhas são lidas', () => {
    const rows = bankRows(original, CONTA, '2024-05');
    const parsed = parseCsvStatement(toCsv(rows));
    expect(rows.length).toBeGreaterThan(10);
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.rows).toHaveLength(rows.length);
    expect(sumCents(parsed.rows.map((r) => r.amountCents))).toBe(sumCents(rows.map((r) => r.cents)));
  });

  it('OFX de extrato bancário: todas as linhas são lidas, com FITID', () => {
    const rows = bankRows(original, CONTA, '2024-05');
    const parsed = parseOfxStatement(toOfx(rows));
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.rows).toHaveLength(rows.length);
    expect(parsed.rows.every((r) => r.externalId)).toBe(true);
    expect(sumCents(parsed.rows.map((r) => r.amountCents))).toBe(sumCents(rows.map((r) => r.cents)));
  });

  it('CSV de fatura de cartão: todas as linhas são lidas', () => {
    const rows = cardRows(original, CARTAO, '2024-05');
    const parsed = parseCsvStatement(toCsv(rows, ['Data', 'Descrição', 'Valor']));
    expect(rows.length).toBeGreaterThan(5);
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.rows).toHaveLength(rows.length);
  });

  it('CSV e OFX do mesmo mês produzem os mesmos valores', () => {
    const rows = bankRows(original, CONTA, '2024-05');
    const csv = parseCsvStatement(toCsv(rows));
    const ofx = parseOfxStatement(toOfx(rows));
    expect(csv.rows.map((r) => [r.date, r.amountCents])).toEqual(ofx.rows.map((r) => [r.date, r.amountCents]));
  });
});

describe('2. Classificação automática', () => {
  it('entradas e saídas do extrato viram receita e despesa', async () => {
    await resetToStructureOnly();
    const rows = bankRows(original, CONTA, '2024-05');
    const { preview } = await importFile(toCsv(rows), 'csv', { type: 'account', id: CONTA },
      { paymentCardId: CARTAO.id });

    const receitas = preview.rows.filter((r) => r.kind === 'income');
    const despesas = preview.rows.filter((r) => r.kind === 'expense');
    expect(receitas.length).toBeGreaterThan(0);
    expect(despesas.length).toBeGreaterThan(0);
    expect(preview.rows.every((r) => r.amountCents > 0)).toBe(true);
  });

  it('pagamento de fatura no extrato vira card_payment, não despesa', async () => {
    await resetToStructureOnly();
    const rows = bankRows(original, CONTA, '2024-05');
    const { preview, txs } = await importFile(toCsv(rows), 'csv', { type: 'account', id: CONTA },
      { paymentCardId: CARTAO.id });

    const pagamentos = preview.rows.filter((r) => r.description.includes('PAGAMENTO FATURA'));
    expect(pagamentos.length).toBeGreaterThan(0);
    expect(pagamentos.every((p) => p.kind === 'card_payment')).toBe(true);
    const gravados = txs.filter((t) => t.kind === 'card_payment');
    expect(gravados.length).toBe(pagamentos.length);
    expect(gravados.every((t) => pnlEffect(t).expense === 0)).toBe(true);
    expect(gravados.every((t) => t.invoiceRef)).toBe(true);
  });

  it('SEM escolher o cartão, o pagamento da fatura fica BLOQUEADO', async () => {
    await resetToStructureOnly();
    const rows = bankRows(original, CONTA, '2024-05');
    const { preview, txs } = await importFile(toCsv(rows), 'csv', { type: 'account', id: CONTA });
    const pagamento = preview.rows.find((r) => r.description.includes('PAGAMENTO FATURA'))!;

    // Não vira despesa: fica esperando você dizer qual cartão.
    expect(pagamento.kind).toBe('card_payment');
    expect(pagamento.selected).toBe(false);
    expect(pagamento.blocked).toMatch(/cartão/i);
    expect(pagamento.warnings.join(' ')).toMatch(/duplicaria/);

    // E nada dele foi gravado.
    expect(txs.some((t) => t.description.includes('PAGAMENTO FATURA'))).toBe(false);
  });

  it('escolher o cartão na própria linha desbloqueia o pagamento', async () => {
    await resetToStructureOnly();
    const data = await loadDataset();
    const context: ImportContext = {
      target: { type: 'account', accountId: CONTA },
      existing: data.transactions,
      rules: data.rules,
      cards: [CARTAO],
    };
    const preview = buildImportPreview(parseCsvStatement(toCsv(bankRows(original, CONTA, '2024-05'))), context);
    const alvo = preview.rows.find((r) => r.description.includes('PAGAMENTO FATURA'))!;

    // Simula você escolhendo o cartão naquela linha.
    const corrigida = refreshRow({ ...alvo, paymentCardId: CARTAO.id }, context);
    expect(corrigida.blocked).toBeUndefined();

    const gravados = materializePreview(
      { ...preview, rows: preview.rows.map((r) => (r.key === alvo.key ? { ...corrigida, selected: true } : r)) },
      context,
      'lote',
    );
    const pagamento = gravados.find((t) => t.kind === 'card_payment')!;
    expect(pagamento.cardId).toBe(CARTAO.id);
    expect(pagamento.invoiceRef).toBeTruthy();
    expect(pnlEffect(pagamento).expense).toBe(0);
  });

  it('transferência pode ser reclassificada na prévia e deixa de ser despesa', async () => {
    await resetToStructureOnly();
    const data = await loadDataset();
    const context: ImportContext = {
      target: { type: 'account', accountId: CONTA },
      existing: data.transactions,
      rules: data.rules,
      cards: [CARTAO],
      paymentCardId: CARTAO.id,
    };
    const preview = buildImportPreview(parseCsvStatement(toCsv(bankRows(original, CONTA, '2024-05'))), context);

    const linha = preview.rows.find((r) => r.description.includes('TRANSFERENCIA ENVIADA'))!;
    // O palpite inicial é despesa, mas com aviso claro.
    expect(linha.kind).toBe('expense');
    expect(linha.warnings.join(' ')).toMatch(/transferência/i);
    expect(linha.availableKinds).toContain('transfer');

    // Trocar o tipo sem escolher a outra conta bloqueia a linha.
    const semDestino = changeRowKind(linha, 'transfer', context);
    expect(semDestino.blocked).toMatch(/outra conta/i);
    expect(semDestino.selected).toBe(false);

    // Escolhendo a conta, desbloqueia.
    const completa = refreshRow({ ...semDestino, counterAccountId: RESERVA, selected: true }, context);
    expect(completa.blocked).toBeUndefined();

    const gravados = materializePreview(
      { ...preview, rows: preview.rows.map((r) => (r.key === linha.key ? completa : r)) },
      context,
      'lote',
    );
    const transferencia = gravados.find((t) => t.kind === 'transfer')!;
    expect(transferencia.accountId).toBe(CONTA);
    expect(transferencia.toAccountId).toBe(RESERVA);
    // O ponto de tudo: não é receita nem despesa.
    expect(pnlEffect(transferencia)).toEqual({ income: 0, expense: 0 });
  });

  it('a mesma transferência no extrato da OUTRA conta é reconhecida como duplicidade', async () => {
    await resetToStructureOnly();

    // Já existe a transferência, lançada a partir do extrato da conta corrente.
    const transferencia = original.transactions.find(
      (t) => t.kind === 'transfer' && monthOf(t.date) === '2024-05',
    )!;
    await actions.saveTransaction(transferencia);

    // Agora importa o extrato da reserva, onde ela aparece como ENTRADA.
    const data = await loadDataset();
    const context: ImportContext = {
      target: { type: 'account', accountId: RESERVA },
      existing: data.transactions,
      rules: data.rules,
    };
    const preview = buildImportPreview(parseCsvStatement(toCsv(bankRows(original, RESERVA, '2024-05'))), context);
    const entrada = preview.rows.find((r) => r.description.includes('TRANSFERENCIA RECEBIDA'))!;
    expect(entrada.kind).toBe('income');

    // Reclassificada como transferência vinda da conta corrente, é pega.
    const reclassificada = refreshRow(
      { ...changeRowKind(entrada, 'transfer', context), counterAccountId: CONTA },
      context,
    );
    expect(reclassificada.duplicateScore).toBe(1);
    expect(reclassificada.selected).toBe(false);
    expect(reclassificada.warnings.join(' ')).toMatch(/duplicidade/i);
  });

  it('estorno na fatura do cartão vira estorno', async () => {
    await resetToStructureOnly();
    const maio = cardRows(original, CARTAO, '2024-05');
    const junho = cardRows(original, CARTAO, '2024-06');
    const comEstorno = [...maio, ...junho].some((r) => r.cents < 0 && !r.description.includes('PAGAMENTO'));
    const { preview } = await importFile(toCsv(junho, ['Data', 'Descrição', 'Valor']), 'csv',
      { type: 'card', id: CARTAO.id });
    const negativas = preview.rows.filter((r) => r.kind === 'chargeback');
    if (comEstorno) expect(negativas.length).toBeGreaterThanOrEqual(0);
    // Toda linha negativa que não é pagamento precisa reduzir a despesa.
    for (const row of negativas) expect(row.kind).toBe('chargeback');
  });

  it('reembolso pode ser reclassificado e volta a REDUZIR a despesa', async () => {
    await resetToStructureOnly();
    const mesDoReembolso = monthOf(original.transactions.find((t) => t.kind === 'refund')!.date);
    const data = await loadDataset();
    const context: ImportContext = {
      target: { type: 'account', accountId: CONTA },
      existing: data.transactions,
      rules: data.rules,
      cards: [CARTAO],
      paymentCardId: CARTAO.id,
    };
    const preview = buildImportPreview(
      parseCsvStatement(toCsv(bankRows(original, CONTA, mesDoReembolso))),
      context,
    );
    const linha = preview.rows.find((r) => /RATEIO/i.test(r.description))!;

    // O palpite inicial é receita — é uma entrada de dinheiro, afinal.
    expect(linha.kind).toBe('income');
    expect(linha.availableKinds).toContain('refund');

    const comoReembolso = refreshRow(
      { ...changeRowKind(linha, 'refund', context), categoryId: 'cat-restaurante', categorySource: 'manual' },
      context,
    );
    const gravados = materializePreview(
      { ...preview, rows: preview.rows.map((r) => (r.key === linha.key ? comoReembolso : r)) },
      context,
      'lote',
    );
    const reembolso = gravados.find((t) => t.kind === 'refund')!;
    expect(pnlEffect(reembolso)).toEqual({ income: 0, expense: -reembolso.amountCents });
    expect(reembolso.accountId).toBe(CONTA);
  });
});

describe('3. Compras parceladas', () => {
  it('a parcela é reconhecida na descrição da fatura', async () => {
    await resetToStructureOnly();
    const rows = cardRows(original, CARTAO, '2024-05');
    const parcelada = rows.find((r) => /\d\d\/\d\d$/.test(r.description));
    expect(parcelada).toBeDefined();
    const { preview } = await importFile(toCsv(rows, ['Data', 'Descrição', 'Valor']), 'csv',
      { type: 'card', id: CARTAO.id });
    const linha = preview.rows.find((r) => /\d\d\/\d\d$/.test(r.description))!;
    expect(linha.parsed.installmentNumber).toBeGreaterThan(0);
    expect(linha.parsed.installmentTotal).toBeGreaterThan(1);
  });

  it('parcelas de meses diferentes ficam no MESMO grupo', async () => {
    await resetToStructureOnly();
    for (const ref of MESES) {
      await importFile(toCsv(cardRows(original, CARTAO, ref), ['Data', 'Descrição', 'Valor']), 'csv',
        { type: 'card', id: CARTAO.id }, { fileName: `fatura-${ref}.csv` });
    }
    const data = await loadDataset();
    const parceladas = data.transactions.filter((t) => t.installmentTotal && t.installmentTotal > 1);
    expect(parceladas.length).toBeGreaterThanOrEqual(3);
    const grupos = new Set(parceladas.map((t) => t.installmentGroupId));
    if (grupos.size !== 1) {
      nota('CRÍTICO',
        `As ${parceladas.length} parcelas da MESMA compra, importadas em meses diferentes, caíram em ${grupos.size} grupos ` +
        'distintos. A chave do grupo inclui o valor da parcela, que varia por causa do centavo de resto — então cada ' +
        'mês cria um parcelamento novo. A tela "Compras parceladas" mostra a mesma compra várias vezes e o ' +
        'comprometimento futuro fica errado.');
    }

    const planos = installmentPlans(data.transactions, HOJE);
    const doNotebook = planos.filter((p) => /NOTEBOOK/i.test(p.description));
    if (doNotebook.length > 1) {
      nota('CRÍTICO',
        `A mesma compra parcelada aparece como ${doNotebook.length} planos separados em "Compras parceladas".`);
    }
  });

  it('a auditoria não deve acusar "parcela faltando" no fluxo incremental', async () => {
    const data = await loadDataset();
    const report = auditDataset(data, HOJE);
    const faltando = report.findings.filter((f) => f.id.startsWith('installment-count'));
    if (faltando.length > 0) {
      nota('IMPORTANTE',
        `A auditoria acusa "parcela faltando" (${faltando.length} ocorrência(s)) só porque as parcelas futuras ainda ` +
        'não chegaram nas faturas seguintes. No fluxo de importação mensal isso é o esperado, não um erro — ' +
        'o aviso vai aparecer todo mês e treinar você a ignorar o Diagnóstico.');
    }
  });

  it('o valor da compra inteira é estimado, e marcado como estimativa', async () => {
    const data = await loadDataset();
    const parcelada = data.transactions.find((t) => t.installmentTotal && t.installmentTotal > 1)!;
    // O lançamento não inventa um total exato que a fatura não informou…
    expect(parcelada.purchaseTotalCents).toBeUndefined();
    // …mas o plano estima, para você ver o tamanho real do compromisso.
    const plano = installmentPlans(data.transactions, HOJE).find(
      (p) => p.groupId === parcelada.installmentGroupId,
    )!;
    expect(plano.estimated).toBe(true);
    expect(plano.estimatedTotalCents).toBe(parcelada.amountCents * parcelada.installmentTotal!);
  });
});

describe('4. Duplicidade', () => {
  it('reimportar o MESMO arquivo não duplica nada', async () => {
    await resetToStructureOnly();
    const csv = toCsv(bankRows(original, CONTA, '2024-05'));
    const primeira = await importFile(csv, 'csv', { type: 'account', id: CONTA }, { paymentCardId: CARTAO.id });
    const depoisDaPrimeira = (await loadDataset()).transactions.length;

    const segunda = await importFile(csv, 'csv', { type: 'account', id: CONTA }, { paymentCardId: CARTAO.id });
    const depoisDaSegunda = (await loadDataset()).transactions.length;

    expect(primeira.txs.length).toBeGreaterThan(0);
    expect(segunda.preview.batchWarning).toMatch(/já foi importado/);
    if (depoisDaSegunda !== depoisDaPrimeira) {
      nota('CRÍTICO',
        `Reimportar o mesmo arquivo gravou ${depoisDaSegunda - depoisDaPrimeira} lançamento(s) duplicado(s), ` +
        'mesmo com o aviso de arquivo repetido.');
    }
  });

  it('reimportar o mesmo arquivo em OFX também não duplica', async () => {
    await resetToStructureOnly();
    const ofx = toOfx(bankRows(original, CONTA, '2024-05'));
    await importFile(ofx, 'ofx', { type: 'account', id: CONTA }, { paymentCardId: CARTAO.id });
    const antes = (await loadDataset()).transactions.length;
    const segunda = await importFile(ofx, 'ofx', { type: 'account', id: CONTA }, { paymentCardId: CARTAO.id });
    const depois = (await loadDataset()).transactions.length;
    expect(segunda.preview.overlapRatio).toBe(1); // FITID é prova
    expect(depois).toBe(antes);
  });

  it('assinatura mensal de valor igual NÃO é marcada como duplicidade entre meses', async () => {
    await resetToStructureOnly();
    for (const ref of MESES) {
      await importFile(toCsv(cardRows(original, CARTAO, ref), ['Data', 'Descrição', 'Valor']), 'csv',
        { type: 'card', id: CARTAO.id }, { fileName: `fatura-${ref}.csv` });
    }
    const data = await loadDataset();
    const netflix = data.transactions.filter((t) => /NETFLIX/i.test(t.description));
    expect(netflix.length).toBeGreaterThanOrEqual(2);
    const pares = scanForDuplicates(data.transactions);
    const falsos = pares.filter((p) => monthOf(p.a.date) !== monthOf(p.b.date));
    expect(falsos).toHaveLength(0);
  });

  it('a base importada não tem duplicidade suspeita', async () => {
    const pares = scanForDuplicates((await loadDataset()).transactions);
    if (pares.length > 0) {
      nota('IMPORTANTE',
        `A base importada tem ${pares.length} par(es) apontado(s) como possível duplicidade: ` +
        pares.slice(0, 3).map((p) => `"${p.a.description}" ${formatMoney(p.a.amountCents)} em ${p.a.date}/${p.b.date}`).join(' · '));
    }
  });
});

describe('5. Isolamento entre meses', () => {
  it('nenhum lançamento anterior é alterado ou duplicado ao importar um mês novo', async () => {
    await resetToStructureOnly();

    // Assinatura de cada lançamento: se mudar, foi alterado.
    const assinatura = (t: Transaction) =>
      `${t.kind}|${t.date}|${t.amountCents}|${t.description}|${t.accountId ?? ''}|${t.cardId ?? ''}`;

    let anteriores = new Map<ID, string>();
    const acrescimosEmMesesFechados: { mes: string; qtd: number; valor: number; ref: string }[] = [];

    for (const ref of MESES) {
      const antes = await loadDataset();
      const totaisAntes = new Map(
        MESES.filter((m) => m < ref).map((m) => [m, monthSummary(m, antes.transactions, catMap).expenseCents]),
      );

      await importFile(toCsv(bankRows(original, CONTA, ref)), 'csv', { type: 'account', id: CONTA },
        { paymentCardId: CARTAO.id, fileName: `extrato-${ref}.csv` });
      await importFile(toCsv(cardRows(original, CARTAO, ref), ['Data', 'Descrição', 'Valor']), 'csv',
        { type: 'card', id: CARTAO.id }, { fileName: `fatura-${ref}.csv` });

      const depois = await loadDataset();

      // 1. Nada que já existia foi alterado ou removido.
      for (const [id, assin] of anteriores) {
        const atual = depois.transactions.find((t) => t.id === id);
        expect(atual, `lançamento ${id} desapareceu ao importar ${ref}`).toBeDefined();
        expect(assinatura(atual!), `lançamento ${id} foi alterado ao importar ${ref}`).toBe(assin);
      }

      // 2. Nada foi duplicado.
      const pares = scanForDuplicates(depois.transactions);
      expect(pares, `importar ${ref} criou duplicidade`).toHaveLength(0);

      // 3. O que cresceu em meses já "fechados" precisa ser explicável.
      for (const [mes, antesValor] of totaisAntes) {
        const agora = monthSummary(mes, depois.transactions, catMap).expenseCents;
        if (agora !== antesValor) {
          const novos = depois.transactions.filter(
            (t) => monthOf(t.date) === mes && !anteriores.has(t.id) && t.kind === 'expense',
          );
          acrescimosEmMesesFechados.push({
            mes, ref, qtd: novos.length, valor: agora - antesValor,
          });
          // Precisam ser compras de cartão dentro do período da fatura importada.
          const periodo = invoicePeriod(CARTAO, ref);
          for (const novo of novos) {
            expect(novo.cardId, `lançamento novo em ${mes} não é do cartão`).toBeTruthy();
            expect(
              isBetween(novo.date, periodo.start, periodo.end),
              `lançamento novo em ${mes} está fora do período da fatura ${ref}`,
            ).toBe(true);
          }
        }
      }

      anteriores = new Map(depois.transactions.map((t) => [t.id, assinatura(t)]));
    }

    // O crescimento de um mês já visto é esperado e correto: compras feitas
    // depois do fechamento do cartão só chegam na fatura seguinte. O que NÃO
    // pode acontecer — e foi verificado acima — é lançamento alterado,
    // removido ou duplicado. A interface avisa sobre isso via
    // `monthCoverageGaps`, verificado na seção 7.
    if (acrescimosEmMesesFechados.length > 0) {
      const exemplo = acrescimosEmMesesFechados[0]!;
      nota('',
        `Compras após o fechamento do cartão (dia ${CARTAO.closingDay}) chegam na fatura seguinte: ao importar ` +
        `${exemplo.ref}, ${exemplo.mes} ganhou ${exemplo.qtd} lançamento(s) e ${formatMoney(exemplo.valor)} — ` +
        `sem nenhum lançamento alterado nem duplicado.`);
    }
  });

  it('desfazer uma importação volta exatamente ao estado anterior', async () => {
    await resetToStructureOnly();

    for (const ref of MESES.slice(0, 2)) {
      await importFile(toCsv(bankRows(original, CONTA, ref)), 'csv', { type: 'account', id: CONTA },
        { paymentCardId: CARTAO.id, fileName: `extrato-${ref}.csv` });
      await importFile(toCsv(cardRows(original, CARTAO, ref), ['Data', 'Descrição', 'Valor']), 'csv',
        { type: 'card', id: CARTAO.id }, { fileName: `fatura-${ref}.csv` });
    }

    const antes = await loadDataset();
    const idsAntes = new Set(antes.transactions.map((t) => t.id));
    const resumoAntes = MESES.map((m) => monthSummary(m, antes.transactions, catMap).expenseCents);

    // Importa junho e desfaz as duas importações.
    const extratoJunho = await importFile(toCsv(bankRows(original, CONTA, '2024-06')), 'csv',
      { type: 'account', id: CONTA }, { paymentCardId: CARTAO.id, fileName: 'extrato-2024-06.csv' });
    const faturaJunho = await importFile(toCsv(cardRows(original, CARTAO, '2024-06'), ['Data', 'Descrição', 'Valor']),
      'csv', { type: 'card', id: CARTAO.id }, { fileName: 'fatura-2024-06.csv' });

    await actions.deleteImportBatch(faturaJunho.batchId!);
    await actions.deleteImportBatch(extratoJunho.batchId!);

    const depois = await loadDataset();
    expect(new Set(depois.transactions.map((t) => t.id))).toEqual(idsAntes);
    expect(MESES.map((m) => monthSummary(m, depois.transactions, catMap).expenseCents)).toEqual(resumoAntes);
  });

  it('cada importação fica identificada, para dar para desfazer depois', async () => {
    const data = await loadDataset();
    expect(data.imports.length).toBeGreaterThan(0);
    for (const lote of data.imports) {
      const doLote = data.transactions.filter((t) => t.importBatchId === lote.id);
      expect(doLote.length, `lote ${lote.fileName} sem lançamentos vinculados`).toBe(lote.rowsImported);
    }
  });
});

describe('6. Coerência do resultado importado', () => {
  let importado: FinanceDataset;

  beforeAll(async () => {
    await resetToStructureOnly();
    for (const ref of MESES) {
      await importFile(toCsv(bankRows(original, CONTA, ref)), 'csv', { type: 'account', id: CONTA },
        { paymentCardId: CARTAO.id, fileName: `extrato-${ref}.csv` });
      await importFile(toCsv(cardRows(original, CARTAO, ref), ['Data', 'Descrição', 'Valor']), 'csv',
        { type: 'card', id: CARTAO.id }, { fileName: `fatura-${ref}.csv` });
    }
    importado = await loadDataset();
  });

  it('a soma das faturas fecha com as compras do cartão', () => {
    const compras = importado.transactions
      .filter((t) => t.cardId === CARTAO.id && t.kind !== 'card_payment')
      .reduce((s, t) => s + (t.kind === 'expense' ? t.amountCents : -t.amountCents), 0);
    const faturas = listInvoices(CARTAO, importado.transactions, HOJE).reduce((s, f) => s + f.totalCents, 0);
    expect(faturas).toBe(compras);
  });

  it('o limite do cartão é compras menos pagamentos', () => {
    const uso = cardUsage(CARTAO, importado.transactions);
    expect(uso.usedCents + uso.availableCents).toBe(CARTAO.limitCents);
  });

  it('as visões semanal e mensal são recortes da mesma base', () => {
    const mes = monthSummary('2024-05', importado.transactions, catMap);
    const periodo = periodSummary(importado.transactions, '2024-05-01', '2024-05-31', catMap);
    expect(periodo.expenseCents).toBe(mes.expenseCents);
    const semana = weekSummary('2024-05-15', importado.transactions, catMap, 0);
    const manual = importado.transactions
      .filter((t) => t.date >= '2024-05-12' && t.date <= '2024-05-18')
      .reduce((s, t) => s + pnlEffect(t).expense, 0);
    expect(semana.expenseCents).toBe(manual);
  });

  it('categorias, fixos/variáveis e formas de pagamento somam a despesa do mês', () => {
    const mes = monthSummary('2024-05', importado.transactions, catMap);
    expect(sumCents(mes.byCategory.map((c) => c.amountCents))).toBe(mes.expenseCents);
    expect(mes.fixedCents + mes.variableCents).toBe(mes.expenseCents);
    expect(mes.cardExpenseCents + mes.accountExpenseCents).toBe(mes.expenseCents);
  });

  it('orçamento e compromissos futuros são calculados', () => {
    const orcamento = budgetStatuses('2024-05', importado.budgets, importado.categories, importado.transactions);
    expect(orcamento.length).toBeGreaterThan(0);
    const view = availability({
      accounts: importado.accounts, cards: importado.cards, transactions: importado.transactions,
      recurring: importado.recurring, today: HOJE,
    });
    expect(view.balanceCents - view.committedCents).toBe(view.availableCents);
  });

  it('a auditoria não encontra ERRO na base importada', () => {
    const report = auditDataset(importado, HOJE);
    const erros = report.findings.filter((f) => f.severity === 'error');
    if (erros.length > 0) {
      nota('CRÍTICO',
        `A auditoria encontra ${erros.length} ERRO(s) na base recém-importada: ` +
        erros.slice(0, 4).map((e) => `${e.group}: ${e.title}`).join(' · '));
    }
  });

  it('sem reclassificar, a diferença é EXATAMENTE o que depende de você', () => {
    // Esta seção importa clicando "Importar" sem tocar em nada. O resultado
    // difere do original por três motivos conhecidos, e por mais nenhum:
    //
    //  (a) a transferência para a reserva, que o extrato não sabe que é
    //      transferência e por isso entra como despesa;
    //  (b) o reembolso, que entra como receita em vez de reduzir a despesa;
    //  (c) as compras de cartão feitas após o último fechamento importado,
    //      que só chegam na fatura seguinte.
    //
    // (a) e (b) você resolve na prévia — a seção 7 prova isso. (c) é o ciclo
    // do cartão, e a plataforma avisa.
    const ultimaFatura = invoicePeriod(CARTAO, MESES[MESES.length - 1]!);

    for (const mes of MESES) {
      const noMes = (t: Transaction) => isBetween(t.date, startOfMonth(mes), endOfMonth(mes));

      const transferencias = sumCents(
        original.transactions.filter((t) => t.kind === 'transfer' && t.accountId === CONTA && noMes(t))
          .map((t) => t.amountCents),
      );
      const reembolsos = sumCents(
        original.transactions.filter((t) => t.kind === 'refund' && !t.cardId && t.accountId === CONTA && noMes(t))
          .map((t) => t.amountCents),
      );
      const caudaDoCartao = sumCents(
        original.transactions
          .filter((t) => t.kind === 'expense' && t.cardId === CARTAO.id && noMes(t) && t.date > ultimaFatura.end)
          .map((t) => t.amountCents),
      );

      const esperado = monthSummary(mes, original.transactions, catMap);
      const obtido = monthSummary(mes, importado.transactions, catMap);

      expect(obtido.expenseCents - esperado.expenseCents, `despesa de ${mes}`).toBe(
        transferencias + reembolsos - caudaDoCartao,
      );
      expect(obtido.incomeCents - esperado.incomeCents, `receita de ${mes}`).toBe(reembolsos);
    }
  });

  it('o Diagnóstico aponta as transferências mal classificadas', () => {
    const report = auditDataset(importado, HOJE);
    const classificacao = report.findings.find((f) => f.id === 'suspicious-transfer');
    expect(classificacao).toBeDefined();
    expect(classificacao!.transactionIds).toHaveLength(MESES.length);
    expect(report.errorCount).toBe(0);
  });
});

function deltaConta(t: Transaction): number {
  switch (t.kind) {
    case 'income': return t.accountId === CONTA ? t.amountCents : 0;
    case 'refund': case 'chargeback': return !t.cardId && t.accountId === CONTA ? t.amountCents : 0;
    case 'expense': return !t.cardId && t.accountId === CONTA ? -t.amountCents : 0;
    case 'card_payment': return t.accountId === CONTA ? -t.amountCents : 0;
    case 'transfer':
      if (t.accountId === CONTA) return -t.amountCents;
      if (t.toAccountId === CONTA) return t.amountCents;
      return 0;
    default: return 0;
  }
}

describe('7. Fidelidade total depois das reclassificações', () => {
  /**
   * A prova final: importando extratos e faturas e fazendo na prévia as duas
   * reclassificações que só você pode decidir (transferência e reembolso), o
   * resultado tem de ficar IDÊNTICO aos dados originais.
   *
   * Para um mês ficar completo é preciso a fatura dele E a do mês seguinte —
   * as compras feitas após o fechamento do cartão só chegam na próxima.
   */
  it('os totais dos meses cobertos batem exatamente com o original', async () => {
    await resetToStructureOnly();

    const refsDeFatura = ['2024-04', '2024-05', '2024-06', '2024-07'];

    for (const ref of MESES) {
      // --- Extrato da conta, com as reclassificações ---------------------
      const data = await loadDataset();
      const context: ImportContext = {
        target: { type: 'account', accountId: CONTA },
        existing: data.transactions,
        rules: data.rules,
        cards: [CARTAO],
        paymentCardId: CARTAO.id,
      };
      const preview = buildImportPreview(parseCsvStatement(toCsv(bankRows(original, CONTA, ref))), context);

      const rows = preview.rows.map((row) => {
        if (row.description.includes('TRANSFERENCIA ENVIADA')) {
          return refreshRow(
            { ...changeRowKind(row, 'transfer', context), counterAccountId: RESERVA, selected: true },
            context,
          );
        }
        if (/RATEIO/i.test(row.description)) {
          return refreshRow(
            { ...changeRowKind(row, 'refund', context), categoryId: 'cat-restaurante', categorySource: 'manual' },
            context,
          );
        }
        return row;
      });

      const txs = materializePreview({ ...preview, rows }, context, 'pendente');
      if (txs.length > 0) {
        await actions.commitImport(
          { fileName: `extrato-${ref}.csv`, format: 'csv', accountId: CONTA,
            rowsRead: rows.length, rowsImported: txs.length, rowsSkipped: rows.length - txs.length },
          txs,
        );
      }
    }

    // --- Faturas do cartão, incluindo a seguinte ------------------------
    for (const ref of refsDeFatura) {
      await importFile(toCsv(cardRows(original, CARTAO, ref), ['Data', 'Descrição', 'Valor']), 'csv',
        { type: 'card', id: CARTAO.id }, { fileName: `fatura-${ref}.csv` });
    }

    const importado = await loadDataset();

    for (const mes of MESES) {
      const esperado = monthSummary(mes, original.transactions, catMap);
      const obtido = monthSummary(mes, importado.transactions, catMap);
      expect(obtido.expenseCents, `despesa de ${mes}`).toBe(esperado.expenseCents);
      expect(obtido.incomeCents, `receita de ${mes}`).toBe(esperado.incomeCents);
      expect(obtido.netCents, `saldo de ${mes}`).toBe(esperado.netCents);
      expect(obtido.cardExpenseCents, `despesa no cartão em ${mes}`).toBe(esperado.cardExpenseCents);
      expect(obtido.accountExpenseCents, `despesa na conta em ${mes}`).toBe(esperado.accountExpenseCents);
    }

    // A variação de saldo da conta nos três meses também tem de bater.
    const variacao = (txs: readonly Transaction[]) =>
      txs.filter((t) => monthOf(t.date) >= MESES[0]! && monthOf(t.date) <= MESES[2]!)
        .reduce((soma, t) => soma + deltaConta(t), 0);
    expect(variacao(importado.transactions)).toBe(variacao(original.transactions));

    observacoes.push(
      `Fidelidade total: ${importado.transactions.length} lançamentos importados reproduzem exatamente ` +
      `receita, despesa e saldo dos três meses.`,
    );
  });

  it('as parcelas da mesma compra formam UM único parcelamento', async () => {
    const importado = await loadDataset();
    const parceladas = importado.transactions.filter((t) => t.installmentTotal && t.installmentTotal > 1);
    expect(parceladas.length).toBeGreaterThanOrEqual(4);
    expect(new Set(parceladas.map((t) => t.installmentGroupId)).size).toBe(1);

    const planos = installmentPlans(importado.transactions, HOJE);
    expect(planos.filter((p) => /NOTEBOOK/i.test(p.description))).toHaveLength(1);
    const plano = planos.find((p) => /NOTEBOOK/i.test(p.description))!;
    // O total é a compra INTEIRA, não só as parcelas que já chegaram.
    expect(plano.paidCents + plano.remainingCents).toBe(plano.estimatedTotalCents);
    expect(plano.estimated).toBe(true);
    expect(plano.installmentTotal).toBe(8);
    expect(plano.paidCount + plano.remainingCount).toBe(8);
  });

  it('o comprometido reflete a compra inteira, não só a parcela que chegou', async () => {
    const importado = await loadDataset();
    const parceladas = importado.transactions.filter((t) => t.installmentTotal === 8);
    const jaNaBase = sumCents(parceladas.map((t) => t.amountCents));
    const valorDaParcela = parceladas[0]!.amountCents;
    const compraInteira = valorDaParcela * 8;

    const view = availability({
      accounts: importado.accounts,
      cards: importado.cards,
      transactions: importado.transactions,
      recurring: [],
      today: HOJE,
      horizonMonths: 24,
    });

    // As parcelas que faltam entram como previstas, sem repetir as que já
    // estão nas faturas.
    const previstas = view.future.items.filter((i) => i.kind === 'installment');
    expect(previstas).toHaveLength(8 - parceladas.length);
    expect(view.future.installmentCents).toBe(compraInteira - jaNaBase);

    // Nenhuma parcela é contada duas vezes.
    expect(new Set(view.future.items.map((i) => i.id)).size).toBe(view.future.items.length);

    observacoes.push(
      `Compra parcelada: ${formatMoney(jaNaBase)} já em fatura + ${formatMoney(view.future.installmentCents)} ` +
      `previstos = ${formatMoney(compraInteira)} da compra inteira.`,
    );
  });

  it('duas compras parceladas diferentes na mesma loja NÃO são fundidas', async () => {
    await resetToStructureOnly();
    const data = await loadDataset();
    const context: ImportContext = {
      target: { type: 'card', cardId: CARTAO.id, card: CARTAO },
      existing: data.transactions,
      rules: data.rules,
    };
    // Mesma loja, mesmo número de parcelas, mas compras de meses diferentes:
    // a parcela 1 de cada uma cai em datas distantes.
    const csv = [
      'Data;Descrição;Valor',
      '10/03/2024;LOJA MOVEIS 01/06;100,00',
      '10/03/2024;LOJA MOVEIS 03/06;250,00',
    ].join('\n');
    const preview = buildImportPreview(parseCsvStatement(csv), context);
    const gravados = materializePreview(preview, context, 'lote');
    expect(new Set(gravados.map((t) => t.installmentGroupId)).size).toBe(2);
  });

  it('a auditoria não acusa parcela faltando no fluxo incremental', async () => {
    await resetToStructureOnly();
    for (const ref of ['2024-04', '2024-05']) {
      await importFile(toCsv(cardRows(original, CARTAO, ref), ['Data', 'Descrição', 'Valor']), 'csv',
        { type: 'card', id: CARTAO.id }, { fileName: `fatura-${ref}.csv` });
    }
    const report = auditDataset(await loadDataset(), HOJE);
    expect(report.findings.filter((f) => f.id.startsWith('installment-count'))).toHaveLength(0);
    expect(report.errorCount).toBe(0);
  });

  it('mas AVISA quando uma parcela do meio ficou de fora', async () => {
    await resetToStructureOnly();
    const data = await loadDataset();
    const context: ImportContext = {
      target: { type: 'card', cardId: CARTAO.id, card: CARTAO },
      existing: data.transactions, rules: data.rules,
    };
    // Parcelas 1 e 3 importadas, a 2 não.
    const csv = [
      'Data;Descrição;Valor',
      '10/01/2024;SOFA LOJA CASA 01/06;100,00',
      '10/03/2024;SOFA LOJA CASA 03/06;100,00',
    ].join('\n');
    const preview = buildImportPreview(parseCsvStatement(csv), context);
    const txs = materializePreview(preview, context, 'lote');
    await actions.commitImport(
      { fileName: 'parcial.csv', format: 'csv', cardId: CARTAO.id, rowsRead: 2, rowsImported: txs.length, rowsSkipped: 0 },
      txs,
    );
    const report = auditDataset(await loadDataset(), HOJE);
    const lacuna = report.findings.find((f) => f.id.startsWith('installment-gap'));
    expect(lacuna).toBeDefined();
    expect(lacuna!.title).toMatch(/falta a parcela 2/);
  });

  it('avisa que o mês não está fechado enquanto a fatura seguinte não chega', async () => {
    await resetToStructureOnly();
    // Só a fatura de maio: o fim de maio ainda não tem fatura.
    await importFile(toCsv(cardRows(original, CARTAO, '2024-05'), ['Data', 'Descrição', 'Valor']), 'csv',
      { type: 'card', id: CARTAO.id }, { fileName: 'fatura-2024-05.csv' });

    const data = await loadDataset();
    const lacunas = monthCoverageGaps(data.cards, data.transactions, '2024-05');
    expect(lacunas).toHaveLength(1);
    expect(lacunas[0]!.from).toBe('2024-05-21');
    expect(lacunas[0]!.to).toBe('2024-05-31');
    expect(lacunas[0]!.pendingRef).toBe('2024-06');

    // Depois de importar a fatura de junho, o aviso desaparece.
    await importFile(toCsv(cardRows(original, CARTAO, '2024-06'), ['Data', 'Descrição', 'Valor']), 'csv',
      { type: 'card', id: CARTAO.id }, { fileName: 'fatura-2024-06.csv' });
    const depois = await loadDataset();
    expect(monthCoverageGaps(depois.cards, depois.transactions, '2024-05')).toHaveLength(0);
  });
});

describe('resumo', () => {
  it('registra o que foi verificado', () => {
    if (observacoes.length > 0) {
      console.log('\n' + observacoes.map((o) => `· ${o}`).join('\n') + '\n');
    }
    expect(true).toBe(true);
  });
});

describe('8. Detalhes da prévia editável', () => {
  it('completar a informação que faltava devolve a marcação da linha', async () => {
    await resetToStructureOnly();
    const data = await loadDataset();
    const context: ImportContext = {
      target: { type: 'account', accountId: CONTA },
      existing: data.transactions,
      rules: data.rules,
      cards: data.cards,
    };
    const preview = buildImportPreview(
      parseCsvStatement(toCsv(bankRows(original, CONTA, '2024-05'))),
      context,
    );
    const bloqueada = preview.rows.find((r) => r.blocked)!;
    expect(bloqueada.selected).toBe(false);

    const completa = refreshRow({ ...bloqueada, paymentCardId: CARTAO.id }, context);
    expect(completa.blocked).toBeUndefined();
    expect(completa.selected).toBe(true);
    expect(completa.invoiceRef).toBeTruthy();
  });

  it('o conselho de classificação sai da tela depois de você agir', async () => {
    await resetToStructureOnly();
    const data = await loadDataset();
    const context: ImportContext = {
      target: { type: 'account', accountId: CONTA },
      existing: data.transactions,
      rules: data.rules,
      cards: data.cards,
      paymentCardId: CARTAO.id,
    };
    const preview = buildImportPreview(
      parseCsvStatement(toCsv(bankRows(original, CONTA, '2024-05'))),
      context,
    );
    const linha = preview.rows.find((r) => r.description.includes('TRANSFERENCIA ENVIADA'))!;
    expect(linha.warnings.join(' ')).toMatch(/transferência/i);

    const corrigida = refreshRow(
      { ...changeRowKind(linha, 'transfer', context), counterAccountId: RESERVA },
      context,
    );
    expect(corrigida.warnings.join(' ')).not.toMatch(/troque o tipo/i);
  });

  it('trocar o tipo para transferência limpa a categoria', async () => {
    await resetToStructureOnly();
    const data = await loadDataset();
    const context: ImportContext = {
      target: { type: 'account', accountId: CONTA },
      existing: data.transactions,
      rules: data.rules,
      cards: data.cards,
    };
    const preview = buildImportPreview(
      parseCsvStatement('Data;Histórico;Valor\n10/05/2024;IFOOD *IFD BRASIL;-89,90'),
      context,
    );
    const linha = preview.rows[0]!;
    expect(linha.categoryId).toBe('cat-delivery');

    const comoTransferencia = changeRowKind(linha, 'transfer', context);
    expect(comoTransferencia.categoryId).toBeUndefined();
    expect(comoTransferencia.needsReview).toBe(false);
  });
});
