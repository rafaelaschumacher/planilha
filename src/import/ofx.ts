/**
 * Leitura de OFX — o formato que quase todo banco brasileiro exporta.
 *
 * Cobre as duas versões: a antiga (SGML, com tags não fechadas) e a nova
 * (XML). O OFX é o melhor formato para importar, porque traz o FITID: um
 * identificador único por transação que elimina a dúvida sobre duplicidade.
 */

import { parseMoney } from '../domain/money';
import { parseFlexibleDate } from './parse';
import type { ParsedRow, ParseIssue, ParseResult } from './types';

/** Lê o valor de uma tag, aceitando `<TAG>valor` (SGML) e `<TAG>valor</TAG>` (XML). */
function tagValue(block: string, tag: string): string | undefined {
  const closed = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (closed) return decodeEntities(closed[1]!.trim());
  const open = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(block);
  return open ? decodeEntities(open[1]!.trim()) : undefined;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/gi, ' ');
}

export function parseOfxStatement(text: string): ParseResult {
  const issues: ParseIssue[] = [];
  const rows: ParsedRow[] = [];

  const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) ?? [];
  if (blocks.length === 0) {
    return {
      format: 'ofx',
      rows: [],
      issues: [{ line: 0, message: 'Nenhuma transação (<STMTTRN>) encontrada no arquivo OFX.' }],
    };
  }

  blocks.forEach((block, index) => {
    const line = index + 1;
    const rawDate = tagValue(block, 'DTPOSTED') ?? tagValue(block, 'DTUSER');
    const rawAmount = tagValue(block, 'TRNAMT');
    const memo = tagValue(block, 'MEMO');
    const name = tagValue(block, 'NAME');
    const fitId = tagValue(block, 'FITID');
    const type = tagValue(block, 'TRNTYPE');

    if (!rawDate) {
      issues.push({ line, message: 'Transação sem data (DTPOSTED).' });
      return;
    }
    const date = parseFlexibleDate(rawDate.slice(0, 8));
    if (!date) {
      issues.push({ line, message: `Data OFX inválida: "${rawDate}".` });
      return;
    }

    // TRNAMT é sempre ponto decimal, mesmo em arquivo de banco brasileiro.
    const amountCents = rawAmount ? parseMoney(rawAmount.replace(',', '.')) : null;
    if (amountCents === null) {
      issues.push({ line, message: `Valor OFX inválido: "${rawAmount ?? ''}".` });
      return;
    }
    if (amountCents === 0) return;

    // NAME costuma ser o estabelecimento; MEMO, o detalhe. O mais informativo vence.
    const description = [name, memo].filter(Boolean).sort((a, b) => (b?.length ?? 0) - (a?.length ?? 0))[0];

    const raw: Record<string, string> = {};
    if (name) raw['NAME'] = name;
    if (memo) raw['MEMO'] = memo;
    if (type) raw['TRNTYPE'] = type;
    if (fitId) raw['FITID'] = fitId;

    const row: ParsedRow = {
      date,
      description: description || 'Lançamento importado',
      amountCents,
      raw,
      sourceLine: line,
    };
    if (fitId) row.externalId = fitId;

    const installment = /(\d{1,2})\s*\/\s*(\d{1,2})/.exec(row.description);
    if (installment) {
      const number = Number(installment[1]);
      const total = Number(installment[2]);
      if (number && total && number <= total && total >= 2 && total <= 99) {
        row.installmentNumber = number;
        row.installmentTotal = total;
      }
    }

    rows.push(row);
  });

  const bankId = tagValue(text, 'BANKID');
  const acctId = tagValue(text, 'ACCTID');
  const detectedAccount = [bankId, acctId].filter(Boolean).join(' · ') || undefined;

  const result: ParseResult = { format: 'ofx', rows, issues };
  if (detectedAccount) result.detectedAccount = detectedAccount;
  return result;
}
