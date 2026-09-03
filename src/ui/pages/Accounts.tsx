/**
 * Contas bancárias.
 *
 * O saldo NUNCA é digitado: ele é o saldo inicial mais o efeito de todos os
 * lançamentos. Se o número não bate com o do banco, o problema está em algum
 * lançamento — e é lá que se corrige, não aqui.
 */

import { useMemo, useState } from 'react';
import { formatMoney, parseMoney } from '../../domain/money';
import { formatDateBR, today as todayOf } from '../../domain/dates';
import { accountBalances } from '../../domain/engine';
import { newId } from '../../domain/transaction';
import type { Account, AccountType, FinanceDataset } from '../../domain/types';
import { ACCOUNT_TYPE_LABEL } from '../../domain/types';
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
import { money } from '../format';

const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#64748b'];

export function Accounts({
  data,
  onSave,
  onDelete,
  onTransfer,
}: {
  data: FinanceDataset;
  onSave: (account: Account) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onTransfer: () => void;
}) {
  const today = todayOf();
  const hide = data.settings.hideAmounts;
  const [editing, setEditing] = useState<Account | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const balances = useMemo(
    () => accountBalances(data.accounts, data.transactions, today),
    [data.accounts, data.transactions, today],
  );

  const total = balances.filter((b) => !b.account.archived).reduce((sum, b) => sum + b.balanceCents, 0);

  async function handleDelete(id: string) {
    setError(null);
    try {
      await onDelete(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível excluir.');
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Notice tone="critical" title="Não foi possível excluir">{error}</Notice> : null}

      <Panel>
        <PanelHeader
          title="Contas"
          description={`Saldo somado: ${money(total, hide)}`}
          action={
            <div className="flex gap-2">
              <Button size="sm" onClick={onTransfer} disabled={data.accounts.length < 2}>
                Transferir
              </Button>
              <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                Nova conta
              </Button>
            </div>
          }
        />

        {balances.length === 0 ? (
          <EmptyState
            title="Nenhuma conta cadastrada"
            description="Cadastre sua conta corrente com o saldo de hoje. A partir daí, cada lançamento atualiza o saldo sozinho."
            action={
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                Cadastrar conta
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {balances.map(({ account, balanceCents, projectedCents }) => (
              <li key={account.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: account.color }} />
                    <span className="truncate text-[14px] font-medium text-ink">{account.name}</span>
                    {account.archived ? <Badge tone="neutral">arquivada</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-[12px] text-ink-3">
                    {account.institution} · {ACCOUNT_TYPE_LABEL[account.type]} · saldo inicial{' '}
                    {money(account.openingBalanceCents, hide)} em {formatDateBR(account.openingDate)}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className={`tnum text-[16px] font-semibold ${balanceCents < 0 ? 'text-out' : 'text-ink'}`}>
                      {money(balanceCents, hide)}
                    </p>
                    {projectedCents !== balanceCents ? (
                      <p className="tnum text-[12px] text-ink-3">
                        {money(projectedCents, hide)} com previstos
                      </p>
                    ) : null}
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(account)}>
                      Editar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => handleDelete(account.id)}>
                      Excluir
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <AccountForm
        open={creating || editing !== null}
        account={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSave={onSave}
      />
    </div>
  );
}

function AccountForm({
  open,
  account,
  onClose,
  onSave,
}: {
  open: boolean;
  account: Account | null;
  onClose: () => void;
  onSave: (account: Account) => Promise<void>;
}) {
  const today = todayOf();
  const [name, setName] = useState('');
  const [institution, setInstitution] = useState('');
  const [type, setType] = useState<AccountType>('checking');
  const [balance, setBalance] = useState('');
  const [openingDate, setOpeningDate] = useState(today);
  const [color, setColor] = useState(COLORS[0]!);
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState('');

  // Recarrega os campos quando o modal abre com outra conta.
  const currentKey = `${open}-${account?.id ?? 'new'}`;
  if (key !== currentKey) {
    setKey(currentKey);
    setName(account?.name ?? '');
    setInstitution(account?.institution ?? '');
    setType(account?.type ?? 'checking');
    setBalance(account ? (account.openingBalanceCents / 100).toFixed(2).replace('.', ',') : '');
    setOpeningDate(account?.openingDate ?? today);
    setColor(account?.color ?? COLORS[0]!);
    setArchived(account?.archived ?? false);
    setError(null);
  }

  async function handleSave() {
    if (!name.trim()) {
      setError('Dê um nome para a conta.');
      return;
    }
    const openingBalanceCents = parseMoney(balance) ?? 0;
    const now = new Date().toISOString();
    await onSave({
      id: account?.id ?? newId('acc'),
      name: name.trim(),
      institution: institution.trim(),
      type,
      openingBalanceCents,
      openingDate,
      color,
      archived,
      createdAt: account?.createdAt ?? now,
      updatedAt: now,
    });
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={account ? 'Editar conta' : 'Nova conta'}
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
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Conta corrente" />
          </Field>
          <Field label="Instituição">
            <Input value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="Banco" />
          </Field>
          <Field label="Tipo">
            <Select value={type} onChange={(e) => setType(e.target.value as AccountType)}>
              {(Object.keys(ACCOUNT_TYPE_LABEL) as AccountType[]).map((t) => (
                <option key={t} value={t}>
                  {ACCOUNT_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Cor">
            <div className="flex h-10 items-center gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Cor ${c}`}
                  className={`h-6 w-6 rounded-full transition-transform ${color === c ? 'scale-110 ring-2 ring-offset-2 ring-offset-surface' : ''}`}
                  style={{ backgroundColor: c, ...(color === c ? { boxShadow: `0 0 0 2px ${c}` } : {}) }}
                />
              ))}
            </div>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Saldo inicial"
            hint="O saldo que a conta tinha na data abaixo. Depois disso, o saldo é calculado pelos lançamentos."
          >
            <Input inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="0,00" />
          </Field>
          <Field
            label="Data do saldo inicial"
            hint="Lançamentos anteriores a esta data são ignorados no saldo."
          >
            <Input type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} />
          </Field>
        </div>

        {account ? (
          <Toggle
            checked={archived}
            onChange={setArchived}
            label="Arquivar conta"
            hint="Some das listas e dos totais, mas o histórico continua intacto."
          />
        ) : null}

        <Notice tone="info">
          Confira o saldo inicial no extrato do banco. É o único número que você digita — todo o resto vem dos
          lançamentos. Total atual do formulário: {formatMoney(parseMoney(balance) ?? 0)}.
        </Notice>

        {error ? <Notice tone="critical">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
