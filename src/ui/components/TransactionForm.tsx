/**
 * "Adicionar lançamento" — a ação principal da plataforma.
 *
 * O formulário pede o MÍNIMO: data, descrição, valor e como foi pago.
 * Todo o resto é inferido: mês, semana, tipo, categoria, conta, cartão,
 * parcela e fatura. Os campos avançados ficam escondidos até você precisar.
 */

import { useEffect, useMemo, useState } from 'react';
import { formatMoney, parseMoney, splitInstallments } from '../../domain/money';
import { formatDateBR, monthOf, today as todayOf } from '../../domain/dates';
import { invoicePeriod, invoiceRefForDate } from '../../domain/invoice';
import { suggestCategory } from '../../domain/categorize';
import {
  buildInstallmentPurchase,
  buildTransaction,
  type TransactionDraft,
} from '../../domain/transaction';
import { findDuplicates } from '../../domain/duplicates';
import type { FinanceDataset, ID, Transaction, TransactionKind } from '../../domain/types';
import { TRANSACTION_KIND_LABEL } from '../../domain/types';
import { Badge, Button, Field, Input, Modal, Notice, Select, TextArea, Toggle } from './primitives';
import { cx } from '../format';

type Source = { kind: 'account'; id: ID } | { kind: 'card'; id: ID };

const KIND_ORDER: TransactionKind[] = [
  'expense',
  'income',
  'transfer',
  'card_payment',
  'refund',
  'chargeback',
  'adjustment',
];

