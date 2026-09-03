/**
 * Auditoria financeira.
 *
 * Roda contra a base inteira procurando exatamente os erros que fazem um
 * controle financeiro perder credibilidade: valor contado duas vezes,
 * parcela que não fecha, transferência classificada como despesa, saldo que
 * não bate, data impossível.
 *
 * A tela "Diagnóstico" mostra o resultado disso. É o mesmo código usado nos
 * testes automatizados.
 */

import { formatMoney, sumCents, type Cents } from './money';
import { compareDate, isISODate, monthOf, today as todayOf, type ISODate } from './dates';
import { pnlEffect, validateTransaction } from './transaction';
import { invoicePeriod, invoiceRefForDate, listInvoices } from './invoice';
import { scanForDuplicates } from './duplicates';
import { accountBalance } from './engine';
import type { FinanceDataset, ID, Transaction } from './types';

export type AuditSeverity = 'error' | 'warning' | 'info';

export interface AuditFinding {
  id: string;
  severity: AuditSeverity;
  /** Categoria do problema, para agrupar na tela. */
  group: string;
  title: string;
  detail: string;
  transactionIds?: ID[];
}

export interface AuditReport {
  findings: AuditFinding[];
  errorCount: number;
  warningCount: number;
  checkedTransactions: number;
  /** Conferências que passaram — mostra o que foi verificado, não só o que falhou. */
  passed: string[];
}

