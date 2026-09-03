/**
 * Futuro financeiro.
 *
 *   SALDO ATUAL − COMPROMISSOS = VALOR REALMENTE DISPONÍVEL
 *
 * A conta que evita a surpresa no fim do mês.
 */

import { useMemo, useState } from 'react';
import { addMonthsToMonth, endOfMonth, formatMonthShort, formatDayMonth, monthOf, relativeDay, today as todayOf } from '../../domain/dates';
import { availability, COMMITMENT_KIND_LABEL, installmentPlans } from '../../domain/commitments';
import type { FinanceDataset } from '../../domain/types';
import { Badge, Button, EmptyState, Panel, PanelHeader, Select } from '../components/primitives';
import { money } from '../format';

export function Future({ data }: { data: FinanceDataset }) {
  const today = todayOf();
  const hide = data.settings.hideAmounts;

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

  // A lista completa de 12 meses passa de 60 linhas e deixa de ser legível.
  // O total continua sendo do horizonte inteiro; só a LISTA é recortada.
  const [listMonths, setListMonths] = useState(3);
  const listLimit = endOfMonth(addMonthsToMonth(monthOf(today), listMonths - 1));
  const listItems = useMemo(
    () => view.future.items.filter((item) => item.dueDate <= listLimit),
    [view.future.items, listLimit],
  );

  const plans = useMemo(() => installmentPlans(data.transactions, today), [data.transactions, today]);
  const maxMonth = Math.max(1, ...view.future.byMonth.map((m) => m.amountCents));
  const cardName = (id?: string) => data.cards.find((c) => c.id === id)?.name;

  return (
    <div className="space-y-5">
      <Panel className="p-6">
        <div className="grid items-center gap-6 sm:grid-cols-[1fr_auto_1fr_auto_1fr]">
          <Figure label="Saldo atual" value={money(view.balanceCents, hide)} />
          <Operator symbol="−" />
          <Figure
            label="Comprometido até o fim do mês"
            value={money(view.committedCents, hide)}
            tone="out"
          />
          <Operator symbol="=" />
          <Figure
            label="Realmente disponível"
            value={money(view.availableCents, hide)}
            tone={view.availableCents < 0 ? 'out' : 'in'}
            emphasis
          />
        </div>
        <p className="mt-5 border-t border-line pt-4 text-[13px] text-ink-2">
          {view.availableCents < 0
            ? `Faltam ${money(-view.availableCents, hide)} para cobrir o que já está comprometido neste mês.`
            : `Depois de honrar faturas, parcelas e contas fixas deste mês, sobram ${money(view.availableCents, hide)}.`}{' '}
          Considerando os próximos {data.settings.commitmentHorizonMonths} meses, o total comprometido é{' '}
          {money(view.future.totalCents, hide)}.
        </p>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel>
          <PanelHeader title="Do que é feito" description="Nada é contado duas vezes" />
          <div className="space-y-3 p-5 text-[13px]">
            <Line label="Faturas de cartão em aberto" value={money(view.future.invoiceCents, hide)} />
            <Line label="Despesas agendadas e previstas" value={money(view.future.scheduledCents, hide)} />
            <Line label="Contas fixas ainda não lançadas" value={money(view.future.recurringCents, hide)} />
            <div className="border-t border-line pt-3">
              <Line label="Total" value={money(view.future.totalCents, hide)} strong />
            </div>
            <p className="pt-1 text-[12px] text-ink-3">
              As parcelas futuras já estão dentro das faturas — por isso não aparecem somadas outra vez.
            </p>
          </div>
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader title="Comprometido por mês" description="Quanto de cada mês já tem dono" />
          {view.future.byMonth.length === 0 ? (
            <EmptyState title="Nenhum compromisso à frente" />
          ) : (
            <ul className="space-y-3 p-5">
              {view.future.byMonth.map((entry) => (
                <li key={entry.month}>
                  <div className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="text-ink-2">{formatMonthShort(entry.month)}</span>
                    <span className="tnum font-medium text-ink">{money(entry.amountCents, hide)}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max((entry.amountCents / maxMonth) * 100, 2)}%`,
                        backgroundColor: 'var(--seq-400)',
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel>
        <PanelHeader
          title="Compromissos"
          description={`${listItems.length} de ${view.future.items.length} · faturas, parcelas, agendamentos e contas fixas`}
          action={
            <Select
              value={listMonths}
              onChange={(e) => setListMonths(Number(e.target.value))}
              className="h-8 text-[13px]"
              style={{ width: 'auto' }}
              aria-label="Período da lista"
            >
              <option value={1}>Este mês</option>
              <option value={3}>Próximos 3 meses</option>
              <option value={6}>Próximos 6 meses</option>
              <option value={data.settings.commitmentHorizonMonths}>
                Tudo ({data.settings.commitmentHorizonMonths} meses)
              </option>
            </Select>
          }
        />
        {listItems.length === 0 ? (
          <EmptyState title="Nada comprometido neste período" />
        ) : (
          <ul className="divide-y divide-line">
            {listItems.map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-3">
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] text-ink">{item.label}</span>
                    <Badge tone="neutral">{COMMITMENT_KIND_LABEL[item.kind]}</Badge>
                    {item.overdue ? <Badge tone="critical">vencido</Badge> : null}
                  </span>
                  <span className="mt-0.5 block text-[12px] text-ink-3">
                    {formatDayMonth(item.dueDate)} · {relativeDay(item.dueDate, today)}
                    {item.detail ? ` · ${item.detail}` : ''}
                  </span>
                </span>
                <span className="tnum shrink-0 text-[13px] font-medium text-ink">
                  {money(item.amountCents, hide)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {listItems.length < view.future.items.length ? (
          <div className="border-t border-line p-4 text-center">
            <Button size="sm" onClick={() => setListMonths(data.settings.commitmentHorizonMonths)}>
              Ver os {view.future.items.length - listItems.length} compromissos seguintes
            </Button>
          </div>
        ) : null}
      </Panel>

      <Panel>
        <PanelHeader title="Compras parceladas" description="Quanto já foi pago e quanto ainda falta" />
        {plans.length === 0 ? (
          <EmptyState title="Nenhuma compra parcelada em andamento" />
        ) : (
          <ul className="divide-y divide-line">
            {plans.map((plan) => (
              <li key={plan.groupId} className="px-5 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] text-ink">{plan.description}</span>
                    <span className="text-[12px] text-ink-3">
                      {cardName(plan.cardId) ? `${cardName(plan.cardId)} · ` : ''}
                      {plan.paidCount} de {plan.installmentTotal} pagas
                      {plan.nextDate ? ` · próxima em ${formatDayMonth(plan.nextDate)}` : ' · concluída'}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="tnum block text-[14px] font-medium text-ink">
                      {money(plan.remainingCents, hide)}
                    </span>
                    <span className="text-[12px] text-ink-3">ainda a pagar</span>
                  </span>
                </div>
                <div className="mt-2.5 flex gap-0.5">
                  {Array.from({ length: plan.installmentTotal }, (_, index) => (
                    <span
                      key={index}
                      className="h-1.5 flex-1 rounded-full"
                      style={{
                        backgroundColor: index < plan.paidCount ? 'var(--seq-400)' : 'var(--surface-2)',
                      }}
                    />
                  ))}
                </div>
                <p className="mt-2 text-[12px] text-ink-3">
                  Total de {money(plan.totalCents, hide)} · {money(plan.paidCents, hide)} já pagos · última parcela em{' '}
                  {formatDayMonth(plan.lastDate)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
  emphasis,
}: {
  label: string;
  value: string;
  tone?: 'in' | 'out';
  emphasis?: boolean;
}) {
  return (
    <div>
      <p className="text-[12px] font-medium text-ink-3 uppercase">{label}</p>
      <p
        className={`tnum mt-1 font-semibold tracking-[-0.02em] ${emphasis ? 'text-[30px]' : 'text-[22px]'} ${
          tone === 'out' ? 'text-out' : tone === 'in' ? 'text-in' : 'text-ink'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function Operator({ symbol }: { symbol: string }) {
  return (
    <span aria-hidden className="hidden text-[22px] text-ink-3 sm:block">
      {symbol}
    </span>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={strong ? 'text-ink' : 'text-ink-2'}>{label}</span>
      <span className={`tnum ${strong ? 'font-medium text-ink' : 'text-ink'}`}>{value}</span>
    </div>
  );
}
