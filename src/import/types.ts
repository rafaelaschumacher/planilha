import type { Cents } from '../domain/money';
import type { ISODate } from '../domain/dates';
import type { ImportFormat } from '../domain/types';

/** Uma linha já lida e normalizada, ainda sem virar lançamento. */
export interface ParsedRow {
  date: ISODate;
  description: string;
  /** COM SINAL: negativo = saída, positivo = entrada. */
  amountCents: Cents;
  /** Identificador do banco (FITID no OFX). É a melhor chave anti-duplicidade. */
  externalId?: string;
  installmentNumber?: number;
  installmentTotal?: number;
  /** Linha original, para você conferir o que veio no arquivo. */
  raw: Record<string, string>;
  sourceLine: number;
}

export interface ParseIssue {
  line: number;
  message: string;
  raw?: string;
}

export interface ColumnMapping {
  date: number;
  description: number;
  /** Coluna única de valor com sinal. */
  amount?: number;
  /** Colunas separadas de débito e crédito (formato comum em extrato). */
  debit?: number;
  credit?: number;
  externalId?: number;
  installment?: number;
}

export interface ParseResult {
  format: ImportFormat;
  rows: ParsedRow[];
  issues: ParseIssue[];
  /** Cabeçalhos reconhecidos, para mostrar na tela o que foi entendido. */
  mapping?: ColumnMapping;
  headers?: string[];
  /** Nome/identificação da conta que veio dentro do arquivo (OFX). */
  detectedAccount?: string;
}
