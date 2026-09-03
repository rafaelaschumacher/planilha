/** Relatórios: mês a mês, categorias, formas de pagamento e semanas. */

import { useMemo, useState } from 'react';
import { formatMoney, formatPercent } from '../../domain/money';
import {
  addMonthsToMonth,
  currentMonth,
  formatMonthLong,
  formatWeekRange,
  lastMonths,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  addDays,
  today as todayOf,
} from '../../domain/dates';
import { averageExpense, monthSummary, periodSummary, weekSummary } from '../../domain/engine';
import { monthCoverageGaps } from '../../domain/invoice';
import { PAYMENT_METHOD_LABEL, type FinanceDataset } from '../../domain/types';
import { Button, EmptyState, Notice, Panel, PanelHeader, Select } from '../components/primitives';
import { MonthlyBars, RankedBars, SplitBar } from '../components/charts';
import { money } from '../format';
import { navigate } from '../router';

type Tab = 'mensal' | 'semanal' | 'categorias';

export function Reports({ data }: { data: FinanceDataset }) {
  const today = todayOf();
  const hide = data.settings.hideAmounts;
  const [tab, setTab] = useState<Tab>('mensal');
  const [month, setMonth] = useState(currentMonth());
  const [range, setRange] = useState(12);

  const categoryMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories]);
  const months = useMemo(() => lastMonths(currentMonth(), range), [range]);

  const summary = useMemo(
    () => monthSummary(month, data.transactions, categoryMap, { largestCount: 10 }),
    [month, data.transactions, categoryMap],
  );
  const previous = useMemo(
    () => monthSummary(addMonthsToMonth(month, -1), data.transactions, categoryMap),
    [month, data.transactions, categoryMap],
  );
  const average = useMemo(
    () => averageExpense(month, 3, data.transactions, categoryMap),
    [month, data.transactions, categoryMap],
  );

  const evolution = useMemo(
    () =>
      months.map((m) => {
        const s = monthSummary(m, data.transactions, categoryMap);
        return { month: m, incomeCents: s.incomeCents, expenseCents: s.expenseCents };
      }),
    [months, data.transactions, categoryMap],
  );

  const weeks = useMemo(() => {
    const list: { start: string; summary: ReturnType<typeof weekSummary> }[] = [];
    let cursor = startOfWeek(today, data.settings.firstDayOfWeek);
    for (let i = 0; i < 8; i++) {
      list.push({ start: cursor, summary: weekSummary(cursor, data.transactions, categoryMap, data.settings.firstDayOfWeek) });
      cursor = addDays(cursor, -7);
    }
    return list;
  }, [today, data.transactions, categoryMap, data.settings.firstDayOfWeek]);

  const coverage = useMemo(
    () => monthCoverageGaps(data.cards, data.transactions, month),
    [data.cards, data.transactions, month],
  );

  const periodTotals = useMemo(
    () => periodSummary(data.transactions, startOfMonth(months[0]!), endOfMonth(months[months.length - 1]!), categoryMap),
    [data.transactions, months, categoryMap],
  );

  if (data.transactions.length === 0) {
    return (
      <Panel>
        <EmptyState
          title="Ainda não há dados para relatar"
          description="Adicione lançamentos ou importe um extrato para ver a evolução."
          action={<Button size="sm" onClick={() => navigate('/importar')}>Importar extrato</Button>}
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(['mensal', 'semanal', 'categorias'] as Tab[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setTab(option)}
            className={`rounded-full border px-3.5 py-1.5 text-[13px] capitalize transition-colors ${
              tab === option
                ? 'border-transparent bg-accent text-accent-ink'
                : 'border-line text-ink-2 hover:bg-surface-hover'
            }`}
          >
            {option === 'mensal' ? 'Visão mensal' : option === 'semanal' ? 'Visão semanal' : 'Categorias'}
          </button>
        ))}
        {tab === 'mensal' ? (
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setMonth(addMonthsToMonth(month, -1))}>
              ←
            </Button>
            <span className="text-[13px] text-ink-2">{formatMonthLong(month)}</span>
            <Button size="sm" variant="ghost" onClick={() => setMonth(addMonthsToMonth(month, 1))}>
              →
            </Button>
          </div>
        ) : null}
      </div>

      {tab === 'mensal' ? (
        <>
          {coverage.length > 0 ? (
            <Notice tone="info" title={`${formatMonthLong(month)} ainda não está fechado`}>
              {coverage
                .map(
                  (gap) =>
                    `Compras no ${gap.cardName} entre ${gap.from.slice(8, 10)}/${gap.from.slice(5, 7)} e ${gap.to.slice(8, 10)}/${gap.to.slice(5, 7)} só aparecem na fatura que vence em ${gap.dueDate.slice(8, 10)}/${gap.dueDate.slice(5, 7)}.`,
                )
                .join(' ')}{' '}
              Importe essa fatura para o mês ficar completo.
            </Notice>
          ) : null}

          <Panel className="p-5">
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Receitas" value={money(summary.incomeCents, hide)} tone="in" delta={summary.incomeCents - previous.incomeCents} hide={hide} />
              <Stat label="Despesas" value={money(summary.expenseCents, hide)} tone="out" delta={summary.expenseCents - previous.expenseCents} hide={hide} inverted />
              <Stat label="Saldo do mês" value={money(summary.netCents, hide, { signed: true })} tone={summary.netCents >= 0 ? 'in' : 'out'} delta={summary.netCents - previous.netCents} hide={hide} />
              <Stat
                label="Taxa de economia"
                value={summary.incomeCents > 0 ? formatPercent(summary.savingsRate) : '—'}
                hint={average > 0 ? `média de despesa (3m): ${money(average, hide)}` : undefined}
              />
            </div>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <PanelHeader title="Fixos e variáveis" description={formatMonthLong(month)} />
              <div className="p-5">
                <SplitBar
                  hide={hide}
                  segments={[
                    { label: 'Gastos fixos', amountCents: summary.fixedCents, color: 'var(--seq-550)' },
                    { label: 'Gastos variáveis', amountCents: summary.variableCents, color: 'var(--seq-250)' },
                  ]}
                />
              </div>
            </Panel>

            <Panel>
              <PanelHeader title="Onde o dinheiro saiu" description="Por forma de pagamento" />
              <div className="p-5">
                <SplitBar
                  hide={hide}
                  segments={[
                    { label: 'Cartão de crédito', amountCents: summary.cardExpenseCents, color: 'var(--seq-400)' },
                    { label: 'Conta bancária', amountCents: summary.accountExpenseCents, color: 'var(--seq-100)' },
                  ]}
                />
                <ul className="mt-5 space-y-1.5 border-t border-line pt-4 text-[13px]">
                  {summary.byPaymentMethod.map((method) => (
                    <li key={method.method} className="flex items-baseline justify-between gap-3">
                      <span className="text-ink-2">{PAYMENT_METHOD_LABEL[method.method]}</span>
                      <span className="tnum text-ink">{money(method.amountCents, hide)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Panel>
          </div>

          <Panel>
            <PanelHeader title="Gastos por categoria" description={formatMonthLong(month)} />
            <RankedBars
              hide={hide}
              items={summary.byCategory.map((c) => ({
                id: c.categoryId,
                label: c.rootId === c.categoryId ? c.categoryName : `${c.rootName} › ${c.categoryName}`,
                amountCents: c.amountCents,
                color: c.color,
                meta: `${c.count} lançamento${c.count === 1 ? '' : 's'}`,
              }))}
              onSelect={(id) => navigate(`/lancamentos?categoria=${id}&mes=${month}`)}
            />
          </Panel>

          <Panel>
            <PanelHeader title="Maiores despesas" description={formatMonthLong(month)} />
            {summary.largestExpenses.length === 0 ? (
              <EmptyState title="Nenhuma despesa neste mês" />
            ) : (
              <ul className="divide-y divide-line">
                {summary.largestExpenses.map((tx) => (
                  <li key={tx.id} className="flex items-baseline justify-between gap-4 px-5 py-2.5">
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] text-ink">{tx.description}</span>
                      <span className="text-[12px] text-ink-3">
                        {tx.date.slice(8, 10)}/{tx.date.slice(5, 7)}
                        {tx.categoryId ? ` · ${categoryMap.get(tx.categoryId)?.name ?? ''}` : ''}
                      </span>
                    </span>
                    <span className="tnum shrink-0 text-[13px] text-ink">{money(tx.amountCents, hide)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      ) : null}

      {tab === 'semanal' ? (
        <>
          <Panel>
            <PanelHeader title="Últimas 8 semanas" description="Derivadas da mesma base — nenhuma tabela manual" />
            <ul className="divide-y divide-line">
              {weeks.map(({ start, summary: week }, index) => {
                const previousWeek = weeks[index + 1]?.summary;
                const delta = previousWeek ? week.expenseCents - previousWeek.expenseCents : 0;
                return (
                  <li key={start} className="px-5 py-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <span className="text-[13px] font-medium text-ink">
                        {formatWeekRange(start)}
                        {index === 0 ? <span className="ml-2 text-[12px] font-normal text-ink-3">semana atual</span> : null}
                      </span>
                      <span className="flex flex-wrap items-baseline gap-4 text-[13px]">
                        <span className="tnum text-in">+{money(week.incomeCents, hide, { noSymbol: true })}</span>
                        <span className="tnum text-out">−{money(week.expenseCents, hide, { noSymbol: true })}</span>
                        <span className="tnum font-medium text-ink">{money(week.netCents, hide, { signed: true })}</span>
                      </span>
                    </div>
                    {week.byRootCategory.length > 0 ? (
                      <p className="mt-1 text-[12px] text-ink-3">
                        Principais: {week.byRootCategory.slice(0, 3).map((c) => `${c.categoryName} ${formatMoney(c.amountCents)}`).join(' · ')}
                        {previousWeek && delta !== 0
                          ? ` · ${delta > 0 ? '▲' : '▼'} ${formatMoney(Math.abs(delta))} vs. semana anterior`
                          : ''}
                      </p>
                    ) : (
                      <p className="mt-1 text-[12px] text-ink-3">Sem lançamentos.</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </Panel>
        </>
      ) : null}

      {tab === 'categorias' ? (
        <>
          <Panel>
            <PanelHeader
              title="Evolução"
              description={`Receitas e despesas dos últimos ${range} meses`}
              action={
                <Select value={range} onChange={(e) => setRange(Number(e.target.value))} className="h-8 text-[13px]" style={{ width: 'auto' }}>
                  <option value={6}>6 meses</option>
                  <option value={12}>12 meses</option>
                  <option value={24}>24 meses</option>
                </Select>
              }
            />
            <MonthlyBars data={evolution} hide={hide} />
          </Panel>

          <Panel>
            <PanelHeader
              title="Categorias no período"
              description={`${formatMonthLong(months[0]!)} a ${formatMonthLong(months[months.length - 1]!)} · total ${money(periodTotals.expenseCents, hide)}`}
            />
            <RankedBars
              hide={hide}
              items={periodTotals.byRootCategory.map((c) => ({
                id: c.categoryId,
                label: c.categoryName,
                amountCents: c.amountCents,
                color: c.color,
                meta: `${money(Math.round(c.amountCents / months.length), hide)}/mês`,
              }))}
              onSelect={(id) => navigate(`/lancamentos?categoria=${id}&mes=all`)}
            />
          </Panel>

          <Panel>
            <PanelHeader title="Resumo do período" />
            <div className="grid gap-6 p-5 sm:grid-cols-3">
              <Stat label="Receitas" value={money(periodTotals.incomeCents, hide)} tone="in" />
              <Stat label="Despesas" value={money(periodTotals.expenseCents, hide)} tone="out" />
              <Stat
                label="Guardado"
                value={money(periodTotals.netCents, hide, { signed: true })}
                tone={periodTotals.netCents >= 0 ? 'in' : 'out'}
                hint={`taxa média de economia ${formatPercent(periodTotals.savingsRate)}`}
              />
            </div>
            <div className="border-t border-line p-5">
              <p className="mb-2 text-[12px] font-medium text-ink-3 uppercase">Média mensal</p>
              <ul className="grid gap-2 sm:grid-cols-3 text-[13px]">
                <li className="flex justify-between gap-3">
                  <span className="text-ink-2">Receita</span>
                  <span className="tnum text-ink">{money(Math.round(periodTotals.incomeCents / months.length), hide)}</span>
                </li>
                <li className="flex justify-between gap-3">
                  <span className="text-ink-2">Despesa</span>
                  <span className="tnum text-ink">{money(Math.round(periodTotals.expenseCents / months.length), hide)}</span>
                </li>
                <li className="flex justify-between gap-3">
                  <span className="text-ink-2">Sobra</span>
                  <span className="tnum text-ink">{money(Math.round(periodTotals.netCents / months.length), hide)}</span>
                </li>
              </ul>
            </div>
          </Panel>
        </>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
  delta,
  hide,
  inverted,
}: {
  label: string;
  value: string;
  tone?: 'in' | 'out';
  hint?: string;
  delta?: number;
  hide?: boolean;
  inverted?: boolean;
}) {
  // Numa despesa, subir é ruim — o rótulo diz isso em palavras, não só na cor.
  const deltaLabel =
    delta === undefined || delta === 0
      ? undefined
      : `${delta > 0 ? '▲' : '▼'} ${hide ? '••••' : formatMoney(Math.abs(delta))} vs. mês anterior${
          inverted ? (delta > 0 ? ' (gastou mais)' : ' (gastou menos)') : ''
        }`;

  return (
    <div>
      <p className="text-[12px] font-medium text-ink-3 uppercase">{label}</p>
      <p className={`tnum mt-1 text-[22px] font-semibold ${tone === 'in' ? 'text-in' : tone === 'out' ? 'text-out' : 'text-ink'}`}>
        {value}
      </p>
      {deltaLabel ? <p className="mt-0.5 text-[12px] text-ink-2">{deltaLabel}</p> : null}
      {hint ? <p className="mt-0.5 text-[12px] text-ink-2">{hint}</p> : null}
    </div>
  );
}
