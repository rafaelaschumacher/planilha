/**
 * Gráficos.
 *
 * São poucos de propósito: cada um responde a uma pergunta financeira
 * específica. Nada de gráfico decorativo.
 *
 * Regras seguidas aqui:
 *  · Duas séries (entradas x saídas) usam o par divergente azul/vermelho,
 *    validado para daltonismo. A cor nunca carrega o sentido sozinha: há
 *    legenda, rótulo em texto e sinal no valor.
 *  · Ranking de categorias é MAGNITUDE, não identidade — então usa um único
 *    tom em intensidade variável, e não um arco-íris de cores.
 *  · Um único eixo. Nunca dois eixos verticais no mesmo gráfico.
 *  · Todo gráfico tem alternativa em tabela.
 */

import { useState, type ReactNode } from 'react';
import { formatMoney, ratio, type Cents } from '../../domain/money';
import { formatMonthShort, type ISOMonth } from '../../domain/dates';
import { cx } from '../format';

const CHART_HEIGHT = 200;

function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

// ---------------------------------------------------------------------------
// Legenda
// ---------------------------------------------------------------------------

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-[12px] text-ink-2">
          <span aria-hidden className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Evolução mensal: receitas x despesas
// ---------------------------------------------------------------------------

export interface MonthlyPoint {
  month: ISOMonth;
  incomeCents: Cents;
  expenseCents: Cents;
}

