/** Casca da aplicação: navegação, tema e as ações globais. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { today as todayOf } from '../domain/dates';
import { buildTransfer } from '../domain/transaction';
import { parseMoney } from '../domain/money';
import type { ID, Transaction } from '../domain/types';
import { actions, useStore } from '../state/store';
import { href, navigate, useRoute } from './router';
import { Button, Field, Input, Modal, Notice, PageHeader, Panel, Select } from './components/primitives';
import { TransactionForm } from './components/TransactionForm';
import { Dashboard } from './pages/Dashboard';
import { Transactions } from './pages/Transactions';
import { Accounts } from './pages/Accounts';
import { Cards } from './pages/Cards';
import { Budget } from './pages/Budget';
import { Future } from './pages/Future';
import { Reports } from './pages/Reports';
import { ImportPage } from './pages/Import';
import { Diagnostics } from './pages/Diagnostics';
import { SettingsPage } from './pages/Settings';
import { cx } from './format';

// Os sete primeiros ficam sempre visíveis; os dois últimos vão para o menu
// "Mais". Com dez itens na barra, os rótulos do fim apareciam cortados.
const PRIMARY_NAV = [
  { path: '/', label: 'Visão geral' },
  { path: '/lancamentos', label: 'Lançamentos' },
  { path: '/contas', label: 'Contas' },
  { path: '/cartoes', label: 'Cartões' },
  { path: '/orcamento', label: 'Orçamento' },
  { path: '/futuro', label: 'Futuro' },
  { path: '/relatorios', label: 'Relatórios' },
  { path: '/importar', label: 'Importar' },
];

const SECONDARY_NAV = [
  { path: '/diagnostico', label: 'Diagnóstico' },
  { path: '/configuracoes', label: 'Ajustes' },
];

const NAV = [...PRIMARY_NAV, ...SECONDARY_NAV];

const PAGE_TITLES: Record<string, { title: string; description?: string }> = {
  '/': { title: 'Visão geral' },
  '/lancamentos': { title: 'Lançamentos', description: 'A base única. Semana, mês e cartão são recortes desta lista.' },
  '/contas': { title: 'Contas', description: 'O saldo é calculado pelos lançamentos, nunca digitado.' },
  '/cartoes': { title: 'Cartões e faturas', description: 'As faturas são montadas a partir das compras.' },
  '/orcamento': { title: 'Orçamento', description: 'Limites mensais por categoria.' },
  '/futuro': { title: 'Futuro financeiro', description: 'O que já está comprometido e o que realmente sobra.' },
  '/relatorios': { title: 'Relatórios' },
  '/importar': { title: 'Importar dados', description: 'Extrato da conta ou fatura do cartão.' },
  '/diagnostico': { title: 'Diagnóstico', description: 'Auditoria dos seus dados, procurando erros de verdade.' },
  '/configuracoes': { title: 'Ajustes' },
};

export function App() {
  const { status, data, error } = useStore();
  const route = useRoute();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Transaction | undefined>();
  const [transferOpen, setTransferOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Transaction | null>(null);
  const [inspectIds, setInspectIds] = useState<ID[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Tema: a preferência salva vence o sistema, nos dois sentidos.
  useEffect(() => {
    const root = document.documentElement;
    if (data.settings.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', data.settings.theme);
  }, [data.settings.theme]);

  // Atalhos: N para novo lançamento, P para o modo privacidade.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'n' || event.key === 'N') {
        event.preventDefault();
        openNew();
      }
      if (event.key === 'p' || event.key === 'P') {
        void actions.saveSettings({ hideAmounts: !data.settings.hideAmounts });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [data.settings.hideAmounts]);

  const openNew = useCallback(() => {
    setEditing(undefined);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((tx: Transaction) => {
    setEditing(tx);
    setFormOpen(true);
  }, []);

  const handleSave = useCallback(async (transactions: Transaction[]) => {
    await actions.saveTransactions(transactions);
  }, []);

  const initialFilters = useMemo(
    () => ({
      categoria: route.params.get('categoria') ?? undefined,
      mes: route.params.get('mes') ?? undefined,
      conta: route.params.get('conta') ?? undefined,
      cartao: route.params.get('cartao') ?? undefined,
      revisar: route.params.get('revisar') === '1',
    }),
    [route.params],
  );

  if (status === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <p className="text-sm text-ink-3">Abrindo seus dados…</p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="mx-auto flex min-h-dvh max-w-lg items-center px-6">
        <Notice tone="critical" title="Não foi possível abrir o banco de dados local">
          {error} Tente sair da navegação anônima ou liberar o armazenamento de dados para este site.
        </Notice>
      </div>
    );
  }

  const page = PAGE_TITLES[route.path] ?? { title: 'Finanças' };

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1180px] items-center gap-3 px-4 py-3 sm:px-6">
          <a href={href('/')} className="flex shrink-0 items-center gap-2 font-semibold tracking-[-0.02em] text-ink">
            <span
              aria-hidden
              className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-[13px] text-accent-ink"
            >
              F
            </span>
            <span className="hidden sm:inline">Finanças</span>
          </a>

          <nav className="hidden min-w-0 flex-1 items-center gap-0.5 lg:flex">
            {PRIMARY_NAV.map((item) => (
              <a
                key={item.path}
                href={href(item.path)}
                className={cx(
                  'shrink-0 rounded-lg px-2.5 py-1.5 text-[13px] whitespace-nowrap transition-colors',
                  route.path === item.path ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                )}
              >
                {item.label}
              </a>
            ))}
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                onBlur={() => window.setTimeout(() => setMoreOpen(false), 120)}
                aria-expanded={moreOpen}
                className={cx(
                  'rounded-lg px-2.5 py-1.5 text-[13px] whitespace-nowrap transition-colors',
                  SECONDARY_NAV.some((i) => i.path === route.path)
                    ? 'bg-surface-2 text-ink'
                    : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                )}
              >
                Mais ▾
              </button>
              {moreOpen ? (
                <div className="absolute right-0 z-40 mt-1 min-w-44 overflow-hidden rounded-[10px] border border-line bg-surface py-1 shadow-lg">
                  {SECONDARY_NAV.map((item) => (
                    <a
                      key={item.path}
                      href={href(item.path)}
                      onClick={() => setMoreOpen(false)}
                      className="block px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink"
                    >
                      {item.label}
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void actions.saveSettings({ hideAmounts: !data.settings.hideAmounts })}
              aria-label={data.settings.hideAmounts ? 'Mostrar valores' : 'Ocultar valores'}
              title="Modo privacidade (P)"
            >
              {data.settings.hideAmounts ? '🙈' : '👁'}
            </Button>
            <Button size="sm" variant="primary" onClick={openNew} title="Adicionar lançamento (N)">
              <span className="sm:hidden">+</span>
              <span className="hidden sm:inline">Adicionar lançamento</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="lg:hidden"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Menu"
            >
              ☰
            </Button>
          </div>
        </div>

        {menuOpen ? (
          <nav className="grid grid-cols-2 gap-1 border-t border-line px-4 py-3 sm:grid-cols-3 lg:hidden">
            {NAV.map((item) => (
              <a
                key={item.path}
                href={href(item.path)}
                onClick={() => setMenuOpen(false)}
                className={cx(
                  'rounded-lg px-3 py-2 text-[13px]',
                  route.path === item.path ? 'bg-surface-2 text-ink' : 'text-ink-2',
                )}
              >
                {item.label}
              </a>
            ))}
          </nav>
        ) : null}
      </header>

      <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-6">
        {route.path !== '/' ? <PageHeader title={page.title} description={page.description} /> : null}

        {actionError ? (
          <div className="mb-4">
            <Notice tone="critical" title="Ocorreu um erro">
              {actionError}
            </Notice>
          </div>
        ) : null}

        {route.path === '/' ? <Dashboard data={data} onAdd={openNew} /> : null}

        {route.path === '/lancamentos' ? (
          <Transactions
            data={data}
            initialFilters={initialFilters}
            onEdit={openEdit}
            onDelete={setConfirmDelete}
            onSetCategory={(id, categoryId) => void actions.setCategory(id, categoryId)}
            onAdd={openNew}
          />
        ) : null}

        {route.path === '/contas' ? (
          <Accounts
            data={data}
            onSave={actions.saveAccount}
            onDelete={actions.deleteAccount}
            onTransfer={() => setTransferOpen(true)}
          />
        ) : null}

        {route.path === '/cartoes' ? (
          <Cards
            data={data}
            onSaveCard={actions.saveCard}
            onDeleteCard={actions.deleteCard}
            onSaveTransaction={actions.saveTransaction}
          />
        ) : null}

        {route.path === '/orcamento' ? (
          <Budget data={data} onSave={actions.saveBudget} onDelete={actions.deleteBudget} />
        ) : null}

        {route.path === '/futuro' ? <Future data={data} /> : null}
        {route.path === '/relatorios' ? <Reports data={data} /> : null}

        {route.path === '/importar' ? (
          <ImportPage data={data} onCommit={actions.commitImport} onUndo={actions.deleteImportBatch} />
        ) : null}

        {route.path === '/diagnostico' ? (
          <Diagnostics data={data} onInspect={(ids) => setInspectIds(ids)} />
        ) : null}

        {route.path === '/configuracoes' ? (
          <SettingsPage
            data={data}
            onSaveSettings={actions.saveSettings}
            onSaveCategory={actions.saveCategory}
            onDeleteCategory={actions.deleteCategory}
            onSaveRule={actions.saveRule}
            onDeleteRule={actions.deleteRule}
            onSaveRecurring={actions.saveRecurring}
            onDeleteRecurring={actions.deleteRecurring}
            onRestore={actions.restoreBackup}
            onLoadDemo={actions.loadDemoData}
            onWipe={actions.wipeEverything}
          />
        ) : null}

        {!PAGE_TITLES[route.path] ? (
          <Panel className="p-10 text-center">
            <p className="text-sm text-ink-2">Página não encontrada.</p>
            <Button className="mt-3" onClick={() => navigate('/')}>
              Voltar para a visão geral
            </Button>
          </Panel>
        ) : null}
      </main>

      <footer className="mx-auto max-w-[1180px] px-4 pb-10 text-[12px] text-ink-3 sm:px-6">
        Seus dados ficam neste navegador e não são enviados para nenhum servidor. Exporte um backup nos Ajustes.
      </footer>

      <TransactionForm
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditing(undefined);
        }}
        data={data}
        editing={editing}
        onSave={handleSave}
      />

      <TransferForm
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        data={data}
        onSave={actions.saveTransaction}
      />

      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Excluir lançamento"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancelar
            </Button>
            {confirmDelete?.installmentGroupId ? (
              <Button
                variant="danger"
                onClick={async () => {
                  await actions.deleteInstallmentGroup(confirmDelete.installmentGroupId!);
                  setConfirmDelete(null);
                }}
              >
                Excluir todas as parcelas
              </Button>
            ) : null}
            <Button
              variant="danger"
              onClick={async () => {
                if (!confirmDelete) return;
                setActionError(null);
                try {
                  await actions.deleteTransaction(confirmDelete.id);
                } catch (err) {
                  setActionError(err instanceof Error ? err.message : 'Erro ao excluir.');
                }
                setConfirmDelete(null);
              }}
            >
              Excluir este
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2">
          “{confirmDelete?.description}” de {confirmDelete?.date} será removido.
          {confirmDelete?.installmentGroupId
            ? ' Esta é uma compra parcelada — você pode excluir só esta parcela ou a compra inteira.'
            : ' Não tem como desfazer.'}
        </p>
      </Modal>

      <Modal
        open={inspectIds !== null}
        onClose={() => setInspectIds(null)}
        title="Lançamentos apontados"
        size="lg"
      >
        <ul className="divide-y divide-line">
          {(inspectIds ?? []).map((id) => {
            const tx = data.transactions.find((t) => t.id === id);
            if (!tx) return null;
            return (
              <li key={id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-ink">{tx.description}</span>
                  <span className="text-[12px] text-ink-3">{tx.date}</span>
                </span>
                <span className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setInspectIds(null);
                      openEdit(tx);
                    }}
                  >
                    Editar
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void actions.deleteTransaction(tx.id)}>
                    Excluir
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      </Modal>
    </div>
  );
}

function TransferForm({
  open,
  onClose,
  data,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  data: ReturnType<typeof useStore>['data'];
  onSave: (tx: Transaction) => Promise<void>;
}) {
  const accounts = data.accounts.filter((a) => !a.archived);
  const [from, setFrom] = useState(accounts[0]?.id ?? '');
  const [to, setTo] = useState(accounts[1]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayOf());
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    const cents = parseMoney(amount);
    if (!cents || cents <= 0) {
      setError('Informe o valor.');
      return;
    }
    try {
      await onSave(
        buildTransfer({
          date,
          amountCents: cents,
          fromAccountId: from,
          toAccountId: to,
          description: description.trim() || undefined,
        }),
      );
      setAmount('');
      setDescription('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar.');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Transferência entre contas"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={handleSave}>
            Transferir
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Notice tone="info" title="Não é receita nem despesa">
          O dinheiro só muda de conta. Seu resultado do mês continua o mesmo.
        </Notice>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="De">
            <Select value={from} onChange={(e) => setFrom(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Para">
            <Select value={to} onChange={(e) => setTo(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Valor">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" />
          </Field>
          <Field label="Data">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Descrição (opcional)">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Aporte na reserva" />
        </Field>
        {error ? <Notice tone="critical">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
