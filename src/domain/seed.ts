/**
 * Dados iniciais: categorias e regras de categorização que já vêm prontas.
 *
 * Só existem para você não começar de uma tela em branco. Tudo pode ser
 * renomeado, desativado ou excluído nas Configurações.
 */

import type { Category, CategoryRule, ID } from './types';
import { UNCATEGORIZED_ID } from './types';

const now = () => new Date().toISOString();

interface CategorySeed {
  id: ID;
  name: string;
  color: string;
  isFixed?: boolean;
  children?: { id: ID; name: string; isFixed?: boolean }[];
}

const EXPENSE_SEEDS: CategorySeed[] = [
  {
    id: 'cat-moradia', name: 'Moradia', color: '#6366f1', isFixed: true,
    children: [
      { id: 'cat-aluguel', name: 'Aluguel', isFixed: true },
      { id: 'cat-condominio', name: 'Condomínio', isFixed: true },
      { id: 'cat-energia', name: 'Energia', isFixed: true },
      { id: 'cat-agua', name: 'Água', isFixed: true },
      { id: 'cat-internet', name: 'Internet e telefone', isFixed: true },
      { id: 'cat-casa-manutencao', name: 'Manutenção da casa' },
    ],
  },
  {
    id: 'cat-alimentacao', name: 'Alimentação', color: '#f59e0b',
    children: [
      { id: 'cat-mercado', name: 'Mercado' },
      { id: 'cat-restaurante', name: 'Restaurante' },
      { id: 'cat-delivery', name: 'Delivery' },
      { id: 'cat-padaria', name: 'Padaria e café' },
    ],
  },
  {
    id: 'cat-transporte', name: 'Transporte', color: '#0ea5e9',
    children: [
      { id: 'cat-app-transporte', name: 'App de transporte' },
      { id: 'cat-combustivel', name: 'Combustível' },
      { id: 'cat-transporte-publico', name: 'Transporte público' },
      { id: 'cat-estacionamento', name: 'Estacionamento e pedágio' },
      { id: 'cat-veiculo', name: 'Manutenção do veículo' },
    ],
  },
  {
    id: 'cat-saude', name: 'Saúde', color: '#10b981',
    children: [
      { id: 'cat-plano-saude', name: 'Plano de saúde', isFixed: true },
      { id: 'cat-farmacia', name: 'Farmácia' },
      { id: 'cat-consultas', name: 'Consultas e exames' },
      { id: 'cat-academia', name: 'Academia', isFixed: true },
    ],
  },
  {
    id: 'cat-lazer', name: 'Lazer', color: '#ec4899',
    children: [
      { id: 'cat-streaming', name: 'Streaming', isFixed: true },
      { id: 'cat-bares', name: 'Bares e saídas' },
      { id: 'cat-viagens', name: 'Viagens' },
      { id: 'cat-cultura', name: 'Cinema e cultura' },
    ],
  },
  {
    id: 'cat-compras', name: 'Compras', color: '#a855f7',
    children: [
      { id: 'cat-roupas', name: 'Roupas e acessórios' },
      { id: 'cat-eletronicos', name: 'Eletrônicos' },
      { id: 'cat-casa-itens', name: 'Itens de casa' },
      { id: 'cat-presentes', name: 'Presentes' },
    ],
  },
  {
    id: 'cat-cuidados', name: 'Cuidados pessoais', color: '#14b8a6',
    children: [
      { id: 'cat-beleza', name: 'Beleza' },
      { id: 'cat-servicos-dom', name: 'Serviços domésticos', isFixed: true },
    ],
  },
  {
    id: 'cat-educacao', name: 'Educação', color: '#3b82f6',
    children: [
      { id: 'cat-cursos', name: 'Cursos' },
      { id: 'cat-livros', name: 'Livros' },
      { id: 'cat-mensalidade', name: 'Mensalidade', isFixed: true },
    ],
  },
  {
    id: 'cat-assinaturas', name: 'Assinaturas e software', color: '#8b5cf6', isFixed: true,
  },
  {
    id: 'cat-financeiro', name: 'Taxas e impostos', color: '#64748b', isFixed: true,
    children: [
      { id: 'cat-tarifas', name: 'Tarifas bancárias', isFixed: true },
      { id: 'cat-impostos', name: 'Impostos' },
      { id: 'cat-juros', name: 'Juros e multas' },
    ],
  },
  { id: 'cat-pets', name: 'Pets', color: '#f97316' },
  { id: 'cat-doacoes', name: 'Doações', color: '#22c55e' },
  { id: 'cat-outros', name: 'Outros', color: '#94a3b8' },
];

