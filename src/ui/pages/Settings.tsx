/** Configurações: categorias, regras, contas fixas, backup e privacidade. */

import { useMemo, useRef, useState } from 'react';
import { formatMoney, parseMoney } from '../../domain/money';
import { currentMonth } from '../../domain/dates';
import { newId } from '../../domain/transaction';
import { backupFileName, buildPlainBackup, encryptBackup, readBackupFile } from '../../db/backup';
import type {
  Category,
  CategoryRule,
  FinanceDataset,
  RecurringRule,
  Settings as SettingsType,
  ThemePreference,
} from '../../domain/types';
import {
  Badge,
  Button,
  Field,
  Input,
  Modal,
  Notice,
  Panel,
  PanelHeader,
  Select,
  Toggle,
} from '../components/primitives';

type Section = 'geral' | 'categorias' | 'regras' | 'fixas' | 'dados';

export function SettingsPage({
  data,
  onSaveSettings,
  onSaveCategory,
  onDeleteCategory,
  onSaveRule,
  onDeleteRule,
  onSaveRecurring,
  onDeleteRecurring,
  onRestore,
  onLoadDemo,
  onWipe,
}: {
  data: FinanceDataset;
  onSaveSettings: (settings: Partial<SettingsType>) => Promise<void>;
  onSaveCategory: (category: Category) => Promise<void>;
  onDeleteCategory: (id: string) => Promise<void>;
  onSaveRule: (rule: CategoryRule) => Promise<void>;
  onDeleteRule: (id: string) => Promise<void>;
  onSaveRecurring: (rule: RecurringRule) => Promise<void>;
  onDeleteRecurring: (id: string) => Promise<void>;
  onRestore: (data: FinanceDataset) => Promise<void>;
  onLoadDemo: () => Promise<void>;
  onWipe: () => Promise<void>;
}) {
  const [section, setSection] = useState<Section>('geral');

  const sections: { key: Section; label: string }[] = [
    { key: 'geral', label: 'Geral' },
    { key: 'categorias', label: 'Categorias' },
    { key: 'regras', label: 'Regras automáticas' },
    { key: 'fixas', label: 'Contas fixas' },
    { key: 'dados', label: 'Backup e dados' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {sections.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setSection(item.key)}
            className={`rounded-full border px-3.5 py-1.5 text-[13px] transition-colors ${
              section === item.key
                ? 'border-transparent bg-accent text-accent-ink'
                : 'border-line text-ink-2 hover:bg-surface-hover'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {section === 'geral' ? <General data={data} onSave={onSaveSettings} /> : null}
      {section === 'categorias' ? (
        <Categories data={data} onSave={onSaveCategory} onDelete={onDeleteCategory} />
      ) : null}
      {section === 'regras' ? <Rules data={data} onSave={onSaveRule} onDelete={onDeleteRule} /> : null}
      {section === 'fixas' ? (
        <Recurring data={data} onSave={onSaveRecurring} onDelete={onDeleteRecurring} />
      ) : null}
      {section === 'dados' ? (
        <DataSection data={data} onRestore={onRestore} onLoadDemo={onLoadDemo} onWipe={onWipe} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function General({ data, onSave }: { data: FinanceDataset; onSave: (s: Partial<SettingsType>) => Promise<void> }) {
  const s = data.settings;
  const [threshold, setThreshold] = useState((s.lowBalanceThresholdCents / 100).toFixed(2).replace('.', ','));

  return (
    <Panel>
      <PanelHeader title="Preferências" />
      <div className="grid gap-5 p-5 sm:grid-cols-2">
        <Field label="Tema">
          <Select value={s.theme} onChange={(e) => void onSave({ theme: e.target.value as ThemePreference })}>
            <option value="system">Seguir o sistema</option>
            <option value="light">Claro</option>
            <option value="dark">Escuro</option>
          </Select>
        </Field>

        <Field label="Semana começa em">
          <Select
            value={s.firstDayOfWeek}
            onChange={(e) => void onSave({ firstDayOfWeek: Number(e.target.value) as 0 | 1 })}
          >
            <option value={0}>Domingo</option>
            <option value={1}>Segunda-feira</option>
          </Select>
        </Field>

        <Field label="Avisar quando o saldo ficar abaixo de">
          <Input
            inputMode="decimal"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            onBlur={() => void onSave({ lowBalanceThresholdCents: parseMoney(threshold) ?? 0 })}
          />
        </Field>

        <Field label="Avisar quando o orçamento chegar a">
          <Select
            value={s.budgetWarnRatio}
            onChange={(e) => void onSave({ budgetWarnRatio: Number(e.target.value) })}
          >
            {[0.7, 0.8, 0.9, 1].map((value) => (
              <option key={value} value={value}>
                {value * 100}% do limite
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Horizonte dos compromissos futuros">
          <Select
            value={s.commitmentHorizonMonths}
            onChange={(e) => void onSave({ commitmentHorizonMonths: Number(e.target.value) })}
          >
            {[3, 6, 12, 24].map((value) => (
              <option key={value} value={value}>
                {value} meses
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex items-center sm:col-span-2">
          <Toggle
            checked={s.hideAmounts}
            onChange={(value) => void onSave({ hideAmounts: value })}
            label="Modo privacidade"
            hint="Esconde todos os valores na tela. Útil em lugar público. Atalho: tecla P."
          />
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function Categories({
  data,
  onSave,
  onDelete,
}: {
  data: FinanceDataset;
  onSave: (c: Category) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<Category | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tree = useMemo(() => {
    const roots = data.categories.filter((c) => !c.parentId).sort((a, b) => a.name.localeCompare(b.name));
    return roots.map((root) => ({
      root,
      children: data.categories.filter((c) => c.parentId === root.id).sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [data.categories]);

  const usage = useMemo(() => {
    const map = new Map<string, number>();
    for (const tx of data.transactions) {
      if (tx.categoryId) map.set(tx.categoryId, (map.get(tx.categoryId) ?? 0) + 1);
    }
    return map;
  }, [data.transactions]);

  return (
    <>
      {error ? <Notice tone="critical">{error}</Notice> : null}
      <Panel>
        <PanelHeader
          title="Categorias"
          description="Renomeie, arquive ou crie o que fizer sentido para você"
          action={
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Nova categoria
            </Button>
          }
        />
        <ul className="divide-y divide-line">
          {tree.map(({ root, children }) => (
            <li key={root.id} className="px-5 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: root.color }} />
                  <span className="truncate text-[14px] font-medium text-ink">{root.name}</span>
                  <Badge tone="neutral">{root.kind === 'income' ? 'receita' : 'despesa'}</Badge>
                  {root.isFixed ? <Badge tone="neutral">fixo</Badge> : null}
                  {root.archived ? <Badge tone="neutral">arquivada</Badge> : null}
                  <span className="text-[12px] text-ink-3">{usage.get(root.id) ?? 0} uso(s)</span>
                </span>
                <span className="flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(root)}>
                    Editar
                  </Button>
                  {!root.system ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        setError(null);
                        try {
                          await onDelete(root.id);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Erro');
                        }
                      }}
                    >
                      Excluir
                    </Button>
                  ) : null}
                </span>
              </div>
              {children.length > 0 ? (
                <ul className="mt-2 ml-4 space-y-1 border-l border-line pl-4">
                  {children.map((child) => (
                    <li key={child.id} className="flex items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2 text-[13px] text-ink-2">
                        <span className="truncate">{child.name}</span>
                        {child.isFixed ? <Badge tone="neutral">fixo</Badge> : null}
                        {child.archived ? <Badge tone="neutral">arquivada</Badge> : null}
                        <span className="text-[12px] text-ink-3">{usage.get(child.id) ?? 0}</span>
                      </span>
                      <span className="flex shrink-0 gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(child)}>
                          Editar
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            setError(null);
                            try {
                              await onDelete(child.id);
                            } catch (err) {
                              setError(err instanceof Error ? err.message : 'Erro');
                            }
                          }}
                        >
                          Excluir
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </Panel>

      <CategoryForm
        open={creating || editing !== null}
        category={editing}
        data={data}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSave={onSave}
      />
    </>
  );
}

function CategoryForm({
  open,
  category,
  data,
  onClose,
  onSave,
}: {
  open: boolean;
  category: Category | null;
  data: FinanceDataset;
  onClose: () => void;
  onSave: (c: Category) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [color, setColor] = useState('#6366f1');
  const [isFixed, setIsFixed] = useState(false);
  const [archived, setArchived] = useState(false);
  const [key, setKey] = useState('');

  const currentKey = `${open}-${category?.id ?? 'new'}`;
  if (key !== currentKey) {
    setKey(currentKey);
    setName(category?.name ?? '');
    setParentId(category?.parentId ?? '');
    setKind(category?.kind ?? 'expense');
    setColor(category?.color ?? '#6366f1');
    setIsFixed(category?.isFixed ?? false);
    setArchived(category?.archived ?? false);
  }

  async function handleSave() {
    if (!name.trim()) return;
    const now = new Date().toISOString();
    const next: Category = {
      id: category?.id ?? newId('cat'),
      name: name.trim(),
      kind,
      color,
      isFixed,
      archived,
      createdAt: category?.createdAt ?? now,
      updatedAt: now,
    };
    if (parentId) next.parentId = parentId;
    if (category?.system) next.system = true;
    await onSave(next);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={category ? 'Editar categoria' : 'Nova categoria'}
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
        <Field label="Nome">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tipo">
            <Select value={kind} onChange={(e) => setKind(e.target.value as 'expense' | 'income')}>
              <option value="expense">Despesa</option>
              <option value="income">Receita</option>
            </Select>
          </Field>
          <Field label="Categoria mãe" hint="Deixe vazio para ser uma categoria principal">
            <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">Nenhuma</option>
              {data.categories
                .filter((c) => !c.parentId && c.kind === kind && c.id !== category?.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <Field label="Cor">
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-10 w-20 cursor-pointer rounded border border-line bg-surface"
          />
        </Field>
        <Toggle
          checked={isFixed}
          onChange={setIsFixed}
          label="Gasto fixo por padrão"
          hint="Lançamentos desta categoria entram como fixos na análise."
        />
        {category ? (
          <Toggle checked={archived} onChange={setArchived} label="Arquivar" hint="Deixa de aparecer nas listas." />
        ) : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function Rules({
  data,
  onSave,
  onDelete,
}: {
  data: FinanceDataset;
  onSave: (r: CategoryRule) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [pattern, setPattern] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const categoryMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories]);
  const rules = useMemo(() => [...data.rules].sort((a, b) => a.priority - b.priority || a.pattern.localeCompare(b.pattern)), [data.rules]);

  async function handleAdd() {
    if (!pattern.trim() || !categoryId) return;
    const now = new Date().toISOString();
    await onSave({
      id: newId('rule'),
      pattern: pattern.trim().toLowerCase(),
      matchType: 'contains',
      categoryId,
      priority: 50,
      active: true,
      hits: 0,
      createdAt: now,
      updatedAt: now,
    });
    setPattern('');
  }

  return (
    <Panel>
      <PanelHeader
        title="Regras de categorização"
        description="Quando a descrição contém o texto, a categoria é aplicada sozinha. Sua escolha manual sempre prevalece."
      />
      <div className="grid gap-3 border-b border-line p-5 sm:grid-cols-[1fr_1fr_auto]">
        <Field label="Quando a descrição contiver">
          <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="ex.: mercado bom preco" />
        </Field>
        <Field label="Usar a categoria">
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Selecione…</option>
            {data.categories
              .filter((c) => !c.archived)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.parentId ? `${categoryMap.get(c.parentId)?.name ?? ''} › ${c.name}` : c.name}
                </option>
              ))}
          </Select>
        </Field>
        <div className="flex items-end">
          <Button variant="primary" onClick={handleAdd} disabled={!pattern.trim() || !categoryId}>
            Adicionar
          </Button>
        </div>
      </div>

      <ul className="divide-y divide-line">
        {rules.map((rule) => (
          <li key={rule.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
            <span className="flex min-w-0 flex-wrap items-center gap-2 text-[13px]">
              <code className="rounded bg-surface-2 px-1.5 py-0.5 text-[12px] text-ink">{rule.pattern}</code>
              <span className="text-ink-3">→</span>
              <span className="text-ink">{categoryMap.get(rule.categoryId)?.name ?? 'categoria removida'}</span>
              {!rule.active ? <Badge tone="neutral">inativa</Badge> : null}
              <span className="text-[12px] text-ink-3">prioridade {rule.priority}</span>
            </span>
            <span className="flex shrink-0 gap-1">
              <Button size="sm" variant="ghost" onClick={() => void onSave({ ...rule, active: !rule.active })}>
                {rule.active ? 'Desativar' : 'Ativar'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void onDelete(rule.id)}>
                Excluir
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function Recurring({
  data,
  onSave,
  onDelete,
}: {
  data: FinanceDataset;
  onSave: (r: RecurringRule) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [day, setDay] = useState(5);
  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState('');
  const categoryMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories]);

  async function handleAdd() {
    const cents = parseMoney(amount);
    if (!description.trim() || !cents) return;
    const now = new Date().toISOString();
    const rule: RecurringRule = {
      id: newId('rec'),
      description: description.trim(),
      amountCents: cents,
      kind: 'expense',
      dayOfMonth: day,
      paymentMethod: 'debit',
      isFixed: true,
      startMonth: currentMonth(),
      endMonth: null,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    if (categoryId) rule.categoryId = categoryId;
    if (accountId) rule.accountId = accountId;
    await onSave(rule);
    setDescription('');
    setAmount('');
  }

  return (
    <Panel>
      <PanelHeader
        title="Contas fixas"
        description="Entram na projeção de compromissos futuros. Assim que você lança a conta do mês, a projeção daquele mês some — nada é contado duas vezes."
      />
      <div className="grid gap-3 border-b border-line p-5 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Descrição" className="lg:col-span-2">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Aluguel" />
        </Field>
        <Field label="Valor">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" />
        </Field>
        <Field label="Dia do mês">
          <Select value={day} onChange={(e) => setDay(Number(e.target.value))}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Categoria">
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Nenhuma</option>
            {data.categories
              .filter((c) => c.kind === 'expense' && !c.archived)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Conta">
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Nenhuma</option>
            {data.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-end">
          <Button variant="primary" onClick={handleAdd} disabled={!description.trim() || !amount}>
            Adicionar
          </Button>
        </div>
      </div>

      <ul className="divide-y divide-line">
        {data.recurring.map((rule) => (
          <li key={rule.id} className="flex items-center justify-between gap-3 px-5 py-3">
            <span className="min-w-0">
              <span className="flex items-center gap-2">
                <span className="truncate text-[13px] text-ink">{rule.description}</span>
                {!rule.active ? <Badge tone="neutral">inativa</Badge> : null}
              </span>
              <span className="text-[12px] text-ink-3">
                Todo dia {rule.dayOfMonth} · {formatMoney(rule.amountCents)}
                {rule.categoryId ? ` · ${categoryMap.get(rule.categoryId)?.name ?? ''}` : ''}
              </span>
            </span>
            <span className="flex shrink-0 gap-1">
              <Button size="sm" variant="ghost" onClick={() => void onSave({ ...rule, active: !rule.active })}>
                {rule.active ? 'Desativar' : 'Ativar'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void onDelete(rule.id)}>
                Excluir
              </Button>
            </span>
          </li>
        ))}
        {data.recurring.length === 0 ? (
          <li className="px-5 py-6 text-center text-[13px] text-ink-3">Nenhuma conta fixa cadastrada.</li>
        ) : null}
      </ul>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function DataSection({
  data,
  onRestore,
  onLoadDemo,
  onWipe,
}: {
  data: FinanceDataset;
  onRestore: (data: FinanceDataset) => Promise<void>;
  onLoadDemo: () => Promise<void>;
  onWipe: () => Promise<void>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [restorePassword, setRestorePassword] = useState('');
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'good' | 'critical' | 'warning'; text: string } | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [busy, setBusy] = useState(false);

  function download(content: string, name: string) {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleExportEncrypted() {
    setMessage(null);
    try {
      setBusy(true);
      const backup = await encryptBackup(data, password);
      download(JSON.stringify(backup), backupFileName(true));
      setPassword('');
      setMessage({
        tone: 'good',
        text: 'Backup criptografado gerado. Guarde a senha em lugar seguro — sem ela o arquivo é irrecuperável.',
      });
    } catch (err) {
      setMessage({ tone: 'critical', text: err instanceof Error ? err.message : 'Erro ao gerar o backup.' });
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore() {
    if (!pendingFile) return;
    setMessage(null);
    try {
      setBusy(true);
      const restored = await readBackupFile(pendingFile, restorePassword || undefined);
      await onRestore(restored);
      setPendingFile(null);
      setRestorePassword('');
      if (fileInput.current) fileInput.current.value = '';
      setMessage({ tone: 'good', text: `Backup restaurado: ${restored.transactions.length} lançamento(s).` });
    } catch (err) {
      setMessage({ tone: 'critical', text: err instanceof Error ? err.message : 'Não foi possível restaurar.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <Panel>
        <PanelHeader
          title="Onde ficam os seus dados"
          description="Nada é enviado para nenhum servidor — não existe servidor neste projeto."
        />
        <div className="space-y-3 p-5 text-[13px] text-ink-2">
          <p>
            Tudo fica no banco de dados do seu navegador, neste dispositivo. Isso significa privacidade total, e também
            que <strong className="text-ink">o backup é responsabilidade sua</strong>: limpar os dados do site, trocar
            de navegador ou de computador leva os dados embora.
          </p>
          <p>
            {data.transactions.length} lançamento(s) · {data.accounts.length} conta(s) · {data.cards.length} cartão(ões)
            · {data.categories.length} categoria(s)
          </p>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Exportar backup" description="Faça isso todo mês, logo depois de atualizar os dados" />
        <div className="space-y-4 p-5">
          <Field
            label="Senha do backup"
            hint="Mínimo 8 caracteres. O arquivo é cifrado com AES-256. A senha não fica guardada em lugar nenhum — se perder, o backup não abre."
          >
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Sua senha"
              autoComplete="new-password"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={handleExportEncrypted} disabled={password.length < 8 || busy}>
              Exportar backup criptografado
            </Button>
            <Button
              onClick={() => download(JSON.stringify(buildPlainBackup(data), null, 2), backupFileName(false))}
            >
              Exportar sem criptografia
            </Button>
          </div>
          <p className="text-[12px] text-ink-3">
            O arquivo sem criptografia é legível por qualquer pessoa que o abrir. Use apenas para inspecionar os dados.
          </p>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Restaurar backup" description="Substitui TODO o conteúdo atual" />
        <div className="space-y-4 p-5">
          <input
            ref={fileInput}
            type="file"
            accept=".fbk,.json"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) setPendingFile(await file.text());
            }}
          />
          <div className="flex flex-wrap items-end gap-3">
            <Button onClick={() => fileInput.current?.click()}>Escolher arquivo</Button>
            {pendingFile ? (
              <>
                <Field label="Senha do backup" className="min-w-56">
                  <Input
                    type="password"
                    value={restorePassword}
                    onChange={(e) => setRestorePassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </Field>
                <Button variant="primary" onClick={handleRestore} disabled={busy}>
                  Restaurar
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Dados de exemplo" description="Para conhecer a plataforma antes de usar de verdade" />
        <div className="space-y-3 p-5">
          <p className="text-[13px] text-ink-2">
            Carrega seis meses de movimentação fictícia — contas, cartão, parcelas, orçamento e contas fixas. Substitui
            tudo o que estiver aqui hoje.
          </p>
          <Button
            onClick={async () => {
              await onLoadDemo();
              setMessage({ tone: 'good', text: 'Dados de exemplo carregados.' });
            }}
          >
            Carregar dados de exemplo
          </Button>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Apagar tudo" />
        <div className="space-y-3 p-5">
          <p className="text-[13px] text-ink-2">
            Remove todos os lançamentos, contas, cartões e orçamentos deste navegador. Não tem como desfazer.
          </p>
          {confirmWipe ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-critical-ink">Tem certeza? Exporte um backup antes.</span>
              <Button
                variant="danger"
                onClick={async () => {
                  await onWipe();
                  setConfirmWipe(false);
                  setMessage({ tone: 'warning', text: 'Todos os dados foram apagados.' });
                }}
              >
                Sim, apagar tudo
              </Button>
              <Button variant="ghost" onClick={() => setConfirmWipe(false)}>
                Cancelar
              </Button>
            </div>
          ) : (
            <Button variant="danger" onClick={() => setConfirmWipe(true)}>
              Apagar todos os dados
            </Button>
          )}
        </div>
      </Panel>
    </div>
  );
}
