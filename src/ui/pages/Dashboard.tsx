/**
 * Dashboard.
 *
 * Cada elemento aqui responde a uma pergunta financeira concreta. O que não
 * responde a nada ficou de fora.
 */

import { useMemo, useState } from 'react';
import { formatMoney, formatPercent } from '../../domain/money';
import {
  addMonthsToMonth,
  currentMonth,
  formatDayMonth,
  formatMonthLong,
  formatWeekRange,
  lastMonths,
  startOfWeek,
  today as todayOf,
} from '../../domain/dates';
import { accountBalances, averageExpense, monthSummary, weekSummary } from '../../domain/engine';
import { availability } from '../../domain/commitments';
import { budgetOverall, budgetStatuses } from '../../domain/budget';
import { cardUsage, currentInvoice } from '../../domain/invoice';
import { buildAlerts } from '../../domain/alerts';
import type { FinanceDataset } from '../../domain/types';
import { Badge, Button, EmptyState, Panel, PanelHeader } from '../components/primitives';
import { MonthlyBars, Meter, RankedBars, SplitBar, StatTile } from '../components/charts';
import { money } from '../format';
import { navigate } from '../router';

export function Dashboard({ data, onAdd }: { data: FinanceDataset; onAdd: () => void }) {
  const today = todayOf();
  const month = currentMonth();
  const hide = data.settings.hideAmounts;
  const [weekOffset, setWeekOffset] = useState(0);

  const categoryMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories]);

  const summary = useMemo(
    () => monthSummary(month, data.transactions, categoryMap),
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

  const balances = useMemo(
    () => accountBalances(data.accounts.filter((a) => !a.archived), data.transactions, today),
    [data.accounts, data.transactions, today],
  );

  const view = useMemo(
    () =>
      availability({
        accounts: data.accounts,
        cards: data.cards,
        transactions: data.transactions,
        recurring: data.recurring,
        today,
        horizonMonths: data.settings.commitmentHorizonMonths,
      }),
    [data, today],
  );

  const evolution = useMemo(() => {
    return lastMonths(month, 6).map((m) => {
      const s = monthSummary(m, data.transactions, categoryMap);
      return { month: m, incomeCents: s.incomeCents, expenseCents: s.expenseCents };
    });
  }, [month, data.transactions, categoryMap]);

  const budgets = useMemo(
    () => budgetStatuses(month, data.budgets, data.categories, data.transactions, data.settings.budgetWarnRatio),
    [month, data.budgets, data.categories, data.transactions, data.settings.budgetWarnRatio],
  );
  const budgetTotal = budgetOverall(budgets);

  const week = useMemo(() => {
    const reference = startOfWeek(today, data.settings.firstDayOfWeek);
    const start = weekOffset === 0 ? reference : shiftWeek(reference, weekOffset);
    return { start, summary: weekSummary(start, data.transactions, categoryMap, data.settings.firstDayOfWeek) };
  }, [today, weekOffset, data.transactions, categoryMap, data.settings.firstDayOfWeek]);

  const alerts = useMemo(() => buildAlerts(data, today), [data, today]);

  const invoices = useMemo(
    () =>
      data.cards
        .filter((c) => !c.archived)
        .map((card) => ({ card, invoice: currentInvoice(card, data.transactions, today), usage: cardUsage(card, data.transactions) })),
    [data.cards, data.transactions, today],
  );

  if (data.accounts.length === 0 && data.transactions.length === 0) {
    return (
      <Panel>
        <EmptyState
          title="Vamos começar"
          description="Cadastre sua conta, adicione o primeiro lançamento ou importe um extrato. Se quiser conhecer a plataforma antes, dá para carregar dados fictícios nas Configurações."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" onClick={() => navigate('/contas')}>
                Cadastrar conta
              </Button>
              <Button onClick={() => navigate('/importar')}>Importar extrato</Button>
              <Button variant="ghost" onClick={() => navigate('/configuracoes')}>
                Ver dados de exemplo
              </Button>
            </div>
          }
        />
      </Panel>
    );
  }

  const netDelta = summary.netCents - previous.netCents;
  const expenseDelta = average > 0 ? (summary.expenseCents - average) / average : 0;

  return (
    <div className="space-y-5">
      {alerts.length > 0 ? <AlertStrip alerts={alerts.slice(0, 3)} total={alerts.length} /> : null}

      {/* Os quatro números que respondem "como estou agora?" */}
      <Panel className="p-5">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Saldo atual"
            value={money(view.balanceCents, hide)}
            hint={`${balances.length} conta${balances.length === 1 ? '' : 's'}`}
            emphasis
          />
          <StatTile
            label="Disponível"
            value={money(view.availableCents, hide)}
            tone={view.availableCents < 0 ? 'out' : undefined}
            hint={`já descontando ${money(view.committedCents, hide)} comprometidos até o fim do mês`}
            emphasis
          />
          <StatTile
            label={`Receitas · ${formatMonthLong(month).split(' de ')[0]}`}
            value={money(summary.incomeCents, hide)}
            tone="in"
            hint={compare(summary.incomeCents, previous.incomeCents, hide)}
          />
          <StatTile
            label={`Despesas · ${formatMonthLong(month).split(' de ')[0]}`}
            value={money(summary.expenseCents, hide)}
            tone="out"
            hint={
              average > 0
                ? `média dos 3 meses: ${money(average, hide)} (${expenseDelta >= 0 ? '+' : ''}${formatPercent(expenseDelta, 0)})`
                : undefined
            }
          />
        </div>

        <div className="mt-5 grid gap-6 border-t border-line pt-5 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Saldo do mês"
            value={money(summary.netCents, hide, { signed: true })}
            tone={summary.netCents >= 0 ? 'in' : 'out'}
            hint={`${netDelta >= 0 ? 'melhor' : 'pior'} que o mês passado em ${money(Math.abs(netDelta), hide)}`}
          />
          <StatTile
            label="Taxa de economia"
            value={summary.incomeCents > 0 ? formatPercent(summary.savingsRate) : '—'}
            hint="do que entrou, quanto sobrou"
          />
          <StatTile
            label="Comprometido"
            value={money(view.future.totalCents, hide)}
            hint={`faturas, parcelas e contas fixas dos próximos ${data.settings.commitmentHorizonMonths} meses`}
          />
          <StatTile
            label="Orçamento usado"
            value={budgetTotal.limitCents > 0 ? formatPercent(budgetTotal.usageRatio, 0) : '—'}
            hint={
              budgetTotal.limitCents > 0
                ? `${money(budgetTotal.spentCents, hide)} de ${money(budgetTotal.limitCents, hide)}`
                : 'nenhum limite definido ainda'
            }
          />
        </div>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Evolução mensal"
            description="Receitas e despesas dos últimos 6 meses"
            action={
              <Button size="sm" variant="ghost" onClick={() => navigate('/relatorios')}>
                Relatórios
              </Button>
            }
          />
          <MonthlyBars data={evolution} hide={hide} />
        </Panel>

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
            <div className="mt-5 space-y-2 border-t border-line pt-4 text-[13px]">
              <Row label="No cartão de crédito" value={money(summary.cardExpenseCents, hide)} />
              <Row label="Direto da conta" value={money(summary.accountExpenseCents, hide)} />
              <Row label="Em parcelas deste mês" value={money(summary.installmentCents, hide)} />
            </div>
          </div>
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Onde você está gastando"
            description={formatMonthLong(month)}
            action={
              <Button size="sm" variant="ghost" onClick={() => navigate('/relatorios')}>
                Ver tudo
              </Button>
            }
          />
          <RankedBars
            hide={hide}
            items={summary.byRootCategory.slice(0, 6).map((c) => ({
              id: c.categoryId,
              label: c.categoryName,
              amountCents: c.amountCents,
              color: c.color,
              meta: `${c.count} lançamento${c.count === 1 ? '' : 's'}`,
            }))}
            onSelect={(id) => navigate(`/lancamentos?categoria=${id}&mes=${month}`)}
          />
        </Panel>

        <Panel>
          <PanelHeader
            title="Semana"
            description={formatWeekRange(week.start)}
            action={
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setWeekOffset((v) => v - 1)} aria-label="Semana anterior">
                  ←
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setWeekOffset((v) => Math.min(v + 1, 0))}
                  disabled={weekOffset >= 0}
                  aria-label="Próxima semana"
                >
                  →
                </Button>
              </div>
            }
          />
          <div className="space-y-2 p-5 text-[13px]">
            <Row label="Entrou" value={money(week.summary.incomeCents, hide)} tone="in" />
            <Row label="Saiu" value={money(week.summary.expenseCents, hide)} tone="out" />
            <Row
              label="Saldo da semana"
              value={money(week.summary.netCents, hide, { signed: true })}
              tone={week.summary.netCents >= 0 ? 'in' : 'out'}
              strong
            />
            {week.summary.byRootCategory.length > 0 ? (
              <div className="mt-4 border-t border-line pt-4">
                <p className="mb-2 text-[12px] font-medium text-ink-3 uppercase">Maiores categorias</p>
                {week.summary.byRootCategory.slice(0, 3).map((c) => (
                  <Row key={c.categoryId} label={c.categoryName} value={money(c.amountCents, hide)} />
                ))}
              </div>
            ) : (
              <p className="pt-2 text-ink-3">Nenhum lançamento nesta semana.</p>
            )}
          </div>
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel>
          <PanelHeader
            title="Cartões"
            action={
              <Button size="sm" variant="ghost" onClick={() => navigate('/cartoes')}>
                Ver faturas
              </Button>
            }
          />
          {invoices.length === 0 ? (
            <EmptyState title="Nenhum cartão cadastrado" action={<Button size="sm" onClick={() => navigate('/cartoes')}>Cadastrar</Button>} />
          ) : (
            <ul className="divide-y divide-line">
              {invoices.map(({ card, invoice, usage }) => (
                <li key={card.id} className="px-5 py-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
                      <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: card.color }} />
                      {card.name}
                    </span>
                    <span className="tnum text-[13px] font-medium text-ink">{money(invoice.totalCents, hide)}</span>
                  </div>
                  <p className="mt-1 text-[12px] text-ink-2">
                    Fatura atual · fecha {formatDayMonth(invoice.end)} · vence {formatDayMonth(invoice.dueDate)}
                  </p>
                  <div className="mt-2.5">
                    <Meter
                      usageRatio={usage.usageRatio}
                      tone={usage.usageRatio >= 1 ? 'critical' : usage.usageRatio >= 0.85 ? 'warning' : 'good'}
                    />
                    <p className="mt-1.5 text-[12px] text-ink-3">
                      {money(usage.availableCents, hide)} de limite disponível
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel>
          <PanelHeader
            title="Orçamento"
            description={formatMonthLong(month)}
            action={
              <Button size="sm" variant="ghost" onClick={() => navigate('/orcamento')}>
                Ajustar
              </Button>
            }
          />
          {budgets.length === 0 ? (
            <EmptyState
              title="Nenhum limite definido"
              description="Defina limites mensais para acompanhar quanto ainda pode gastar em cada categoria."
              action={<Button size="sm" onClick={() => navigate('/orcamento')}>Definir</Button>}
            />
          ) : (
            <ul className="divide-y divide-line">
              {budgets.slice(0, 5).map((status) => (
                <li key={status.categoryId} className="px-5 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-[13px] text-ink">{status.categoryName}</span>
                    <span className="tnum shrink-0 text-[12px] text-ink-2">
                      {money(status.spentCents, hide)} / {money(status.limitCents, hide)}
                    </span>
                  </div>
                  <div className="mt-2">
                    <Meter usageRatio={status.usageRatio} tone={status.over ? 'critical' : status.warn ? 'warning' : 'good'} />
                  </div>
                  <p className="mt-1.5 text-[12px] text-ink-3">
                    {status.over
                      ? `▲ ${money(-status.remainingCents, hide)} acima do limite`
                      : `${money(status.remainingCents, hide)} restantes`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel>
          <PanelHeader
            title="Próximos compromissos"
            action={
              <Button size="sm" variant="ghost" onClick={() => navigate('/futuro')}>
                Ver futuro
              </Button>
            }
          />
          {view.future.items.length === 0 ? (
            <EmptyState title="Nada comprometido" description="Nenhuma fatura, parcela ou conta fixa em aberto." />
          ) : (
            <ul className="divide-y divide-line">
              {view.future.items.slice(0, 6).map((item) => (
                <li key={item.id} className="flex items-baseline justify-between gap-3 px-5 py-3">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-ink">{item.label}</span>
                    <span className="text-[12px] text-ink-3">
                      {formatDayMonth(item.dueDate)}
                      {item.detail ? ` · ${item.detail}` : ''}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {item.overdue ? <Badge tone="critical">vencido</Badge> : null}
                    <span className="tnum text-[13px] text-ink">{money(item.amountCents, hide)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel>
        <PanelHeader
          title="Maiores despesas do mês"
          action={
            <Button size="sm" variant="primary" onClick={onAdd}>
              Adicionar lançamento
            </Button>
          }
        />
        {summary.largestExpenses.length === 0 ? (
          <EmptyState title="Nenhuma despesa registrada neste mês" />
        ) : (
          <ul className="divide-y divide-line">
            {summary.largestExpenses.map((tx) => (
              <li key={tx.id} className="flex items-baseline justify-between gap-3 px-5 py-3">
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-ink">{tx.description}</span>
                  <span className="text-[12px] text-ink-3">
                    {formatDayMonth(tx.date)}
                    {tx.categoryId ? ` · ${categoryMap.get(tx.categoryId)?.name ?? ''}` : ''}
                    {tx.installmentTotal && tx.installmentTotal > 1
                      ? ` · parcela ${tx.installmentNumber}/${tx.installmentTotal}`
                      : ''}
                  </span>
                </span>
                <span className="tnum shrink-0 text-[13px] text-ink">{money(tx.amountCents, hide)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function shiftWeek(start: string, offset: number): string {
  const date = new Date(`${start}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset * 7);
  return date.toISOString().slice(0, 10);
}

function compare(current: number, previous: number, hide: boolean): string | undefined {
  if (previous === 0) return undefined;
  const delta = current - previous;
  return `${delta >= 0 ? '+' : '−'}${hide ? '••••' : formatMoney(Math.abs(delta))} vs. mês passado`;
}

function Row({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: 'in' | 'out';
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={strong ? 'text-ink' : 'text-ink-2'}>{label}</span>
      <span
        className={`tnum ${strong ? 'font-medium' : ''} ${
          tone === 'in' ? 'text-in' : tone === 'out' ? 'text-out' : 'text-ink'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function AlertStrip({ alerts, total }: { alerts: ReturnType<typeof buildAlerts>; total: number }) {
  return (
    <div className="space-y-2">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border px-4 py-2.5 text-[13px] ${
            alert.severity === 'danger'
              ? 'border-critical/40 bg-critical/8 text-critical-ink'
              : alert.severity === 'warn'
                ? 'border-warning/40 bg-warning/8 text-warning-ink'
                : 'border-line bg-surface text-ink-2'
          }`}
        >
          <span aria-hidden className="text-[11px]">
            {alert.severity === 'danger' ? '●' : alert.severity === 'warn' ? '▲' : 'ⓘ'}
          </span>
          <span className="font-medium">{alert.title}</span>
          <span className="text-ink-2">{alert.message}</span>
          {alert.href ? (
            <a href={alert.href} className="ml-auto shrink-0 underline underline-offset-2">
              {alert.actionLabel ?? 'Ver'}
            </a>
          ) : null}
        </div>
      ))}
      {total > alerts.length ? (
        <a href="#/diagnostico" className="block text-[12px] text-ink-3 underline underline-offset-2">
          + {total - alerts.length} outro(s) alerta(s)
        </a>
      ) : null}
    </div>
  );
}