export function auditDataset(data: FinanceDataset, today: ISODate = todayOf()): AuditReport {
  const findings: AuditFinding[] = [];
  const passed: string[] = [];
  const push = (f: AuditFinding) => findings.push(f);

  const accountIds = new Set(data.accounts.map((a) => a.id));
  const cardIds = new Set(data.cards.map((c) => c.id));
  const categoryIds = new Set(data.categories.map((c) => c.id));
  const txById = new Map(data.transactions.map((tx) => [tx.id, tx]));

  // 1. Integridade estrutural de cada lançamento -------------------------
  let structural = 0;
  for (const tx of data.transactions) {
    const errors = validateTransaction(tx);
    if (errors.length) {
      structural++;
      push({
        id: `invalid-${tx.id}`,
        severity: 'error',
        group: 'Estrutura do lançamento',
        title: `"${tx.description}" está inconsistente`,
        detail: errors.join('; '),
        transactionIds: [tx.id],
      });
    }
  }
  if (structural === 0) passed.push('Todos os lançamentos respeitam as regras de tipo, origem e valor.');

  // 2. Referências órfãs --------------------------------------------------
  let orphans = 0;
  for (const tx of data.transactions) {
    const missing: string[] = [];
    if (tx.accountId && !accountIds.has(tx.accountId)) missing.push(`conta ${tx.accountId}`);
    if (tx.toAccountId && !accountIds.has(tx.toAccountId)) missing.push(`conta destino ${tx.toAccountId}`);
    if (tx.cardId && !cardIds.has(tx.cardId)) missing.push(`cartão ${tx.cardId}`);
    if (tx.categoryId && !categoryIds.has(tx.categoryId)) missing.push(`categoria ${tx.categoryId}`);
    if (tx.linkedTransactionId && !txById.has(tx.linkedTransactionId)) missing.push('lançamento vinculado');
    if (missing.length) {
      orphans++;
      push({
        id: `orphan-${tx.id}`,
        severity: 'error',
        group: 'Referências',
        title: `"${tx.description}" aponta para item inexistente`,
        detail: `Não encontrado: ${missing.join(', ')}.`,
        transactionIds: [tx.id],
      });
    }
  }
  if (orphans === 0) passed.push('Nenhum lançamento aponta para conta, cartão ou categoria inexistente.');

  // 3. Datas --------------------------------------------------------------
  const farFuture = data.transactions.filter(
    (tx) => isISODate(tx.date) && tx.date > `${Number(today.slice(0, 4)) + 6}-12-31`,
  );
  if (farFuture.length) {
    push({
      id: 'far-future-dates',
      severity: 'warning',
      group: 'Datas',
      title: `${farFuture.length} lançamento(s) com data muito distante`,
      detail: 'Datas a mais de 6 anos costumam ser erro de digitação ou de importação.',
      transactionIds: farFuture.map((tx) => tx.id),
    });
  }
  const badDates = data.transactions.filter((tx) => !isISODate(tx.date));
  if (badDates.length) {
    push({
      id: 'bad-dates',
      severity: 'error',
      group: 'Datas',
      title: `${badDates.length} lançamento(s) com data inválida`,
      detail: 'A data precisa existir no calendário (formato AAAA-MM-DD).',
      transactionIds: badDates.map((tx) => tx.id),
    });
  }
  if (!farFuture.length && !badDates.length) passed.push('Todas as datas são válidas e plausíveis.');

  // 4. Parcelamentos ------------------------------------------------------
  const groups = new Map<ID, Transaction[]>();
  for (const tx of data.transactions) {
    if (!tx.installmentGroupId) continue;
    const list = groups.get(tx.installmentGroupId) ?? [];
    list.push(tx);
    groups.set(tx.installmentGroupId, list);
  }

  let installmentProblems = 0;
  for (const [groupId, list] of groups) {
    const first = list[0]!;
    const expected = first.installmentTotal ?? list.length;
    const numbers = list.map((tx) => tx.installmentNumber ?? 0).sort((a, b) => a - b);
    const unique = new Set(numbers);

    if (unique.size !== numbers.length) {
      installmentProblems++;
      push({
        id: `installment-dup-${groupId}`,
        severity: 'error',
        group: 'Parcelamento',
        title: `"${first.description}" tem parcelas repetidas`,
        detail: `Números encontrados: ${numbers.join(', ')}.`,
        transactionIds: list.map((tx) => tx.id),
      });
    }

    if (list.length !== expected) {
      installmentProblems++;
      push({
        id: `installment-count-${groupId}`,
        severity: 'warning',
        group: 'Parcelamento',
        title: `"${first.description}" tem ${list.length} de ${expected} parcelas`,
        detail: 'Faltam parcelas na base — o comprometimento futuro está subestimado.',
        transactionIds: list.map((tx) => tx.id),
      });
    }

    const total = sumCents(list.map((tx) => tx.amountCents));
    const declared = first.purchaseTotalCents;
    if (declared !== undefined && list.length === expected && total !== declared) {
      installmentProblems++;
      push({
        id: `installment-sum-${groupId}`,
        severity: 'error',
        group: 'Parcelamento',
        title: `"${first.description}": soma das parcelas não bate com o total`,
        detail: `Parcelas somam ${formatMoney(total)}, mas a compra foi de ${formatMoney(declared)}. Diferença de ${formatMoney(total - declared)}.`,
        transactionIds: list.map((tx) => tx.id),
      });
    }

    const months = new Set(list.map((tx) => monthOf(tx.date)));
    if (months.size !== list.length) {
      installmentProblems++;
      push({
        id: `installment-months-${groupId}`,
        severity: 'warning',
        group: 'Parcelamento',
        title: `"${first.description}" tem parcelas no mesmo mês`,
        detail: 'Cada parcela deveria cair em um mês diferente.',
        transactionIds: list.map((tx) => tx.id),
      });
    }
  }
  if (groups.size > 0 && installmentProblems === 0) {
    passed.push(`As ${groups.size} compra(s) parcelada(s) fecham exatamente com o valor total.`);
  }

  // 5. A regra crítica: pagamento de fatura não pode virar despesa -------
  const paymentsAsExpense = data.transactions.filter(
    (tx) => tx.kind === 'card_payment' && pnlEffect(tx).expense !== 0,
  );
  if (paymentsAsExpense.length) {
    push({
      id: 'card-payment-as-expense',
      severity: 'error',
      group: 'Dupla contabilização',
      title: 'Pagamento de fatura sendo contado como despesa',
      detail: 'A despesa é a compra; o pagamento apenas liquida a fatura.',
      transactionIds: paymentsAsExpense.map((tx) => tx.id),
    });
  } else {
    passed.push('Nenhum pagamento de fatura está sendo contado como despesa.');
  }

  const transfersAsExpense = data.transactions.filter(
    (tx) => tx.kind === 'transfer' && (pnlEffect(tx).expense !== 0 || pnlEffect(tx).income !== 0),
  );
  if (transfersAsExpense.length) {
    push({
      id: 'transfer-as-expense',
      severity: 'error',
      group: 'Dupla contabilização',
      title: 'Transferência sendo contada como receita ou despesa',
      detail: 'Dinheiro entre contas próprias não é resultado do mês.',
      transactionIds: transfersAsExpense.map((tx) => tx.id),
    });
  } else {
    passed.push('Transferências entre contas próprias não afetam receitas nem despesas.');
  }

  // Despesa "disfarçada" de transferência: descrição sugere transferência
  // mas o lançamento é despesa com conta de destino ausente.
  const suspiciousTransfers = data.transactions.filter(
    (tx) =>
      tx.kind === 'expense' &&
      !tx.cardId &&
      /transfer|ted\b|doc\b|pix enviado|entre contas/i.test(tx.description),
  );
  if (suspiciousTransfers.length) {
    push({
      id: 'suspicious-transfer',
      severity: 'warning',
      group: 'Classificação',
      title: `${suspiciousTransfers.length} despesa(s) parecem transferências`,
      detail: 'Se o dinheiro foi para outra conta sua, reclassifique como transferência para não inflar as despesas.',
      transactionIds: suspiciousTransfers.map((tx) => tx.id),
    });
  }

  const paymentLikeExpenses = data.transactions.filter(
    (tx) =>
      tx.kind === 'expense' &&
      !tx.cardId &&
      /pagamento (de )?fatura|fatura cart|pag fatura/i.test(tx.description),
  );
  if (paymentLikeExpenses.length) {
    push({
      id: 'invoice-payment-as-expense',
      severity: 'error',
      group: 'Dupla contabilização',
      title: `${paymentLikeExpenses.length} despesa(s) parecem pagamento de fatura`,
      detail:
        'Lançado como despesa comum, o pagamento da fatura conta o gasto do cartão duas vezes. Reclassifique como "Pagamento de fatura".',
      transactionIds: paymentLikeExpenses.map((tx) => tx.id),
    });
  }

  // 6. Faturas ------------------------------------------------------------
  for (const card of data.cards) {
    const invoices = listInvoices(card, data.transactions, today);
    for (const invoice of invoices) {
      if (invoice.paidCents > invoice.totalCents && invoice.totalCents > 0) {
        push({
          id: `invoice-overpaid-${card.id}-${invoice.ref}`,
          severity: 'warning',
          group: 'Faturas',
          title: `Fatura ${card.name} ${invoice.ref} pagou mais do que devia`,
          detail: `Total ${formatMoney(invoice.totalCents)}, pago ${formatMoney(invoice.paidCents)}. Confira se há pagamento duplicado.`,
          transactionIds: invoice.payments.map((p) => p.id),
        });
      }
    }

    // Compra de cartão fora de qualquer período de fatura seria um furo lógico.
    const cardTx = data.transactions.filter((tx) => tx.cardId === card.id && tx.kind === 'expense');
    const outside = cardTx.filter((tx) => {
      const period = invoicePeriod(card, invoiceRefForDate(card, tx.date));
      return compareDate(tx.date, period.start) < 0 || compareDate(tx.date, period.end) > 0;
    });
    if (outside.length) {
      push({
        id: `invoice-gap-${card.id}`,
        severity: 'error',
        group: 'Faturas',
        title: `${outside.length} compra(s) de ${card.name} fora de qualquer fatura`,
        detail: 'Erro no cálculo do ciclo de fechamento — o total das faturas não fecha com as compras.',
        transactionIds: outside.map((tx) => tx.id),
      });
    }
  }

  // Conferência: soma das faturas == soma das compras de cartão.
  for (const card of data.cards) {
    const purchases = data.transactions.filter(
      (tx) => tx.cardId === card.id && (tx.kind === 'expense' || tx.kind === 'refund' || tx.kind === 'chargeback'),
    );
    const purchaseTotal = purchases.reduce(
      (sum, tx) => sum + (tx.kind === 'expense' ? tx.amountCents : -tx.amountCents),
      0,
    );
    const invoiceTotal = listInvoices(card, data.transactions, today).reduce((sum, inv) => sum + inv.totalCents, 0);
    if (purchaseTotal !== invoiceTotal) {
      push({
        id: `invoice-mismatch-${card.id}`,
        severity: 'error',
        group: 'Faturas',
        title: `Faturas de ${card.name} não batem com as compras`,
        detail: `Compras somam ${formatMoney(purchaseTotal)}, faturas somam ${formatMoney(invoiceTotal)}.`,
      });
    }
  }
  if (data.cards.length > 0 && !findings.some((f) => f.group === 'Faturas' && f.severity === 'error')) {
    passed.push('Cada compra de cartão cai em exatamente uma fatura, e as faturas somam o mesmo que as compras.');
  }

  // 7. Saldos -------------------------------------------------------------
  for (const account of data.accounts) {
    const before = data.transactions.filter(
      (tx) =>
        compareDate(tx.date, account.openingDate) < 0 &&
        (tx.accountId === account.id || tx.toAccountId === account.id),
    );
    if (before.length) {
      push({
        id: `before-opening-${account.id}`,
        severity: 'warning',
        group: 'Saldos',
        title: `${before.length} lançamento(s) anteriores à abertura de ${account.name}`,
        detail: `Eles são ignorados no saldo (que parte de ${formatMoney(account.openingBalanceCents)} em ${account.openingDate}). Ajuste a data de abertura se o saldo estiver errado.`,
        transactionIds: before.map((tx) => tx.id),
      });
    }
  }

  // Conferência cruzada: saldo total == abertura + soma de todos os efeitos.
  const balanceSum = data.accounts.reduce((sum, a) => sum + accountBalance(a, data.transactions), 0);
  const openingSum = sumCents(data.accounts.map((a) => a.openingBalanceCents));
  const effectSum = data.accounts.reduce((sum, account) => {
    return (
      sum +
      data.transactions.reduce((inner, tx) => {
        if (compareDate(tx.date, account.openingDate) < 0) return inner;
        if (tx.status === 'pending') return inner;
        return inner + accountDeltaSafe(tx, account.id);
      }, 0)
    );
  }, 0);
  if (balanceSum !== openingSum + effectSum) {
    push({
      id: 'balance-mismatch',
      severity: 'error',
      group: 'Saldos',
      title: 'Saldo consolidado não bate com a soma dos lançamentos',
      detail: `Saldo calculado ${formatMoney(balanceSum)} contra ${formatMoney(openingSum + effectSum)} esperado.`,
    });
  } else if (data.accounts.length > 0) {
    passed.push('O saldo de cada conta é exatamente o saldo inicial mais os lançamentos.');
  }

  // 8. Arredondamento -----------------------------------------------------
  const nonInteger = data.transactions.filter((tx) => !Number.isSafeInteger(tx.amountCents));
  if (nonInteger.length) {
    push({
      id: 'non-integer-cents',
      severity: 'error',
      group: 'Arredondamento',
      title: `${nonInteger.length} valor(es) não são centavos inteiros`,
      detail: 'Valores fracionários acumulam erro e fazem os totais divergirem.',
      transactionIds: nonInteger.map((tx) => tx.id),
    });
  } else {
    passed.push('Todos os valores são centavos inteiros — não há erro de ponto flutuante.');
  }

  // 9. Duplicidades -------------------------------------------------------
  const duplicates = scanForDuplicates(data.transactions);
  for (const pair of duplicates) {
    push({
      id: `dup-${pair.a.id}-${pair.b.id}`,
      severity: 'warning',
      group: 'Possíveis duplicidades',
      title: `"${pair.a.description}" pode estar lançado duas vezes`,
      detail: `${formatMoney(pair.a.amountCents)} em ${pair.a.date} e ${pair.b.date} — ${pair.reasons.join(', ')}. Nada foi apagado.`,
      transactionIds: [pair.a.id, pair.b.id],
    });
  }
  if (duplicates.length === 0) passed.push('Nenhuma duplicidade suspeita encontrada.');

  // 10. Orçamentos --------------------------------------------------------
  const budgetDupes = new Map<string, number>();
  for (const budget of data.budgets) {
    const key = `${budget.categoryId}|${budget.month ?? 'default'}`;
    budgetDupes.set(key, (budgetDupes.get(key) ?? 0) + 1);
  }
  for (const [key, count] of budgetDupes) {
    if (count > 1) {
      push({
        id: `budget-dup-${key}`,
        severity: 'warning',
        group: 'Orçamento',
        title: 'Categoria com mais de um orçamento no mesmo período',
        detail: `${count} orçamentos para ${key.replace('|', ' em ')}. Só um vale — remova os extras.`,
      });
    }
  }
  for (const budget of data.budgets) {
    if (!categoryIds.has(budget.categoryId)) {
      push({
        id: `budget-orphan-${budget.id}`,
        severity: 'warning',
        group: 'Orçamento',
        title: 'Orçamento de categoria inexistente',
        detail: `A categoria ${budget.categoryId} não existe mais.`,
      });
    }
  }

  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;

  return {
    findings,
    errorCount,
    warningCount,
    checkedTransactions: data.transactions.length,
    passed,
  };
}

/** Cópia local do efeito em conta, para a auditoria não depender da ordem de import. */
function accountDeltaSafe(tx: Transaction, accountId: ID): Cents {
  switch (tx.kind) {
    case 'expense':
      return !tx.cardId && tx.accountId === accountId ? -tx.amountCents : 0;
    case 'income':
      return tx.accountId === accountId ? tx.amountCents : 0;
    case 'refund':
    case 'chargeback':
      return !tx.cardId && tx.accountId === accountId ? tx.amountCents : 0;
    case 'transfer':
      if (tx.accountId === accountId) return -tx.amountCents;
      if (tx.toAccountId === accountId) return tx.amountCents;
      return 0;
    case 'card_payment':
      return tx.accountId === accountId ? -tx.amountCents : 0;
    case 'adjustment':
      if (tx.accountId !== accountId) return 0;
      return tx.direction === 'out' ? -tx.amountCents : tx.amountCents;
    default:
      return 0;
  }
}
