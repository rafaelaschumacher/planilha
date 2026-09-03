import { describe, expect, it } from 'vitest';
import { DUPLICATE_THRESHOLD, findDuplicates, scanForDuplicates, scoreDuplicate } from '../src/domain/duplicates';
import { matchRule, ruleFromCorrection, suggestCategory, suggestFromHistory } from '../src/domain/categorize';
import { buildInstallmentPurchase, buildTransaction } from '../src/domain/transaction';
import { defaultRules } from '../src/domain/seed';
import { normalizeMerchant, tokenSimilarity } from '../src/domain/text';

const rules = defaultRules();

describe('detecção de duplicidade', () => {
  const existente = buildTransaction({
    kind: 'expense', date: '2024-03-10', description: 'Mercado Bom Preço',
    amountCents: 15_000, accountId: 'acc',
  });

  it('reconhece o mesmo lançamento importado de novo', () => {
    const { score } = scoreDuplicate(
      { kind: 'expense', date: '2024-03-10', description: 'MERCADO BOM PRECO', amountCents: 15_000, accountId: 'acc' },
      existente,
    );
    expect(score).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });

  it('valor diferente NUNCA é duplicidade', () => {
    const { score } = scoreDuplicate(
      { kind: 'expense', date: '2024-03-10', description: 'Mercado Bom Preço', amountCents: 15_001, accountId: 'acc' },
      existente,
    );
    expect(score).toBe(0);
  });

  it('identificador do banco decide nos dois sentidos', () => {
    const comId = buildTransaction({ kind: 'expense', date: '2024-03-10', description: 'X', amountCents: 15_000, accountId: 'acc', externalId: 'FIT-1' });
    expect(scoreDuplicate({ kind: 'expense', date: '2024-03-01', description: 'Outro texto', amountCents: 99_999, accountId: 'acc', externalId: 'FIT-1' }, comId).score).toBe(1);
    expect(scoreDuplicate({ kind: 'expense', date: '2024-03-10', description: 'X', amountCents: 15_000, accountId: 'acc', externalId: 'FIT-2' }, comId).score).toBe(0);
  });

  it('datas distantes não são duplicidade', () => {
    const { score } = scoreDuplicate(
      { kind: 'expense', date: '2024-03-20', description: 'Mercado Bom Preço', amountCents: 15_000, accountId: 'acc' },
      existente,
    );
    expect(score).toBe(0);
  });

  it('contas diferentes derrubam a suspeita', () => {
    const { score } = scoreDuplicate(
      { kind: 'expense', date: '2024-03-10', description: 'Mercado Bom Preço', amountCents: 15_000, accountId: 'outra' },
      existente,
    );
    expect(score).toBeLessThan(DUPLICATE_THRESHOLD);
  });

  it('tipos diferentes nunca são duplicidade', () => {
    const receita = buildTransaction({ kind: 'income', date: '2024-03-10', description: 'Mercado Bom Preço', amountCents: 15_000, accountId: 'acc' });
    expect(scoreDuplicate({ kind: 'expense', date: '2024-03-10', description: 'Mercado Bom Preço', amountCents: 15_000, accountId: 'acc' }, receita).score).toBe(0);
  });

  it('parcelas do mesmo parcelamento não são duplicatas entre si', () => {
    const parcelas = buildInstallmentPurchase({ date: '2024-03-10', description: 'Sofá', totalCents: 60_000, installments: 3, cardId: 'card' });
    expect(scanForDuplicates(parcelas)).toHaveLength(0);
  });

  it('dois cafés iguais no mesmo dia são sinalizados, mas nada é apagado', () => {
    const a = buildTransaction({ kind: 'expense', date: '2024-03-10', description: 'Café da Esquina', amountCents: 1_200, accountId: 'acc' });
    const b = buildTransaction({ kind: 'expense', date: '2024-03-10', description: 'Café da Esquina', amountCents: 1_200, accountId: 'acc' });
    const pares = scanForDuplicates([a, b]);
    expect(pares).toHaveLength(1);
    // A função apenas relata — quem decide é a pessoa.
    expect(pares[0]!.reasons).toContain('mesmo valor');
  });

  it('encontra o candidato mais provável numa lista', () => {
    const outros = [
      buildTransaction({ kind: 'expense', date: '2024-03-09', description: 'Padaria', amountCents: 15_000, accountId: 'acc' }),
      existente,
    ];
    const matches = findDuplicates({ kind: 'expense', date: '2024-03-10', description: 'Mercado Bom Preço', amountCents: 15_000, accountId: 'acc' }, outros);
    expect(matches[0]?.existing.id).toBe(existente.id);
  });
});

