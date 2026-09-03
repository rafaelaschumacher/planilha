/**
 * Assistente de importação.
 *
 * ARQUIVO → LÊ → NORMALIZA → IDENTIFICA → CATEGORIZA → PROCURA DUPLICIDADES
 * → PRÉVIA → VOCÊ CONFIRMA → IMPORTA
 *
 * Nada entra na base sem passar pela sua confirmação.
 */

import { useMemo, useRef, useState } from 'react';
import { formatDateBR } from '../../domain/dates';
import { parseCsvStatement } from '../../import/csv';
import { parseOfxStatement } from '../../import/ofx';
import { parseXlsxStatement } from '../../import/xlsx';
import {
  buildImportPreview,
  changeRowKind,
  materializePreview,
  refreshRow,
  type ImportContext,
  type ImportPreview,
  type PreviewRow,
} from '../../import/pipeline';
import type { FinanceDataset, ID, ImportBatch, ImportFormat, Transaction, TransactionKind } from '../../domain/types';
import { TRANSACTION_KIND_LABEL } from '../../domain/types';
import { Badge, Button, EmptyState, Field, Notice, Panel, PanelHeader, Select } from '../components/primitives';
import { money } from '../format';
import { navigate } from '../router';

type Target = { type: 'account'; id: ID } | { type: 'card'; id: ID };

const inlineSelect =
  'rounded border border-line bg-surface px-1.5 py-0.5 text-[12px] text-ink focus:border-focus focus:outline-none';

/** Tipos em que o dinheiro ENTRA — decide o sinal mostrado na prévia. */
const isInflow = (kind: TransactionKind) =>
  kind === 'income' || kind === 'refund' || kind === 'chargeback';

