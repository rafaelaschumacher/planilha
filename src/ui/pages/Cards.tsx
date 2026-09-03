/**
 * Cartões e faturas.
 *
 * A fatura é sempre recalculada a partir das compras — nunca é um registro
 * guardado. Por isso o total da fatura e a soma das compras não têm como
 * divergir.
 */

import { useMemo, useState } from 'react';
import { parseMoney } from '../../domain/money';
import { formatDateBR, formatMonthLong, formatMonthShort, today as todayOf } from '../../domain/dates';
import { cardUsage, INVOICE_STATUS_LABEL, listInvoices, type Invoice } from '../../domain/invoice';
import { buildCardPayment, newId } from '../../domain/transaction';
import type { Card, FinanceDataset, Transaction } from '../../domain/types';
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

const COLORS = ['#0ea5e9', '#6366f1', '#a855f7', '#ec4899', '#f59e0b', '#10b981', '#64748b'];

export function Cards({
  data,
  onSaveCard,
  onDeleteCard,
  onSaveTransaction,
}: {
  data: FinanceDataset;
  onSaveCard: (card: Card) => Promise<void>;
  onDeleteCard: (id: string) => Promise<void>;
  onSaveTransaction: (tx: Transaction) => Promise<void>;
}) {
  const today = todayOf();
  const hide = data.settings.hideAmounts;
  const [editing, setEditing] = useState<Card | null>(null);
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<{ card: Card; invoice: Invoice } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const categoryMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories]);

  async function handleDelete(id: string) {
    setError(null);
    try {
      await onDeleteCard(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível excluir.');
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Notice tone="critical" title="Não foi possível excluir">{error}</Notice> : null}

      {data.cards.length === 0 ? (
        <Panel>
          <EmptyState
            title="Nenhum cartão cadastrado"
            description="Cadastre o cartão com os dias de fechamento e vencimento. A plataforma monta as faturas sozinha a partir das compras."
            action={
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                Cadastrar cartão
              </Button>
            }
          />
        </Panel>
      ) : (
        <>
          <div className="flex justify-end">
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Novo cartão
            </Button>
          </div>
          {data.cards.map((card) => (
            <CardPanel
              key={card.id}
              card={card}
              data={data}
              today={today}
              hide={hide}
              categoryMap={categoryMap}
              onEdit={() => setEditing(card)}
              onDelete={() => handleDelete(card.id)}
              onPay={(invoice) => setPaying({ card, invoice })}
            />
          ))}
        </>
      )}

      <CardForm
        open={creating || editing !== null}
        card={editing}
        accounts={data.accounts}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSave={onSaveCard}
      />

      {paying ? (
        <PayInvoiceForm
          card={paying.card}
          invoice={paying.invoice}
          data={data}
          onClose={() => setPaying(null)}
          onSave={onSaveTransaction}
        />
      ) : null}
    </div>
  );
}

