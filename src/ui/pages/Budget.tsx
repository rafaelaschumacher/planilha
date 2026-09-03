/** Orçamento mensal por categoria. Subcategorias somam na categoria mãe. */

import { useMemo, useState } from 'react';
import { formatMoney, formatPercent, parseMoney } from '../../domain/money';
import { addMonthsToMonth, currentMonth, formatMonthLong } from '../../domain/dates';
import { budgetOverall, budgetStatuses } from '../../domain/budget';
import { newId } from '../../domain/transaction';
import type { Budget as BudgetType, FinanceDataset } from '../../domain/types';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Notice,
  Panel,
  PanelHeader,
  Select,
  Toggle,
} from '../components/primitives';
import { Meter } from '../components/charts';
import { money } from '../format';
import { navigate } from '../router';

export function Budget({
  data,
  onSave,
  onDelete,
}: {
  data: FinanceDataset;
  onSave: (budget: BudgetType) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const hide = data.settings.hideAmounts;
  const [month, setMonth] = useState(currentMonth());
  const [editing, setEditing] = useState<BudgetType | null>(null);
  const [creating, setCreating] = useState(false);

  const statuses = useMemo(
    () => budgetStatuses(month, data.budgets, data.categories, data.transactions, data.settings.budgetWarnRatio),
    [month, data.budgets, data.categories, data.transactions, data.settings.budgetWarnRatio],
  );
  const overall = budgetOverall(statuses);

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHeader
          title="Orçamento"
          description={formatMonthLong(month)}
          action={
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setMonth(addMonthsToMonth(month, -1))}>
                ←
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMonth(currentMonth())}>
                Mês atual
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMonth(addMonthsToMonth(month, 1))}>
                →
              </Button>
              <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                Novo limite
              </Button>
            </div>
          }
        />

        {statuses.length === 0 ? (
          <EmptyState
            title="Nenhum limite definido"
            description="Defina quanto pretende gastar em cada categoria por mês. A plataforma acompanha o consumo e avisa antes de estourar."
            action={
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                Definir primeiro limite
              </Button>
            }
          />
        ) : (
          <>
            <div className="grid gap-5 border-b border-line p-5 sm:grid-cols-4">
              <Stat label="Limite total" value={money(overall.limitCents, hide)} />
              <Stat label="Gasto" value={money(overall.spentCents, hide)} />
              <Stat
                label="Restante"
                value={money(overall.remainingCents, hide)}
                tone={overall.remainingCents < 0 ? 'out' : undefined}
              />
              <Stat
                label="Utilizado"
                value={formatPercent(overall.usageRatio, 0)}
                hint={
                  overall.overCount > 0
                    ? `${overall.overCount} categoria(s) acima do limite`
                    : overall.warnCount > 0
                      ? `${overall.warnCount} perto do limite`
                      : 'tudo dentro do planejado'
                }
              />
            </div>

            <ul className="divide-y divide-line">
              {statuses.map((status) => {
                const budget = data.budgets.find(
                  (b) => b.categoryId === status.categoryId && (b.month === month || b.month === null),
                );
                return (
                  <li key={status.categoryId} className="px-5 py-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <span className="flex items-center gap-2">
                        <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: status.color }} />
                        <span className="text-[14px] font-medium text-ink">{status.categoryName}</span>
                        {status.over ? (
                          <Badge tone="critical">▲ estourou</Badge>
                        ) : status.warn ? (
                          <Badge tone="warning">▲ perto do limite</Badge>
                        ) : null}
                        {status.fromDefault ? <Badge tone="neutral">limite padrão</Badge> : null}
                      </span>
                      <span className="tnum text-[13px] text-ink-2">
                        {money(status.spentCents, hide)} de {money(status.limitCents, hide)}
                      </span>
                    </div>

                    <div className="mt-2.5">
                      <Meter
                        usageRatio={status.usageRatio}
                        tone={status.over ? 'critical' : status.warn ? 'warning' : 'good'}
                      />
                    </div>

                    <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-[12px]">
                      <span className={status.over ? 'text-critical-ink' : 'text-ink-3'}>
                        {status.over
                          ? `${money(-status.remainingCents, hide)} acima do limite`
                          : `${money(status.remainingCents, hide)} restantes · ${formatPercent(status.usageRatio, 0)} usado`}
                      </span>
                      <span className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => navigate(`/lancamentos?categoria=${status.categoryId}&mes=${month}`)}
                        >
                          Ver lançamentos
                        </Button>
                        {budget ? (
                          <Button size="sm" variant="ghost" onClick={() => setEditing(budget)}>
                            Ajustar
                          </Button>
                        ) : null}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Panel>

      <BudgetForm
        open={creating || editing !== null}
        budget={editing}
        month={month}
        data={data}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSave={onSave}
        onDelete={onDelete}
      />
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'out' }) {
  return (
    <div>
      <p className="text-[12px] font-medium text-ink-3 uppercase">{label}</p>
      <p className={`tnum mt-1 text-[20px] font-semibold ${tone === 'out' ? 'text-out' : 'text-ink'}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-[12px] text-ink-2">{hint}</p> : null}
    </div>
  );
}

function BudgetForm({
  open,
  budget,
  month,
  data,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  budget: BudgetType | null;
  month: string;
  data: FinanceDataset;
  onClose: () => void;
  onSave: (budget: BudgetType) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [categoryId, setCategoryId] = useState('');
  const [limit, setLimit] = useState('');
  const [monthOnly, setMonthOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState('');

  const currentKey = `${open}-${budget?.id ?? 'new'}-${month}`;
  if (key !== currentKey) {
    setKey(currentKey);
    setCategoryId(budget?.categoryId ?? '');
    setLimit(budget ? (budget.limitCents / 100).toFixed(2).replace('.', ',') : '');
    setMonthOnly(budget ? budget.month !== null : false);
    setError(null);
  }

  const expenseCategories = data.categories.filter((c) => c.kind === 'expense' && !c.archived);

  async function handleSave() {
    const cents = parseMoney(limit);
    if (!categoryId) {
      setError('Escolha a categoria.');
      return;
    }
    if (!cents || cents <= 0) {
      setError('Informe um limite maior que zero.');
      return;
    }
    const now = new Date().toISOString();
    await onSave({
      id: budget?.id ?? newId('bud'),
      categoryId,
      limitCents: cents,
      month: monthOnly ? month : null,
      createdAt: budget?.createdAt ?? now,
      updatedAt: now,
    });
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={budget ? 'Ajustar limite' : 'Novo limite'}
      footer={
        <>
          {budget ? (
            <Button
              variant="danger"
              onClick={async () => {
                await onDelete(budget.id);
                onClose();
              }}
            >
              Remover limite
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={handleSave}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Categoria" hint="O gasto das subcategorias soma automaticamente na categoria mãe.">
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={Boolean(budget)}>
            <option value="">Selecione…</option>
            {expenseCategories
              .filter((c) => !c.parentId)
              .map((root) => (
                <optgroup key={root.id} label={root.name}>
                  <option value={root.id}>{root.name} (com subcategorias)</option>
                  {expenseCategories
                    .filter((c) => c.parentId === root.id)
                    .map((child) => (
                      <option key={child.id} value={child.id}>
                        {child.name}
                      </option>
                    ))}
                </optgroup>
              ))}
          </Select>
        </Field>

        <Field label="Limite mensal" hint={parseMoney(limit) ? formatMoney(parseMoney(limit)!) : undefined}>
          <Input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="0,00" />
        </Field>

        <Toggle
          checked={monthOnly}
          onChange={setMonthOnly}
          label={`Valer só para ${formatMonthLong(month)}`}
          hint="Desmarcado, o limite vale para todos os meses. Um limite específico de um mês sobrescreve o padrão."
        />

        {error ? <Notice tone="critical">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