export function ImportPage({
  data,
  onCommit,
  onUndo,
}: {
  data: FinanceDataset;
  onCommit: (batch: Omit<ImportBatch, 'id' | 'importedAt'>, transactions: Transaction[]) => Promise<ID>;
  onUndo: (batchId: ID) => Promise<number>;
}) {
  const hide = data.settings.hideAmounts;
  const fileInput = useRef<HTMLInputElement>(null);

  const accounts = data.accounts.filter((a) => !a.archived);
  const cards = data.cards.filter((c) => !c.archived);

  const [target, setTarget] = useState<Target | null>(
    accounts[0] ? { type: 'account', id: accounts[0].id } : cards[0] ? { type: 'card', id: cards[0].id } : null,
  );
  const [paymentCardId, setPaymentCardId] = useState<ID | ''>('');
  const [paymentAccountId, setPaymentAccountId] = useState<ID | ''>('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [fileName, setFileName] = useState('');
  const [format, setFormat] = useState<ImportFormat>('csv');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ batchId: ID; count: number } | null>(null);

  const context: ImportContext | null = useMemo(() => {
    if (!target) return null;
    const base: ImportContext = {
      target:
        target.type === 'account'
          ? { type: 'account', accountId: target.id }
          : { type: 'card', cardId: target.id, card: cards.find((c) => c.id === target.id)! },
      existing: data.transactions,
      rules: data.rules,
      cards: data.cards,
    };
    if (paymentCardId) base.paymentCardId = paymentCardId;
    if (paymentAccountId) base.paymentAccountId = paymentAccountId;
    return base;
  }, [target, data.transactions, data.rules, data.cards, cards, paymentCardId, paymentAccountId]);

  async function handleFile(file: File) {
    setError(null);
    setDone(null);
    if (!context) {
      setError('Escolha primeiro a conta ou o cartão de destino.');
      return;
    }
    setBusy(true);
    setFileName(file.name);
    try {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
      let parsed;
      if (extension === 'ofx' || extension === 'qfx') {
        setFormat('ofx');
        parsed = parseOfxStatement(await file.text());
      } else if (extension === 'xlsx' || extension === 'xlsm') {
        setFormat('xlsx');
        parsed = parseXlsxStatement(await file.arrayBuffer());
      } else {
        setFormat('csv');
        parsed = parseCsvStatement(await file.text());
      }
      setPreview(buildImportPreview(parsed, context));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível ler o arquivo.');
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  function toggleRow(key: string) {
    setPreview((current) =>
      current
        ? {
            ...current,
            rows: current.rows.map((r) =>
              r.key === key ? { ...r, selected: r.blocked ? false : !r.selected } : r,
            ),
          }
        : current,
    );
  }

  function setAllRows(selected: boolean) {
    setPreview((current) =>
      current
        ? {
            ...current,
            // Linha bloqueada nunca é marcada em massa: ela ainda não tem como
            // virar um lançamento válido.
            rows: current.rows.map((r) => ({ ...r, selected: selected && !r.blocked })),
          }
        : current,
    );
  }

  /** Aplica uma alteração numa linha, reavaliando o que a impede de entrar. */
  function updateRow(key: string, change: (row: PreviewRow) => PreviewRow) {
    setPreview((current) => {
      if (!current || !context) return current;
      return {
        ...current,
        rows: current.rows.map((r) => (r.key === key ? refreshRow(change(r), context) : r)),
      };
    });
  }

  function setRowCategory(key: string, categoryId: string) {
    updateRow(key, (r) => {
      const next = { ...r, categorySource: categoryId ? ('manual' as const) : ('none' as const), needsReview: !categoryId };
      if (categoryId) next.categoryId = categoryId;
      else delete next.categoryId;
      return next;
    });
  }

  function setRowKind(key: string, kind: TransactionKind) {
    if (!context) return;
    updateRow(key, (r) => changeRowKind(r, kind, context));
  }

  async function handleImport() {
    if (!preview || !context || !target) return;
    setBusy(true);
    setError(null);
    try {
      const transactions = materializePreview(preview, context, 'pendente');
      const batch: Omit<ImportBatch, 'id' | 'importedAt'> = {
        fileName,
        format,
        rowsRead: preview.summary.total,
        rowsImported: transactions.length,
        rowsSkipped: preview.summary.total - transactions.length,
      };
      if (target.type === 'account') batch.accountId = target.id;
      else batch.cardId = target.id;

      const batchId = await onCommit(batch, transactions);
      setDone({ batchId, count: transactions.length });
      setPreview(null);
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível importar.');
    } finally {
      setBusy(false);
    }
  }

  const selectedCount = preview?.rows.filter((r) => r.selected).length ?? 0;
  const blockedCount = preview?.rows.filter((r) => r.blocked).length ?? 0;

  if (accounts.length === 0 && cards.length === 0) {
    return (
      <Panel>
        <EmptyState
          title="Cadastre uma conta ou cartão primeiro"
          description="A importação precisa saber onde os lançamentos entram."
          action={<Button size="sm" variant="primary" onClick={() => navigate('/contas')}>Cadastrar conta</Button>}
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      {done ? (
        <Notice
          tone="good"
          title={`${done.count} lançamento(s) importado(s)`}
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const removed = await onUndo(done.batchId);
                setDone(null);
                setError(`Importação desfeita: ${removed} lançamento(s) removido(s).`);
              }}
            >
              Desfazer
            </Button>
          }
        >
          Confira em Lançamentos e revise as categorias pendentes.
        </Notice>
      ) : null}

      {error ? <Notice tone="warning">{error}</Notice> : null}

      <Panel>
        <PanelHeader
          title="Importar extrato ou fatura"
          description="Aceita CSV, OFX e XLSX. Tudo é processado no seu navegador — o arquivo não sai do dispositivo."
        />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Onde os lançamentos entram">
            <Select
              value={target ? `${target.type}:${target.id}` : ''}
              onChange={(e) => {
                const [type, id] = e.target.value.split(':');
                setTarget(id ? { type: type as 'account' | 'card', id } : null);
                setPreview(null);
              }}
            >
              <option value="">Selecione…</option>
              {accounts.length > 0 ? (
                <optgroup label="Extrato de conta">
                  {accounts.map((a) => (
                    <option key={a.id} value={`account:${a.id}`}>
                      {a.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {cards.length > 0 ? (
                <optgroup label="Fatura de cartão">
                  {cards.map((c) => (
                    <option key={c.id} value={`card:${c.id}`}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </Select>
          </Field>

          {target?.type === 'account' && cards.length > 0 ? (
            <Field
              label="Pagamentos de fatura vão para"
              hint="Sem escolher o cartão, a linha do pagamento fica bloqueada — como despesa comum ela duplicaria as compras daquele cartão."
            >
              <Select value={paymentCardId} onChange={(e) => setPaymentCardId(e.target.value)}>
                <option value="">Escolher linha por linha</option>
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {target?.type === 'card' && accounts.length > 0 ? (
            <Field
              label="Conta que paga esta fatura"
              hint="Só é usada se você marcar a linha de pagamento — que por padrão vem desmarcada, porque ela normalmente já está no extrato da conta."
            >
              <Select value={paymentAccountId} onChange={(e) => setPaymentAccountId(e.target.value)}>
                <option value="">Nenhuma</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>

        <div className="border-t border-line p-5">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.txt,.ofx,.qfx,.xlsx,.xlsm"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files?.[0];
              if (file) void handleFile(file);
            }}
            className="flex flex-col items-center gap-3 rounded-[12px] border border-dashed border-line-strong px-6 py-10 text-center"
          >
            <p className="text-[14px] text-ink">Arraste o arquivo aqui</p>
            <p className="max-w-md text-[12px] text-ink-3">
              No aplicativo do seu banco, procure por “exportar extrato”. O formato OFX é o mais confiável, porque traz
              um identificador único por transação e elimina a dúvida sobre duplicidade.
            </p>
            <Button variant="primary" size="sm" onClick={() => fileInput.current?.click()} disabled={busy || !target}>
              {busy ? 'Lendo…' : 'Escolher arquivo'}
            </Button>
          </div>
        </div>
      </Panel>

      {preview ? (
        <Panel>
          <PanelHeader
            title="Prévia"
            description={`${fileName} · ${preview.summary.total} linha(s) lida(s)${
              preview.summary.firstDate
                ? ` · ${formatDateBR(preview.summary.firstDate)} a ${formatDateBR(preview.summary.lastDate!)}`
                : ''
            }`}
            action={
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setAllRows(true)}>
                  Marcar todas
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAllRows(false)}>
                  Desmarcar
                </Button>
                <Button size="sm" variant="primary" onClick={handleImport} disabled={selectedCount === 0 || busy}>
                  Importar {selectedCount} lançamento(s)
                </Button>
              </div>
            }
          />

          <div className="space-y-3 border-b border-line p-5">
            {preview.batchWarning ? (
              <Notice tone="warning" title="Este arquivo parece repetido">
                {preview.batchWarning} As linhas repetidas já vieram desmarcadas — confira antes de importar.
              </Notice>
            ) : null}

            {blockedCount > 0 ? (
              <Notice tone="warning" title={`${blockedCount} linha(s) esperando uma escolha sua`}>
                São linhas em que o sistema reconheceu o tipo mas falta a contraparte — a outra conta de uma
                transferência, ou o cartão de um pagamento de fatura. Elas ficam de fora até você completar.
              </Notice>
            ) : null}

            {preview.issues.length > 0 ? (
              <Notice tone="warning" title={`${preview.issues.length} linha(s) não puderam ser lidas`}>
                <ul className="mt-1 space-y-0.5">
                  {preview.issues.slice(0, 5).map((issue, index) => (
                    <li key={index}>
                      {issue.line > 0 ? `Linha ${issue.line}: ` : ''}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </Notice>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-4 text-[13px]">
              <Summary label="A importar" value={String(selectedCount)} />
              <Summary label="Possíveis duplicidades" value={String(preview.summary.duplicates)} />
              <Summary label="Esperando sua escolha" value={String(blockedCount)} />
              <Summary label="Sem categoria" value={String(preview.summary.needsReview)} />
            </div>
          </div>

          <ul className="divide-y divide-line">
            {preview.rows.map((row) => (
              <li
                key={row.key}
                className={`px-5 py-3 ${row.selected ? '' : 'bg-surface-2/60 opacity-70'}`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={row.selected}
                    onChange={() => toggleRow(row.key)}
                    disabled={Boolean(row.blocked)}
                    className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)] disabled:opacity-40"
                    aria-label={`Importar ${row.description}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[13px] text-ink">{row.description}</span>
                      {row.parsed.installmentTotal ? (
                        <Badge tone="neutral">
                          {row.parsed.installmentNumber}/{row.parsed.installmentTotal}
                        </Badge>
                      ) : null}
                      {row.duplicateScore >= 0.7 ? <Badge tone="warning">▲ possível duplicidade</Badge> : null}
                      {row.needsReview ? <Badge tone="neutral">revisar categoria</Badge> : null}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
                      <span className="mr-1">{formatDateBR(row.date)}</span>

                      {/* Trocar o TIPO é o que impede transferência de virar
                          despesa e reembolso de virar receita. */}
                      <select
                        className={inlineSelect}
                        value={row.kind}
                        onChange={(e) => setRowKind(row.key, e.target.value as TransactionKind)}
                        aria-label="Tipo da movimentação"
                      >
                        {row.availableKinds.map((k) => (
                          <option key={k} value={k}>
                            {TRANSACTION_KIND_LABEL[k]}
                          </option>
                        ))}
                      </select>

                      {row.kind === 'transfer' ? (
                        <select
                          className={inlineSelect}
                          value={row.counterAccountId ?? ''}
                          onChange={(e) =>
                            updateRow(row.key, (r) => {
                              const next = { ...r };
                              if (e.target.value) next.counterAccountId = e.target.value;
                              else delete next.counterAccountId;
                              return next;
                            })
                          }
                          aria-label={row.parsed.amountCents < 0 ? 'Conta de destino' : 'Conta de origem'}
                        >
                          <option value="">
                            {row.parsed.amountCents < 0 ? 'Para qual conta?' : 'De qual conta?'}
                          </option>
                          {accounts
                            .filter((a) => target?.type !== 'account' || a.id !== target.id)
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                        </select>
                      ) : null}

                      {row.kind === 'card_payment' && target?.type === 'account' ? (
                        <select
                          className={inlineSelect}
                          value={row.paymentCardId ?? ''}
                          onChange={(e) =>
                            updateRow(row.key, (r) => {
                              const next = { ...r };
                              if (e.target.value) next.paymentCardId = e.target.value;
                              else delete next.paymentCardId;
                              return next;
                            })
                          }
                          aria-label="Cartão da fatura"
                        >
                          <option value="">Qual cartão?</option>
                          {cards.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      ) : null}

                      {row.kind === 'expense' || row.kind === 'income' || row.kind === 'refund' || row.kind === 'chargeback' ? (
                        <select
                          className={inlineSelect}
                          value={row.categoryId ?? ''}
                          onChange={(e) => setRowCategory(row.key, e.target.value)}
                          aria-label="Categoria"
                        >
                          <option value="">Sem categoria</option>
                          {data.categories
                            .filter((c) => !c.archived && c.kind === (row.kind === 'income' ? 'income' : 'expense'))
                            .sort((a, b) => a.name.localeCompare(b.name))
                            .map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                        </select>
                      ) : null}
                    </div>

                    {row.blocked ? (
                      <p className="mt-1.5 text-[12px] text-critical-ink">● {row.blocked}</p>
                    ) : null}
                    {row.warnings.length > 0 ? (
                      <ul className="mt-1.5 space-y-0.5">
                        {row.warnings.map((warning, index) => (
                          <li key={index} className="text-[12px] text-warning-ink">
                            ▲ {warning}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {row.duplicates[0] ? (
                      <p className="mt-1 text-[12px] text-ink-3">
                        Parecido com: {formatDateBR(row.duplicates[0].existing.date)} ·{' '}
                        {row.duplicates[0].existing.description} ({row.duplicates[0].reasons.join(', ')})
                      </p>
                    ) : null}
                  </div>
                  {/* O sinal segue o TIPO, não o que veio no arquivo: depois
                      de marcar como reembolso, o dinheiro entra. */}
                  <span className={`tnum shrink-0 text-[13px] ${isInflow(row.kind) ? 'text-in' : 'text-ink'}`}>
                    {isInflow(row.kind) ? '+' : '−'}
                    {money(row.amountCents, hide)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {data.imports.length > 0 ? (
        <Panel>
          <PanelHeader title="Importações anteriores" description="Dá para desfazer qualquer uma delas" />
          <ul className="divide-y divide-line">
            {[...data.imports].reverse().map((batch) => (
              <li key={batch.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-ink">{batch.fileName}</span>
                  <span className="text-[12px] text-ink-3">
                    {new Date(batch.importedAt).toLocaleString('pt-BR')} · {batch.rowsImported} importado(s) ·{' '}
                    {batch.rowsSkipped} ignorado(s) · {batch.format.toUpperCase()}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => void onUndo(batch.id)}>
                  Desfazer
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[12px] text-ink-3">{label}</p>
      <p className="tnum mt-0.5 text-[15px] font-medium text-ink">{value}</p>
    </div>
  );
}