export function TransactionForm({
  open,
  onClose,
  data,
  editing,
  onSave,
  initialKind = 'expense',
}: {
  open: boolean;
  onClose: () => void;
  data: FinanceDataset;
  editing?: Transaction;
  onSave: (transactions: Transaction[]) => Promise<void>;
  initialKind?: TransactionKind;
}) {
  const accounts = data.accounts.filter((a) => !a.archived);
  const cards = data.cards.filter((c) => !c.archived);
  const today = todayOf();

  const [kind, setKind] = useState<TransactionKind>(initialKind);
  const [date, setDate] = useState(today);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [source, setSource] = useState<Source | null>(null);
  const [toAccountId, setToAccountId] = useState<ID | ''>('');
  const [categoryId, setCategoryId] = useState<ID | ''>('');
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [installments, setInstallments] = useState(1);
  const [isFixed, setIsFixed] = useState(false);
  const [pending, setPending] = useState(false);
  const [notes, setNotes] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('out');
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Recarrega o formulário sempre que abre ou troca o lançamento editado.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);

    if (editing) {
      setKind(editing.kind);
      setDate(editing.date);
      setDescription(editing.description);
      setAmount((editing.amountCents / 100).toFixed(2).replace('.', ','));
      setSource(
        editing.cardId && editing.kind !== 'card_payment'
          ? { kind: 'card', id: editing.cardId }
          : editing.accountId
            ? { kind: 'account', id: editing.accountId }
            : null,
      );
      setToAccountId(editing.toAccountId ?? (editing.kind === 'card_payment' ? (editing.cardId ?? '') : ''));
      setCategoryId(editing.categoryId ?? '');
      setCategoryTouched(true);
      setInstallments(editing.installmentTotal ?? 1);
      setIsFixed(editing.isFixed);
      setPending(editing.status === 'pending');
      setNotes(editing.notes ?? '');
      setDirection(editing.direction ?? 'out');
      setAdvanced(Boolean(editing.notes || editing.status === 'pending' || editing.isFixed));
      return;
    }

    setKind(initialKind);
    setDate(today);
    setDescription('');
    setAmount('');
    setSource(
      accounts[0] ? { kind: 'account', id: accounts[0].id } : cards[0] ? { kind: 'card', id: cards[0].id } : null,
    );
    setToAccountId('');
    setCategoryId('');
    setCategoryTouched(false);
    setInstallments(1);
    setIsFixed(false);
    setPending(false);
    setNotes('');
    setDirection('out');
    setAdvanced(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, initialKind]);

  const amountCents = parseMoney(amount);
  const absAmount = amountCents === null ? null : Math.abs(amountCents);

  // --- Categoria sugerida ------------------------------------------------
  const suggestion = useMemo(() => {
    if (!description.trim() || kind === 'transfer' || kind === 'card_payment' || kind === 'adjustment') return null;
    return suggestCategory({ description, rules: data.rules, history: data.transactions });
  }, [description, kind, data.rules, data.transactions]);

  useEffect(() => {
    if (categoryTouched || !suggestion?.categoryId) return;
    setCategoryId(suggestion.categoryId);
    if (suggestion.isFixed !== undefined) setIsFixed(suggestion.isFixed);
  }, [suggestion, categoryTouched]);

  // --- Possível duplicidade ----------------------------------------------
  const duplicates = useMemo(() => {
    if (!absAmount || !description.trim() || editing) return [];
    const candidate: Parameters<typeof findDuplicates>[0] = {
      kind,
      date,
      description,
      amountCents: absAmount,
    };
    if (source?.kind === 'account') candidate.accountId = source.id;
    if (source?.kind === 'card') candidate.cardId = source.id;
    return findDuplicates(candidate, data.transactions);
  }, [absAmount, description, date, kind, source, data.transactions, editing]);

  // --- Fatura de destino --------------------------------------------------
  const selectedCard = source?.kind === 'card' ? cards.find((c) => c.id === source.id) : undefined;
  const invoiceInfo = useMemo(() => {
    if (!selectedCard || kind !== 'expense') return null;
    const ref = invoiceRefForDate(selectedCard, date);
    return { ref, period: invoicePeriod(selectedCard, ref) };
  }, [selectedCard, date, kind]);

  const parcelPreview = useMemo(() => {
    if (installments < 2 || !absAmount) return null;
    const parts = splitInstallments(absAmount, installments);
    return { first: parts[0]!, last: parts[parts.length - 1]!, total: absAmount };
  }, [installments, absAmount]);

  const categories = useMemo(() => {
    const wanted = kind === 'income' ? 'income' : 'expense';
    const roots = data.categories.filter((c) => !c.parentId && c.kind === wanted && !c.archived);
    return roots.map((root) => ({
      root,
      children: data.categories.filter((c) => c.parentId === root.id && !c.archived),
    }));
  }, [data.categories, kind]);

  const needsSource = kind !== 'transfer';
  const needsTarget = kind === 'transfer' || kind === 'card_payment';
  const allowsCard = kind === 'expense' || kind === 'refund' || kind === 'chargeback';
  const allowsInstallments = kind === 'expense' && !editing;

  async function handleSubmit() {
    setError(null);
    if (!absAmount || absAmount <= 0) {
      setError('Informe um valor maior que zero.');
      return;
    }
    if (!description.trim()) {
      setError('Descreva o lançamento — é o que permite categorizar e reconhecer depois.');
      return;
    }

    try {
      setSaving(true);
      const base: TransactionDraft = {
        kind,
        date,
        description: description.trim(),
        amountCents: absAmount,
        status: pending ? 'pending' : 'cleared',
        isFixed,
      };
      if (notes.trim()) base.notes = notes.trim();
      if (categoryId) {
        base.categoryId = categoryId;
        base.categorySource = categoryTouched ? 'manual' : (suggestion?.source ?? 'manual');
        base.needsReview = false;
      } else if (kind === 'expense' || kind === 'income') {
        base.needsReview = true;
        base.categorySource = 'none';
      }

      if (kind === 'transfer') {
        base.accountId = source?.kind === 'account' ? source.id : undefined;
        base.toAccountId = toAccountId || undefined;
        base.paymentMethod = 'transfer';
      } else if (kind === 'card_payment') {
        base.accountId = source?.kind === 'account' ? source.id : undefined;
        base.cardId = toAccountId || undefined;
        const card = cards.find((c) => c.id === toAccountId);
        if (card) base.invoiceRef = invoiceRefForDate(card, date);
        base.paymentMethod = 'debit';
      } else if (kind === 'adjustment') {
        base.accountId = source?.kind === 'account' ? source.id : undefined;
        base.direction = direction;
      } else if (source?.kind === 'card') {
        base.cardId = source.id;
        base.paymentMethod = 'credit';
      } else if (source?.kind === 'account') {
        base.accountId = source.id;
        base.paymentMethod = kind === 'income' ? 'transfer' : 'debit';
      }

      if (editing) {
        base.id = editing.id;
        base.createdAt = editing.createdAt;
        if (editing.installmentGroupId) {
          base.installmentGroupId = editing.installmentGroupId;
          base.installmentNumber = editing.installmentNumber;
          base.installmentTotal = editing.installmentTotal;
          base.purchaseTotalCents = editing.purchaseTotalCents;
        }
        await onSave([buildTransaction(base)]);
      } else if (allowsInstallments && installments > 1) {
        await onSave(
          buildInstallmentPurchase({
            date,
            description: description.trim(),
            totalCents: absAmount,
            installments,
            cardId: source?.kind === 'card' ? source.id : undefined,
            accountId: source?.kind === 'account' ? source.id : undefined,
            categoryId: categoryId || undefined,
            categorySource: categoryId ? 'manual' : undefined,
            needsReview: !categoryId,
            isFixed,
            notes: notes.trim() || undefined,
          }),
        );
      } else {
        await onSave([buildTransaction(base)]);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Editar lançamento' : 'Adicionar lançamento'}
      description={
        editing ? undefined : 'Mês, semana, fatura e parcela são calculados sozinhos a partir do que você preencher.'
      }
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={saving}>
            {saving ? 'Salvando…' : editing ? 'Salvar alterações' : 'Adicionar'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Tipo */}
        <div className="flex flex-wrap gap-1.5">
          {KIND_ORDER.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setKind(option)}
              className={cx(
                'rounded-full border px-3 py-1.5 text-[13px] transition-colors',
                kind === option
                  ? 'border-transparent bg-accent text-accent-ink'
                  : 'border-line text-ink-2 hover:bg-surface-hover',
              )}
            >
              {TRANSACTION_KIND_LABEL[option]}
            </button>
          ))}
        </div>

        {kind === 'card_payment' ? (
          <Notice tone="info" title="Pagamento de fatura não é despesa">
            A despesa já foi contada em cada compra do cartão. Este lançamento apenas tira o dinheiro da conta e
            liquida a fatura.
          </Notice>
        ) : null}
        {kind === 'transfer' ? (
          <Notice tone="info" title="Transferência não é receita nem despesa">
            O dinheiro só muda de conta. Seu resultado do mês não se altera.
          </Notice>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Data">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} max="2100-12-31" />
          </Field>

          <Field
            label={installments > 1 ? 'Valor total da compra' : 'Valor'}
            hint={
              parcelPreview
                ? `${installments}× de ${formatMoney(parcelPreview.first)}${
                    parcelPreview.first !== parcelPreview.last ? ` (últimas de ${formatMoney(parcelPreview.last)})` : ''
                  }`
                : absAmount
                  ? formatMoney(absAmount)
                  : 'Aceita 1.234,56 ou 1234.56'
            }
          >
            <Input
              inputMode="decimal"
              placeholder="0,00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus={!editing}
            />
          </Field>
        </div>

        <Field
          label="Descrição"
          hint={
            suggestion?.categoryId && !categoryTouched
              ? `Categoria sugerida ${suggestion.reason ? `(${suggestion.reason})` : ''}`
              : undefined
          }
        >
          <Input
            placeholder="Ex.: Mercado Bom Preço"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        {duplicates.length > 0 ? (
          <Notice tone="warning" title="Possível duplicidade">
            Já existe {duplicates.length === 1 ? 'um lançamento parecido' : `${duplicates.length} lançamentos parecidos`}:{' '}
            {duplicates
              .slice(0, 2)
              .map((d) => `${formatDateBR(d.existing.date)} · ${d.existing.description}`)
              .join(' · ')}
            . Nada foi bloqueado — confira antes de adicionar.
          </Notice>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          {needsSource ? (
            <Field label={kind === 'card_payment' ? 'Conta que paga' : kind === 'income' ? 'Conta de destino' : 'Pago com'}>
              <Select
                value={source ? `${source.kind}:${source.id}` : ''}
                onChange={(e) => {
                  const [type, id] = e.target.value.split(':');
                  setSource(id ? ({ kind: type as 'account' | 'card', id }) : null);
                  if (type === 'account') setInstallments(1);
                }}
              >
                <option value="">Selecione…</option>
                <optgroup label="Contas">
                  {accounts.map((account) => (
                    <option key={account.id} value={`account:${account.id}`}>
                      {account.name}
                    </option>
                  ))}
                </optgroup>
                {allowsCard && cards.length > 0 ? (
                  <optgroup label="Cartões de crédito">
                    {cards.map((card) => (
                      <option key={card.id} value={`card:${card.id}`}>
                        {card.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </Select>
            </Field>
          ) : (
            <Field label="Conta de origem">
              <Select
                value={source?.kind === 'account' ? source.id : ''}
                onChange={(e) => setSource(e.target.value ? { kind: 'account', id: e.target.value } : null)}
              >
                <option value="">Selecione…</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {needsTarget ? (
            <Field label={kind === 'transfer' ? 'Conta de destino' : 'Cartão'}>
              <Select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
                <option value="">Selecione…</option>
                {(kind === 'transfer' ? accounts : cards).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : kind === 'adjustment' ? (
            <Field label="Direção">
              <Select value={direction} onChange={(e) => setDirection(e.target.value as 'in' | 'out')}>
                <option value="in">Entrada (aumenta o saldo)</option>
                <option value="out">Saída (reduz o saldo)</option>
              </Select>
            </Field>
          ) : (
            <Field label="Categoria" hint={categoryId ? undefined : 'Sem categoria entra na lista de revisão'}>
              <Select
                value={categoryId}
                onChange={(e) => {
                  setCategoryId(e.target.value);
                  setCategoryTouched(true);
                }}
              >
                <option value="">Sem categoria</option>
                {categories.map(({ root, children }) => (
                  <optgroup key={root.id} label={root.name}>
                    <option value={root.id}>{root.name} (geral)</option>
                    {children.map((child) => (
                      <option key={child.id} value={child.id}>
                        {child.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </Field>
          )}
        </div>

        {allowsInstallments && source?.kind === 'card' ? (
          <Field
            label="Parcelas"
            hint={
              parcelPreview
                ? `A soma das ${installments} parcelas é exatamente ${formatMoney(parcelPreview.total)}. Cada parcela vira despesa do mês dela.`
                : 'Compra à vista'
            }
          >
            <Select value={installments} onChange={(e) => setInstallments(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? 'À vista' : `${n}×`}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {invoiceInfo ? (
          <p className="flex flex-wrap items-center gap-2 text-[12px] text-ink-2">
            <Badge tone="neutral">Fatura {invoiceInfo.ref.slice(5)}/{invoiceInfo.ref.slice(2, 4)}</Badge>
            Entra na fatura que fecha em {formatDateBR(invoiceInfo.period.end)} e vence em{' '}
            {formatDateBR(invoiceInfo.period.dueDate)}.
          </p>
        ) : null}

        <p className="text-[12px] text-ink-3">
          Mês: {monthOf(date)} · Esta compra não some do histórico — dá para editar ou excluir depois.
        </p>

        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="text-[13px] text-ink-2 underline underline-offset-2 hover:text-ink"
        >
          {advanced ? 'Menos opções' : 'Mais opções'}
        </button>

        {advanced ? (
          <div className="space-y-4 rounded-[10px] border border-line bg-surface-2 p-4">
            <Toggle
              checked={isFixed}
              onChange={setIsFixed}
              label="Gasto fixo"
              hint="Entra em “fixos x variáveis” e ajuda a prever os próximos meses."
            />
            <Toggle
              checked={pending}
              onChange={setPending}
              label="Previsto (ainda não aconteceu)"
              hint="Não afeta o saldo atual, mas entra nos compromissos futuros."
            />
            <Field label="Observação">
              <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
            </Field>
          </div>
        ) : null}

        {error ? <Notice tone="critical" title="Não foi possível salvar">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