function CardPanel({
  card,
  data,
  today,
  hide,
  categoryMap,
  onEdit,
  onDelete,
  onPay,
}: {
  card: Card;
  data: FinanceDataset;
  today: string;
  hide: boolean;
  categoryMap: Map<string, { name: string; color: string }>;
  onEdit: () => void;
  onDelete: () => void;
  onPay: (invoice: Invoice) => void;
}) {
  const invoices = useMemo(() => listInvoices(card, data.transactions, today), [card, data.transactions, today]);
  const usage = useMemo(() => cardUsage(card, data.transactions), [card, data.transactions]);
  const currentIndex = Math.max(0, invoices.findIndex((i) => i.status === 'open' || i.openCents > 0));
  const [selected, setSelected] = useState(currentIndex);
  const invoice = invoices[Math.min(selected, invoices.length - 1)];

  return (
    <Panel>
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: card.color }} />
            {card.name}
            {card.archived ? <Badge tone="neutral">arquivado</Badge> : null}
          </span>
        }
        description={`${card.institution} · fecha dia ${card.closingDay} · vence dia ${card.dueDay}`}
        action={
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={onEdit}>
              Editar
            </Button>
            <Button size="sm" variant="ghost" onClick={onDelete}>
              Excluir
            </Button>
          </div>
        }
      />

      <div className="grid gap-5 border-b border-line p-5 sm:grid-cols-3">
        <div>
          <p className="text-[12px] font-medium text-ink-3 uppercase">Limite utilizado</p>
          <p className="tnum mt-1 text-[20px] font-semibold text-ink">{money(usage.usedCents, hide)}</p>
          <div className="mt-2">
            <Meter
              usageRatio={usage.usageRatio}
              tone={usage.usageRatio >= 1 ? 'critical' : usage.usageRatio >= 0.85 ? 'warning' : 'good'}
            />
          </div>
          <p className="mt-1.5 text-[12px] text-ink-3">
            {money(usage.availableCents, hide)} disponíveis de {money(card.limitCents, hide)}
          </p>
        </div>
        <div>
          <p className="text-[12px] font-medium text-ink-3 uppercase">Fatura selecionada</p>
          <p className="tnum mt-1 text-[20px] font-semibold text-ink">{money(invoice?.totalCents ?? 0, hide)}</p>
          <p className="mt-1.5 text-[12px] text-ink-3">
            {invoice ? `${invoice.items.length} lançamento(s) · ${INVOICE_STATUS_LABEL[invoice.status]}` : '—'}
          </p>
        </div>
        <div>
          <p className="text-[12px] font-medium text-ink-3 uppercase">Em aberto</p>
          <p className={`tnum mt-1 text-[20px] font-semibold ${invoice && invoice.openCents > 0 ? 'text-out' : 'text-ink'}`}>
            {money(invoice?.openCents ?? 0, hide)}
          </p>
          {invoice && invoice.openCents > 0 ? (
            <Button size="sm" variant="primary" className="mt-2" onClick={() => onPay(invoice)}>
              Registrar pagamento
            </Button>
          ) : (
            <p className="mt-1.5 text-[12px] text-ink-3">Nada a pagar nesta fatura.</p>
          )}
        </div>
      </div>

      {invoices.length > 0 ? (
        <div className="flex gap-1 overflow-x-auto border-b border-line px-5 py-3">
          {invoices.map((inv, index) => (
            <button
              key={inv.ref}
              type="button"
              onClick={() => setSelected(index)}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-[12px] transition-colors ${
                index === Math.min(selected, invoices.length - 1)
                  ? 'border-transparent bg-accent text-accent-ink'
                  : 'border-line text-ink-2 hover:bg-surface-hover'
              }`}
            >
              {formatMonthShort(inv.ref)}
              {inv.openCents > 0 && inv.status !== 'open' ? ' •' : ''}
            </button>
          ))}
        </div>
      ) : null}

      {invoice ? (
        <>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line px-5 py-3 text-[12px] text-ink-2">
            <span>
              Período: {formatDateBR(invoice.start)} a {formatDateBR(invoice.end)}
            </span>
            <span>Vencimento: {formatDateBR(invoice.dueDate)}</span>
            <Badge
              tone={
                invoice.status === 'overdue' ? 'critical' : invoice.status === 'paid' ? 'good' : 'neutral'
              }
            >
              {INVOICE_STATUS_LABEL[invoice.status]}
            </Badge>
            {invoice.paidCents > 0 ? <span>Pago: {money(invoice.paidCents, hide)}</span> : null}
          </div>

          {invoice.items.length === 0 ? (
            <EmptyState title="Nenhum lançamento nesta fatura" />
          ) : (
            <ul className="divide-y divide-line">
              {invoice.items.map((tx) => (
                <li key={tx.id} className="flex items-baseline justify-between gap-4 px-5 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-ink">
                      {tx.description}
                      {tx.installmentTotal && tx.installmentTotal > 1
                        ? ` · ${tx.installmentNumber}/${tx.installmentTotal}`
                        : ''}
                    </span>
                    <span className="text-[12px] text-ink-3">
                      {formatDateBR(tx.date)}
                      {tx.categoryId ? ` · ${categoryMap.get(tx.categoryId)?.name ?? ''}` : ''}
                      {tx.kind !== 'expense' ? ` · ${tx.kind === 'refund' ? 'reembolso' : 'estorno'}` : ''}
                    </span>
                  </span>
                  <span className={`tnum shrink-0 text-[13px] ${tx.kind === 'expense' ? 'text-ink' : 'text-in'}`}>
                    {tx.kind === 'expense' ? '' : '−'}
                    {money(tx.amountCents, hide)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </Panel>
  );
}

function CardForm({
  open,
  card,
  accounts,
  onClose,
  onSave,
}: {
  open: boolean;
  card: Card | null;
  accounts: FinanceDataset['accounts'];
  onClose: () => void;
  onSave: (card: Card) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [institution, setInstitution] = useState('');
  const [limit, setLimit] = useState('');
  const [closingDay, setClosingDay] = useState(20);
  const [dueDay, setDueDay] = useState(28);
  const [paymentAccountId, setPaymentAccountId] = useState('');
  const [color, setColor] = useState(COLORS[0]!);
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState('');

  const currentKey = `${open}-${card?.id ?? 'new'}`;
  if (key !== currentKey) {
    setKey(currentKey);
    setName(card?.name ?? '');
    setInstitution(card?.institution ?? '');
    setLimit(card ? (card.limitCents / 100).toFixed(2).replace('.', ',') : '');
    setClosingDay(card?.closingDay ?? 20);
    setDueDay(card?.dueDay ?? 28);
    setPaymentAccountId(card?.defaultPaymentAccountId ?? '');
    setColor(card?.color ?? COLORS[0]!);
    setArchived(card?.archived ?? false);
    setError(null);
  }

  async function handleSave() {
    if (!name.trim()) {
      setError('Dê um nome para o cartão.');
      return;
    }
    const now = new Date().toISOString();
    const next: Card = {
      id: card?.id ?? newId('card'),
      name: name.trim(),
      institution: institution.trim(),
      limitCents: parseMoney(limit) ?? 0,
      closingDay,
      dueDay,
      color,
      archived,
      createdAt: card?.createdAt ?? now,
      updatedAt: now,
    };
    if (paymentAccountId) next.defaultPaymentAccountId = paymentAccountId;
    await onSave(next);
    onClose();
  }

  const sameMonth = dueDay > closingDay;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={card ? 'Editar cartão' : 'Novo cartão'}
      footer={
        <>
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cartão principal" />
          </Field>
          <Field label="Banco">
            <Input value={institution} onChange={(e) => setInstitution(e.target.value)} />
          </Field>
          <Field label="Limite">
            <Input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="0,00" />
          </Field>
          <Field label="Conta que costuma pagar a fatura">
            <Select value={paymentAccountId} onChange={(e) => setPaymentAccountId(e.target.value)}>
              <option value="">Nenhuma</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Dia do fechamento">
            <Select value={closingDay} onChange={(e) => setClosingDay(Number(e.target.value))}>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Dia do vencimento">
            <Select value={dueDay} onChange={(e) => setDueDay(Number(e.target.value))}>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Cor">
          <div className="flex h-10 items-center gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Cor ${c}`}
                className="h-6 w-6 rounded-full"
                style={{ backgroundColor: c, ...(color === c ? { boxShadow: `0 0 0 2px ${c}, 0 0 0 4px var(--surface)` } : {}) }}
              />
            ))}
          </div>
        </Field>

        <Notice tone="info" title="Como as faturas serão montadas">
          Compras feitas até o dia {closingDay} entram na fatura que fecha naquele mês; a partir do dia{' '}
          {closingDay === 31 ? 1 : closingDay + 1}, vão para a próxima.{' '}
          {sameMonth
            ? `A fatura vence no dia ${dueDay} do mesmo mês em que fecha.`
            : `Como o vencimento (dia ${dueDay}) vem antes do fechamento (dia ${closingDay}), a fatura vence no mês seguinte ao fechamento.`}
        </Notice>

        {card ? (
          <Toggle
            checked={archived}
            onChange={setArchived}
            label="Arquivar cartão"
            hint="Some das listas, mas o histórico das faturas continua intacto."
          />
        ) : null}

        {error ? <Notice tone="critical">{error}</Notice> : null}
      </div>
    </Modal>
  );
}