const INCOME_SEEDS: CategorySeed[] = [
  { id: 'cat-salario', name: 'Salário', color: '#22c55e', isFixed: true },
  { id: 'cat-extra', name: 'Renda extra', color: '#84cc16' },
  { id: 'cat-rendimentos', name: 'Rendimentos', color: '#06b6d4' },
  { id: 'cat-vendas', name: 'Vendas', color: '#eab308' },
  { id: 'cat-outras-receitas', name: 'Outras receitas', color: '#94a3b8' },
];

export function defaultCategories(): Category[] {
  const timestamp = now();
  const categories: Category[] = [
    {
      id: UNCATEGORIZED_ID,
      name: 'Sem categoria',
      kind: 'expense',
      color: '#94a3b8',
      isFixed: false,
      system: true,
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];

  const add = (seeds: CategorySeed[], kind: 'expense' | 'income') => {
    for (const seed of seeds) {
      categories.push({
        id: seed.id,
        name: seed.name,
        kind,
        color: seed.color,
        isFixed: seed.isFixed ?? false,
        archived: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      for (const child of seed.children ?? []) {
        categories.push({
          id: child.id,
          name: child.name,
          parentId: seed.id,
          kind,
          color: seed.color,
          isFixed: child.isFixed ?? false,
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
    }
  };

  add(EXPENSE_SEEDS, 'expense');
  add(INCOME_SEEDS, 'income');
  return categories;
}

/**
 * Regras prontas para os estabelecimentos mais comuns no Brasil.
 * Prioridade menor = avaliada antes ("uber eats" precisa vencer "uber").
 */
const RULE_SEEDS: [pattern: string, categoryId: ID, priority: number][] = [
  ['uber eats', 'cat-delivery', 10],
  ['ifood', 'cat-delivery', 10],
  ['rappi', 'cat-delivery', 10],
  ['zedelivery', 'cat-delivery', 10],
  ['uber', 'cat-app-transporte', 20],
  ['99app', 'cat-app-transporte', 20],
  ['99 tecnologia', 'cat-app-transporte', 20],
  ['cabify', 'cat-app-transporte', 20],
  ['netflix', 'cat-streaming', 10],
  ['spotify', 'cat-streaming', 10],
  ['disney', 'cat-streaming', 10],
  ['hbo', 'cat-streaming', 10],
  ['globoplay', 'cat-streaming', 10],
  ['prime video', 'cat-streaming', 10],
  ['youtube premium', 'cat-streaming', 10],
  ['deezer', 'cat-streaming', 10],
  ['icloud', 'cat-assinaturas', 10],
  ['google one', 'cat-assinaturas', 10],
  ['microsoft', 'cat-assinaturas', 15],
  ['adobe', 'cat-assinaturas', 10],
  ['supermercado', 'cat-mercado', 20],
  ['mercado extra', 'cat-mercado', 15],
  ['carrefour', 'cat-mercado', 15],
  ['pao de acucar', 'cat-mercado', 15],
  ['assai', 'cat-mercado', 15],
  ['atacadao', 'cat-mercado', 15],
  ['big bompreco', 'cat-mercado', 15],
  ['hortifruti', 'cat-mercado', 15],
  ['padaria', 'cat-padaria', 20],
  ['cafeteria', 'cat-padaria', 20],
  ['starbucks', 'cat-padaria', 15],
  ['restaurante', 'cat-restaurante', 20],
  ['pizzaria', 'cat-restaurante', 20],
  ['burger', 'cat-restaurante', 20],
  ['mc donalds', 'cat-restaurante', 15],
  ['outback', 'cat-restaurante', 15],
  ['posto', 'cat-combustivel', 20],
  ['shell', 'cat-combustivel', 15],
  ['ipiranga', 'cat-combustivel', 15],
  ['petrobras', 'cat-combustivel', 15],
  ['estacionamento', 'cat-estacionamento', 20],
  ['zona azul', 'cat-estacionamento', 15],
  ['sem parar', 'cat-estacionamento', 15],
  ['conectcar', 'cat-estacionamento', 15],
  ['drogaria', 'cat-farmacia', 15],
  ['farmacia', 'cat-farmacia', 15],
  ['droga raia', 'cat-farmacia', 10],
  ['drogasil', 'cat-farmacia', 10],
  ['pacheco', 'cat-farmacia', 15],
  ['unimed', 'cat-plano-saude', 10],
  ['amil', 'cat-plano-saude', 10],
  ['sulamerica', 'cat-plano-saude', 10],
  ['bradesco saude', 'cat-plano-saude', 10],
  ['smartfit', 'cat-academia', 10],
  ['smart fit', 'cat-academia', 10],
  ['bluefit', 'cat-academia', 10],
  ['academia', 'cat-academia', 20],
  ['amazon', 'cat-compras', 20],
  ['mercado livre', 'cat-compras', 15],
  ['mercadolivre', 'cat-compras', 15],
  ['shopee', 'cat-compras', 15],
  ['aliexpress', 'cat-compras', 15],
  ['magazine luiza', 'cat-compras', 15],
  ['renner', 'cat-roupas', 15],
  ['zara', 'cat-roupas', 15],
  ['riachuelo', 'cat-roupas', 15],
  ['cinema', 'cat-cultura', 20],
  ['cinemark', 'cat-cultura', 15],
  ['ingresso com', 'cat-cultura', 15],
  ['aluguel', 'cat-aluguel', 20],
  ['condominio', 'cat-condominio', 20],
  ['enel', 'cat-energia', 15],
  ['cemig', 'cat-energia', 15],
  ['copel', 'cat-energia', 15],
  ['light servicos', 'cat-energia', 15],
  ['cpfl', 'cat-energia', 15],
  ['sabesp', 'cat-agua', 15],
  ['cedae', 'cat-agua', 15],
  ['sanepar', 'cat-agua', 15],
  ['comgas', 'cat-energia', 15],
  ['vivo', 'cat-internet', 15],
  ['claro', 'cat-internet', 15],
  ['tim ', 'cat-internet', 15],
  ['oi fibra', 'cat-internet', 15],
  ['net servicos', 'cat-internet', 15],
  ['petshop', 'cat-pets', 15],
  ['pet shop', 'cat-pets', 15],
  ['petz', 'cat-pets', 15],
  ['cobasi', 'cat-pets', 15],
  ['tarifa', 'cat-tarifas', 25],
  ['anuidade', 'cat-tarifas', 20],
  ['iof', 'cat-tarifas', 20],
  ['juros', 'cat-juros', 20],
  ['multa', 'cat-juros', 25],
  ['salario', 'cat-salario', 10],
  ['pagamento salario', 'cat-salario', 5],
  ['remuneracao', 'cat-salario', 15],
  ['rendimento', 'cat-rendimentos', 15],
  ['dividendo', 'cat-rendimentos', 15],
];

export function defaultRules(): CategoryRule[] {
  const timestamp = now();
  return RULE_SEEDS.map(([pattern, categoryId, priority], index) => ({
    id: `rule-seed-${index}`,
    pattern,
    matchType: 'contains' as const,
    categoryId,
    priority,
    active: true,
    hits: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
}