export function MonthlyBars({ data, hide }: { data: MonthlyPoint[]; hide: boolean }) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  if (data.length === 0) {
    return <p className="px-5 py-10 text-center text-[13px] text-ink-3">Sem dados suficientes ainda.</p>;
  }

  const max = niceCeil(Math.max(1, ...data.flatMap((d) => [d.incomeCents, d.expenseCents])));
  const groupWidth = 100 / data.length;
  const barWidth = Math.min(groupWidth * 0.32, 9);

  return (
    <div className="px-5 pb-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Legend
          items={[
            { label: 'Receitas', color: 'var(--series-in)' },
            { label: 'Despesas', color: 'var(--series-out)' },
          ]}
        />
        <button
          type="button"
          onClick={() => setTable((v) => !v)}
          className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink-2"
        >
          {table ? 'ver gráfico' : 'ver tabela'}
        </button>
      </div>

      {table ? (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] tnum">
            <thead>
              <tr className="text-left text-ink-3">
                <th className="py-1 font-medium">Mês</th>
                <th className="py-1 text-right font-medium">Receitas</th>
                <th className="py-1 text-right font-medium">Despesas</th>
                <th className="py-1 text-right font-medium">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {data.map((point) => (
                <tr key={point.month} className="border-t border-line">
                  <td className="py-1.5">{formatMonthShort(point.month)}</td>
                  <td className="py-1.5 text-right">{hide ? '••••' : formatMoney(point.incomeCents)}</td>
                  <td className="py-1.5 text-right">{hide ? '••••' : formatMoney(point.expenseCents)}</td>
                  <td className="py-1.5 text-right">
                    {hide ? '••••' : formatMoney(point.incomeCents - point.expenseCents, { signed: true })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 100 ${CHART_HEIGHT}`}
            preserveAspectRatio="none"
            className="h-[200px] w-full"
            role="img"
            aria-label="Receitas e despesas por mês"
          >
            {[0, 0.5, 1].map((fraction) => (
              <line
                key={fraction}
                x1="0"
                x2="100"
                y1={CHART_HEIGHT - fraction * CHART_HEIGHT}
                y2={CHART_HEIGHT - fraction * CHART_HEIGHT}
                stroke="var(--grid)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {data.map((point, index) => {
              const center = index * groupWidth + groupWidth / 2;
              const incomeHeight = (point.incomeCents / max) * (CHART_HEIGHT - 8);
              const expenseHeight = (point.expenseCents / max) * (CHART_HEIGHT - 8);
              return (
                <g key={point.month}>
                  {hover === index ? (
                    <rect
                      x={index * groupWidth}
                      y={0}
                      width={groupWidth}
                      height={CHART_HEIGHT}
                      fill="var(--surface-2)"
                    />
                  ) : null}
                  <rect
                    x={center - barWidth - 1}
                    y={CHART_HEIGHT - incomeHeight}
                    width={barWidth}
                    height={Math.max(incomeHeight, 1)}
                    rx="1.5"
                    fill="var(--series-in)"
                  />
                  <rect
                    x={center + 1}
                    y={CHART_HEIGHT - expenseHeight}
                    width={barWidth}
                    height={Math.max(expenseHeight, 1)}
                    rx="1.5"
                    fill="var(--series-out)"
                  />
                  <rect
                    x={index * groupWidth}
                    y={0}
                    width={groupWidth}
                    height={CHART_HEIGHT}
                    fill="transparent"
                    onMouseEnter={() => setHover(index)}
                    onMouseLeave={() => setHover(null)}
                  />
                </g>
              );
            })}
          </svg>

          <div className="mt-1 flex text-[11px] text-ink-3">
            {data.map((point) => (
              <span key={point.month} className="flex-1 text-center">
                {formatMonthShort(point.month)}
              </span>
            ))}
          </div>

          {hover !== null && data[hover] ? (
            <div
              className="pointer-events-none absolute top-2 rounded-[10px] border border-line bg-surface px-3 py-2 text-[12px] shadow-lg"
              style={{
                left: `${Math.min(Math.max(hover * groupWidth + groupWidth / 2, 14), 82)}%`,
                transform: 'translateX(-50%)',
              }}
            >
              <p className="mb-1 font-medium text-ink">{formatMonthShort(data[hover]!.month)}</p>
              <p className="tnum text-in">Receitas {hide ? '••••' : formatMoney(data[hover]!.incomeCents)}</p>
              <p className="tnum text-out">Despesas {hide ? '••••' : formatMoney(data[hover]!.expenseCents)}</p>
              <p className="tnum mt-1 border-t border-line pt-1 text-ink-2">
                Saldo{' '}
                {hide ? '••••' : formatMoney(data[hover]!.incomeCents - data[hover]!.expenseCents, { signed: true })}
              </p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ranking de categorias — magnitude, um só tom
// ---------------------------------------------------------------------------

export interface RankedItem {
  id: string;
  label: string;
  amountCents: Cents;
  /** Cor da categoria: vira só um ponto de identidade ao lado do rótulo. */
  color?: string;
  meta?: string;
}

export function RankedBars({
  items,
  hide,
  onSelect,
}: {
  items: RankedItem[];
  hide: boolean;
  onSelect?: (id: string) => void;
}) {
  if (items.length === 0) {
    return <p className="px-5 py-10 text-center text-[13px] text-ink-3">Nenhuma despesa no período.</p>;
  }
  const max = Math.max(...items.map((i) => i.amountCents));
  const total = items.reduce((sum, i) => sum + i.amountCents, 0);

  // Intensidade acompanha a magnitude: a maior barra recebe o tom mais forte.
  const shade = (value: number) => {
    const r = max > 0 ? value / max : 0;
    if (r > 0.75) return 'var(--seq-550)';
    if (r > 0.5) return 'var(--seq-400)';
    if (r > 0.25) return 'var(--seq-250)';
    return 'var(--seq-100)';
  };

  return (
    <ul className="divide-y divide-line">
      {items.map((item) => {
        const share = ratio(item.amountCents, total);
        const Row = onSelect ? 'button' : 'div';
        return (
          <li key={item.id}>
            <Row
              {...(onSelect ? { type: 'button' as const, onClick: () => onSelect(item.id) } : {})}
              className={cx(
                'block w-full px-5 py-3 text-left',
                onSelect && 'transition-colors hover:bg-surface-hover',
              )}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  {item.color ? (
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: item.color }}
                    />
                  ) : null}
                  <span className="truncate text-[13px] text-ink">{item.label}</span>
                </span>
                <span className="tnum shrink-0 text-[13px] font-medium text-ink">
                  {hide ? '••••' : formatMoney(item.amountCents)}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max((item.amountCents / max) * 100, 2)}%`,
                      backgroundColor: shade(item.amountCents),
                    }}
                  />
                </div>
                <span className="tnum w-20 shrink-0 text-right text-[11px] text-ink-3">
                  {item.meta ?? `${(share * 100).toFixed(1).replace('.', ',')}% do total`}
                </span>
              </div>
            </Row>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Barra de duas partes (fixos x variáveis)
// ---------------------------------------------------------------------------

export function SplitBar({
  segments,
  hide,
}: {
  segments: { label: string; amountCents: Cents; color: string }[];
  hide: boolean;
}) {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.amountCents), 0);
  if (total <= 0) {
    return <p className="text-[13px] text-ink-3">Sem despesas no período.</p>;
  }
  return (
    <div>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full">
        {segments.map((segment) => (
          <div
            key={segment.label}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${Math.max((Math.max(0, segment.amountCents) / total) * 100, 0)}%`,
              backgroundColor: segment.color,
            }}
          />
        ))}
      </div>
      <ul className="mt-3 space-y-1.5">
        {segments.map((segment) => (
          <li key={segment.label} className="flex items-center justify-between gap-3 text-[13px]">
            <span className="flex items-center gap-2 text-ink-2">
              <span aria-hidden className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: segment.color }} />
              {segment.label}
            </span>
            <span className="tnum text-ink">
              {hide ? '••••' : formatMoney(segment.amountCents)}
              <span className="ml-2 text-ink-3">
                {((Math.max(0, segment.amountCents) / total) * 100).toFixed(0)}%
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Medidor de orçamento
// ---------------------------------------------------------------------------

export function Meter({
  usageRatio,
  tone,
}: {
  usageRatio: number;
  tone: 'good' | 'warning' | 'critical';
}) {
  const color = tone === 'critical' ? 'var(--critical)' : tone === 'warning' ? 'var(--warning)' : 'var(--good)';
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
      <div
        className="h-full rounded-full transition-[width]"
        style={{ width: `${Math.min(Math.max(usageRatio, 0), 1) * 100}%`, backgroundColor: color }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Números em destaque
// ---------------------------------------------------------------------------

export function StatTile({
  label,
  value,
  hint,
  tone,
  emphasis,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'in' | 'out' | 'neutral';
  emphasis?: boolean;
}) {
  const valueColor = tone === 'in' ? 'text-in' : tone === 'out' ? 'text-out' : 'text-ink';
  return (
    <div className="min-w-0">
      <p className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">{label}</p>
      <p
        className={cx(
          'mt-1 truncate font-semibold tracking-[-0.02em] tnum',
          emphasis ? 'text-[28px] leading-tight' : 'text-[20px] leading-tight',
          valueColor,
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 truncate text-[12px] text-ink-2">{hint}</p> : null}
    </div>
  );
}
