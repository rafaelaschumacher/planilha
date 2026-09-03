/**
 * Lançamentos: a base única, com filtros.
 *
 * Semana, mês, cartão e categoria não são listas separadas — são recortes
 * desta mesma lista.
 */

import { useMemo, useState } from 'react';
import { currentMonth, formatDateBR, formatMonthLong, monthOf } from '../../domain/dates';
import { pnlEffect } from '../../domain/transaction';
import { monthsWithData } from '../../domain/engine';
import { normalize } from '../../domain/text';
import type { FinanceDataset, ID, Transaction, TransactionKind } from '../../domain/types';
import { PAYMENT_METHOD_LABEL, TRANSACTION_KIND_LABEL } from '../../domain/types';
import { Badge, Button, EmptyState, Field, Input, Panel, Select } from '../components/primitives';
import { money } from '../format';

const PAGE_SIZE = 60;

export function Transactions({
  data,
  initialFilters,
  onEdit,
  onDelete,
  onSetCategory,
  onAdd,
}: {
  data: FinanceDataset;
  initialFilters: { categoria?: string; mes?: string; revisar?: boolean; conta?: string; cartao?: string };
  onEdit: (tx: Transaction) => void;
  onDelete: (tx: Transaction) => void;
  onSetCategory: (id: ID, categoryId: ID | undefined) => void;
  onAdd: () => void;
}) {
  const hide = data.settings.hideAmounts;
  const [search, setSearch] = useState('');
  const [month, setMonth] = useState(initialFilters.mes ?? currentMonth());
  const [kind, setKind] = useState<TransactionKind | 'all'>('all');
  const [categoryId, setCategoryId] = useState(initialFilters.categoria ?? '');
  const [sourceId, setSourceId] = useState(initialFilters.conta ?? initialFilters.cartao ?? '');
  const [onlyReview, setOnlyReview] = useState(Boolean(initialFilters.revisar));
  const [limit, setLimit] = useState(PAGE_SIZE);

  const categoryMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories]);
  const accountMap = useMemo(() => new Map(data.accounts.map((a) => [a.id, a])), [data.accounts]);
  const cardMap = useMemo(() => new Map(data.cards.map((c) => [c.id, c])), [data.cards]);
  const months = useMemo(() => monthsWithData(data.transactions).reverse(), [data.transactions]);

  const filtered = useMemo(() => {
    const term = normalize(search);
    return data.transactions
      .filter((tx) => {
        if (month !== 'all' && monthOf(tx.date) !== month) return false;
        if (kind !== 'all' && tx.kind !== kind) return false;
        if (categoryId && tx.categoryId !== categoryId) return false;
        if (sourceId && tx.accountId !== sourceId && tx.cardId !== sourceId && tx.toAccountId !== sourceId) return false;
        if (onlyReview && !tx.needsReview) return false;
        if (term && !normalize(tx.description).includes(term)) return false;
        return true;
      })
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt.localeCompare(a.createdAt)));
  }, [data.transactions, month, kind, categoryId, sourceId, onlyReview, search]);

  const totals = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const tx of filtered) {
      const effect = pnlEffect(tx);
      income += effect.income;
      expense += effect.expense;
    }
    return { income, expense, net: income - expense, count: filtered.length };
  }, [filtered]);

  const reviewCount = data.transactions.filter((t) => t.needsReview).length;
  const visible = filtered.slice(0, limit);

  return (
    <div className="space-y-4">
      <Panel className="p-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-6">
          <Field label="Buscar" className="lg:col-span-2">
            <Input
              placeholder="Descrição…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setLimit(PAGE_SIZE);
              }}
            />
          </Field>
          <Field label="Mês">
            <Select value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="all">Todos</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {formatMonthLong(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tipo">
            <Select value={kind} onChange={(e) => setKind(e.target.value as TransactionKind | 'all')}>
              <option value="all">Todos</option>
              {(Object.keys(TRANSACTION_KIND_LABEL) as TransactionKind[]).map((k) => (
                <option key={k} value={k}>
                  {TRANSACTION_KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Categoria">
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Todas</option>
              {data.categories
                .filter((c) => !c.archived)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.parentId ? `${categoryMap.get(c.parentId)?.name ?? ''} › ${c.name}` : c.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Conta ou cartão">
            <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <option value="">Todos</option>
              <optgroup label="Contas">
                {data.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Cartões">
                {data.cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            </Select>
          </Field>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button
            size="sm"
            variant={onlyReview ? 'primary' : 'secondary'}
            onClick={() => setOnlyReview((v) => !v)}
            disabled={reviewCount === 0 && !onlyReview}
          >
            Revisar categoria {reviewCount > 0 ? `(${reviewCount})` : ''}
          </Button>
          {(search || categoryId || sourceId || onlyReview || kind !== 'all' || month !== currentMonth()) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSearch('');
                setCategoryId('');
                setSourceId('');
                setOnlyReview(false);
                setKind('all');
                setMonth(currentMonth());
              }}
            >
              Limpar filtros
            </Button>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
            <span className="text-ink-3">{totals.count} lançamento(s)</span>
            <span className="tnum text-in">+{money(totals.income, hide, { noSymbol: true })}</span>
            <span className="tnum text-out">−{money(totals.expense, hide, { noSymbol: true })}</span>
            <span className="tnum font-medium text-ink">{money(totals.net, hide, { signed: true })}</span>
          </div>
        </div>
      </Panel>

      <Panel>
        {visible.length === 0 ? (
          <EmptyState
            title="Nenhum lançamento com esses filtros"
            description="Ajuste os filtros acima ou registre um novo lançamento."
            action={
              <Button variant="primary" size="sm" onClick={onAdd}>
                Adicionar lançamento
              </Button>
            }
          />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {visible.map((tx) => (
                <TransactionRow
                  key={tx.id}
                  tx={tx}
                  hide={hide}
                  categoryName={tx.categoryId ? categoryMap.get(tx.categoryId)?.name : undefined}
                  categoryColor={tx.categoryId ? categoryMap.get(tx.categoryId)?.color : undefined}
                  sourceName={
                    tx.cardId && tx.kind !== 'card_payment'
                      ? cardMap.get(tx.cardId)?.name
                      : accountMap.get(tx.accountId ?? '')?.name
                  }
                  targetName={
                    tx.kind === 'transfer'
                      ? accountMap.get(tx.toAccountId ?? '')?.name
                      : tx.kind === 'card_payment'
                        ? cardMap.get(tx.cardId ?? '')?.name
                        : undefined
                  }
                  categories={data.categories}
                  onEdit={() => onEdit(tx)}
                  onDelete={() => onDelete(tx)}
                  onSetCategory={(id) => onSetCategory(tx.id, id)}
                />
              ))}
            </ul>
            {filtered.length > visible.length ? (
              <div className="border-t border-line p-4 text-center">
                <Button size="sm" onClick={() => setLimit((v) => v + PAGE_SIZE)}>
                  Mostrar mais ({filtered.length - visible.length} restantes)
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Panel>
    </div>
  );
}

function TransactionRow({
  tx,
  hide,
  categoryName,
  categoryColor,
  sourceName,
  targetName,
  categories,
  onEdit,
  onDelete,
  onSetCategory,
}: {
  tx: Transaction;
  hide: boolean;
  categoryName?: string;
  categoryColor?: string;
  sourceName?: string;
  targetName?: string;
  categories: FinanceDataset['categories'];
  onEdit: () => void;
  onDelete: () => void;
  onSetCategory: (id: ID | undefined) => void;
}) {
  const [editingCategory, setEditingCategory] = useState(false);
  const effect = pnlEffect(tx);
  const isNeutral = effect.income === 0 && effect.expense === 0;
  const sign = effect.income > 0 ? '+' : effect.expense > 0 ? '−' : '';
  const tone = effect.income > 0 ? 'text-in' : effect.expense > 0 ? 'text-out' : 'text-ink-2';

  return (
    <li className="group px-5 py-3 transition-colors hover:bg-surface-hover">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14px] text-ink">{tx.description}</span>
            {tx.needsReview ? <Badge tone="warning">▲ revisar categoria</Badge> : null}
            {tx.status === 'pending' ? <Badge tone="neutral">previsto</Badge> : null}
            {tx.installmentTotal && tx.installmentTotal > 1 ? (
              <Badge tone="neutral">
                {tx.installmentNumber}/{tx.installmentTotal}
              </Badge>
            ) : null}
            {isNeutral ? <Badge tone="neutral">{TRANSACTION_KIND_LABEL[tx.kind]}</Badge> : null}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-3">
            <span>{formatDateBR(tx.date)}</span>
            {sourceName ? <span>· {sourceName}</span> : null}
            {targetName ? <span>→ {targetName}</span> : null}
            <span>· {PAYMENT_METHOD_LABEL[tx.paymentMethod]}</span>
            {tx.kind === 'transfer' || tx.kind === 'card_payment' || tx.kind === 'adjustment' ? null : editingCategory ? (
              <select
                autoFocus
                className="rounded border border-line bg-surface px-1.5 py-0.5 text-[12px] text-ink"
                value={tx.categoryId ?? ''}
                onChange={(e) => {
                  onSetCategory(e.target.value || undefined);
                  setEditingCategory(false);
                }}
                onBlur={() => setEditingCategory(false)}
              >
                <option value="">Sem categoria</option>
                {categories
                  .filter((c) => !c.archived && c.kind === (tx.kind === 'income' ? 'income' : 'expense'))
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            ) : (
              <button
                type="button"
                onClick={() => setEditingCategory(true)}
                className="inline-flex items-center gap-1 rounded px-1 hover:bg-surface-2 hover:text-ink-2"
              >
                {categoryColor ? (
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: categoryColor }} />
                ) : null}
                {categoryName ?? 'sem categoria'}
              </button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className={`tnum text-[14px] font-medium ${tone}`}>
            {sign}
            {money(tx.amountCents, hide, { noSymbol: false })}
          </span>
          <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Button size="sm" variant="ghost" onClick={onEdit} aria-label="Editar">
              ✎
            </Button>
            <Button size="sm" variant="ghost" onClick={onDelete} aria-label="Excluir">
              🗑
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}
