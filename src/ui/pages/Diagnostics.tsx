/**
 * Diagnóstico.
 *
 * Roda a mesma auditoria que os testes automatizados usam, agora contra os
 * SEUS dados. Mostra também o que passou — saber o que foi conferido importa
 * tanto quanto saber o que falhou.
 */

import { useMemo, useState } from 'react';
import { today as todayOf } from '../../domain/dates';
import { auditDataset, type AuditFinding } from '../../domain/audit';
import { buildAlerts } from '../../domain/alerts';
import type { FinanceDataset, ID } from '../../domain/types';
import { Badge, Button, Notice, Panel, PanelHeader } from '../components/primitives';
import { navigate } from '../router';

export function Diagnostics({ data, onInspect }: { data: FinanceDataset; onInspect: (ids: ID[]) => void }) {
  const today = todayOf();
  const report = useMemo(() => auditDataset(data, today), [data, today]);
  const alerts = useMemo(() => buildAlerts(data, today), [data, today]);
  const [showPassed, setShowPassed] = useState(false);

  const groups = useMemo(() => {
    const map = new Map<string, AuditFinding[]>();
    for (const finding of report.findings) {
      const list = map.get(finding.group) ?? [];
      list.push(finding);
      map.set(finding.group, list);
    }
    return Array.from(map, ([group, findings]) => ({ group, findings }));
  }, [report.findings]);

  return (
    <div className="space-y-4">
      <Panel className="p-5">
        <div className="grid gap-6 sm:grid-cols-4">
          <Metric label="Lançamentos conferidos" value={String(report.checkedTransactions)} />
          <Metric label="Erros" value={String(report.errorCount)} tone={report.errorCount > 0 ? 'critical' : 'good'} />
          <Metric label="Avisos" value={String(report.warningCount)} tone={report.warningCount > 0 ? 'warning' : 'good'} />
          <Metric label="Verificações aprovadas" value={String(report.passed.length)} tone="good" />
        </div>

        {report.errorCount === 0 && report.warningCount === 0 ? (
          <div className="mt-5 border-t border-line pt-4">
            <Notice tone="good" title="Nenhum problema encontrado">
              Saldos, faturas, parcelas e classificações estão coerentes entre si.
            </Notice>
          </div>
        ) : null}
      </Panel>

      {groups.map(({ group, findings }) => (
        <Panel key={group}>
          <PanelHeader
            title={group}
            description={`${findings.length} ocorrência(s)`}
            action={
              findings.some((f) => f.severity === 'error') ? (
                <Badge tone="critical">precisa de correção</Badge>
              ) : (
                <Badge tone="warning">confira</Badge>
              )
            }
          />
          <ul className="divide-y divide-line">
            {findings.slice(0, 40).map((finding) => (
              <li key={finding.id} className="px-5 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
                      <span
                        aria-hidden
                        className={`text-[11px] ${
                          finding.severity === 'error' ? 'text-critical-ink' : 'text-warning-ink'
                        }`}
                      >
                        {finding.severity === 'error' ? '●' : '▲'}
                      </span>
                      {finding.title}
                    </p>
                    <p className="mt-0.5 text-[12px] text-ink-2">{finding.detail}</p>
                  </div>
                  {finding.transactionIds?.length ? (
                    <Button size="sm" variant="ghost" onClick={() => onInspect(finding.transactionIds!)}>
                      Ver lançamentos
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {findings.length > 40 ? (
            <p className="border-t border-line px-5 py-3 text-[12px] text-ink-3">
              + {findings.length - 40} ocorrência(s) do mesmo tipo.
            </p>
          ) : null}
        </Panel>
      ))}

      {alerts.length > 0 ? (
        <Panel>
          <PanelHeader title="Alertas" description="Coisas que merecem sua atenção agora" />
          <ul className="divide-y divide-line">
            {alerts.map((alert) => (
              <li key={alert.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
                    <span
                      aria-hidden
                      className={`text-[11px] ${
                        alert.severity === 'danger'
                          ? 'text-critical-ink'
                          : alert.severity === 'warn'
                            ? 'text-warning-ink'
                            : 'text-ink-3'
                      }`}
                    >
                      {alert.severity === 'danger' ? '●' : alert.severity === 'warn' ? '▲' : 'ⓘ'}
                    </span>
                    {alert.title}
                  </p>
                  <p className="mt-0.5 text-[12px] text-ink-2">{alert.message}</p>
                </div>
                {alert.href ? (
                  <Button size="sm" variant="ghost" onClick={() => navigate(alert.href!.replace('#', ''))}>
                    {alert.actionLabel ?? 'Ver'}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader
          title="O que foi conferido"
          action={
            <Button size="sm" variant="ghost" onClick={() => setShowPassed((v) => !v)}>
              {showPassed ? 'Ocultar' : `Mostrar ${report.passed.length}`}
            </Button>
          }
        />
        {showPassed ? (
          <ul className="divide-y divide-line">
            {report.passed.map((item) => (
              <li key={item} className="flex items-start gap-2 px-5 py-2.5 text-[13px] text-ink-2">
                <span aria-hidden className="mt-px text-[11px] text-good-ink">
                  ✓
                </span>
                {item}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-4 text-[13px] text-ink-2">
            {report.passed.length} verificação(ões) passaram: dupla contabilização, arredondamento, datas, parcelas,
            faturas, saldos e duplicidades.
          </p>
        )}
      </Panel>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warning' | 'critical' }) {
  const color =
    tone === 'critical' ? 'text-critical-ink' : tone === 'warning' ? 'text-warning-ink' : tone === 'good' ? 'text-good-ink' : 'text-ink';
  return (
    <div>
      <p className="text-[12px] font-medium text-ink-3 uppercase">{label}</p>
      <p className={`tnum mt-1 text-[22px] font-semibold ${color}`}>{value}</p>
    </div>
  );
}