function PayInvoiceForm({
  card,
  invoice,
  data,
  onClose,
  onSave,
}: {
  card: Card;
  invoice: Invoice;
  data: FinanceDataset;
  onClose: () => void;
  onSave: (tx: Transaction) => Promise<void>;
}) {
  const accounts = data.accounts.filter((a) => !a.archived);
  const [accountId, setAccountId] = useState(card.defaultPaymentAccountId ?? accounts[0]?.id ?? '');
  const [amount, setAmount] = useState((invoice.openCents / 100).toFixed(2).replace('.', ','));
  const [date, setDate] = useState(invoice.dueDate);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const cents = parseMoney(amount);
    if (!cents || cents <= 0) {
      setError('Informe o valor pago.');
      return;
    }
    if (!accountId) {
      setError('Escolha a conta que pagou a fatura.');
      return;
    }
    try {
      await onSave(
        buildCardPayment({
          date,
          amountCents: cents,
          accountId,
          cardId: card.id,
          invoiceRef: invoice.ref,
          description: `Pagamento fatura ${card.name}`,
        }),
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar.');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Registrar pagamento da fatura"
      description={`Fatura de ${formatMonthLong(invoice.ref)} · vence em ${formatDateBR(invoice.dueDate)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={handleSave}>
            Registrar pagamento
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Notice tone="info" title="Isto não vira despesa">
          As despesas já foram contadas em cada compra do cartão. Este lançamento só tira o dinheiro da conta e
          liquida a fatura — é assim que o mesmo gasto não é contado duas vezes.
        </Notice>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Conta que pagou">
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Selecione…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Data do pagamento">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>

        <Field label="Valor pago" hint={`Em aberto: ${money(invoice.openCents, false)}`}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>

        {error ? <Notice tone="critical">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