describe('normalização de descrição de extrato', () => {
  it('remove ruído de fatura e extrato', () => {
    expect(normalizeMerchant('COMPRA CARTAO 12/03 IFOOD *IFD 887711')).toContain('ifood');
    expect(normalizeMerchant('NETFLIX.COM  PARCELA 2/6')).toBe('netflix');
  });

  it('mede semelhança entre descrições', () => {
    expect(tokenSimilarity('Mercado Bom Preço', 'MERCADO BOM PRECO')).toBe(1);
    expect(tokenSimilarity('Uber Trip', 'Netflix')).toBe(0);
  });
});

describe('categorização automática', () => {
  it('aplica as regras prontas mais comuns', () => {
    expect(matchRule('UBER *TRIP SAO PAULO', rules)?.categoryId).toBe('cat-app-transporte');
    expect(matchRule('IFOOD *IFD BRASIL', rules)?.categoryId).toBe('cat-delivery');
    expect(matchRule('NETFLIX.COM', rules)?.categoryId).toBe('cat-streaming');
    expect(matchRule('DROGARIA SAO PAULO', rules)?.categoryId).toBe('cat-farmacia');
    expect(matchRule('POSTO IPIRANGA 42', rules)?.categoryId).toBe('cat-combustivel');
  });

  it('a regra mais específica vence a mais genérica', () => {
    // "uber eats" (prioridade 10) precisa vencer "uber" (prioridade 20).
    expect(matchRule('UBER EATS DELIVERY', rules)?.categoryId).toBe('cat-delivery');
    expect(matchRule('UBER TRIP', rules)?.categoryId).toBe('cat-app-transporte');
  });

  it('a categoria manual sempre prevalece sobre a automática', () => {
    const resultado = suggestCategory({
      description: 'NETFLIX.COM',
      rules,
      history: [],
      manualCategoryId: 'cat-outros',
    });
    expect(resultado.categoryId).toBe('cat-outros');
    expect(resultado.source).toBe('manual');
    expect(resultado.needsReview).toBe(false);
  });

  it('aprende com o histórico que você já classificou', () => {
    const historico = [
      buildTransaction({ kind: 'expense', date: '2024-02-10', description: 'Salão da Ana', amountCents: 9_000, accountId: 'acc', categoryId: 'cat-beleza', categorySource: 'manual' }),
    ];
    const sugestao = suggestFromHistory('SALAO DA ANA', historico);
    expect(sugestao?.categoryId).toBe('cat-beleza');
    expect(sugestao?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('não aprende com palpite antigo de baixa confiança', () => {
    const historico = [
      buildTransaction({ kind: 'expense', date: '2024-02-10', description: 'Loja X', amountCents: 9_000, accountId: 'acc', categoryId: 'cat-outros', categorySource: 'inferred' }),
    ];
    expect(suggestFromHistory('Loja X', historico)).toBeUndefined();
  });

  it('marca "revisar categoria" quando não tem confiança', () => {
    const resultado = suggestCategory({ description: 'PAGSEGURO *XPTO4471', rules, history: [] });
    expect(resultado.categoryId).toBeUndefined();
    expect(resultado.needsReview).toBe(true);
    expect(resultado.source).toBe('none');
  });

  it('cria regra a partir de uma correção manual', () => {
    const regra = ruleFromCorrection('COMPRA CARTAO 03/04 SALAO DA ANA 998877', 'cat-beleza');
    expect(regra.categoryId).toBe('cat-beleza');
    expect(regra.pattern).not.toMatch(/\d{6}/); // sem o código do estabelecimento
    expect(matchRule('SALAO DA ANA UNIDADE 2', [{ ...regra, createdAt: '', updatedAt: '' }])?.categoryId).toBe('cat-beleza');
  });

  it('regra com expressão inválida não derruba a importação', () => {
    const quebrada = [{ id: 'x', pattern: '([', matchType: 'regex' as const, categoryId: 'cat-outros', priority: 1, active: true, hits: 0, createdAt: '', updatedAt: '' }];
    expect(() => matchRule('qualquer coisa', quebrada)).not.toThrow();
    expect(matchRule('qualquer coisa', quebrada)).toBeUndefined();
  });
});
