# Finanças

Plataforma financeira pessoal. Você alimenta os dados ao longo do mês e ela
transforma isso em uma visão clara de onde seu dinheiro está.

Não é uma planilha bonita: é um sistema com banco de dados, regras financeiras
explícitas, importação de extratos, detecção de duplicidade e auditoria
automática — construído para que os números batam.

**Seus dados nunca saem do seu dispositivo.** Não existe servidor neste
projeto.

---

## Índice

- [O que ela responde](#o-que-ela-responde)
- [A regra mais importante](#a-regra-mais-importante)
- [Arquitetura](#arquitetura)
- [Instalação](#instalação)
- [Publicar no GitHub Pages](#publicar-no-github-pages)
- [Como usar todo mês](#como-usar-todo-mês)
- [Importação de dados](#importação-de-dados)
- [Backup — leia isto](#backup--leia-isto)
- [Segurança e privacidade](#segurança-e-privacidade)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Testes](#testes)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Manutenção](#manutenção)
- [Integração direta com bancos (Open Finance)](#integração-direta-com-bancos-open-finance)

---

## O que ela responde

Ao abrir, em uma tela:

| Pergunta | Onde |
|---|---|
| Quanto dinheiro eu tenho? | Saldo atual |
| Quanto entrou e quanto saiu no mês? | Receitas / Despesas |
| **Quanto eu ainda posso gastar de verdade?** | Disponível |
| Quanto já está comprometido? | Compromissos futuros |
| Quanto está no cartão e quanto devo pagar? | Fatura atual, limite usado |
| Quanto é gasto fixo e quanto é variável? | Fixos × variáveis |
| Onde estou gastando? | Categorias do mês |
| Como estou evoluindo? | Evolução mensal, taxa de economia |
| O que ainda vou pagar de parcelas? | Compras parceladas |

---

## A regra mais importante

> **Compra no cartão ≠ pagamento da fatura.**

Uma compra de R$ 200 no cartão é uma despesa de R$ 200. Quando a fatura de
R$ 2.000 é paga pela conta, isso **não** gera mais R$ 2.000 de despesa — apenas
reduz o saldo do banco e liquida a fatura.

Essa regra não depende de ninguém lembrar dela na hora de lançar. Ela está
imposta no código: receita e despesa saem exclusivamente da função
`pnlEffect()`, e transferência, pagamento de fatura e ajuste retornam **zero**
por construção.

```ts
// src/domain/transaction.ts
case 'card_payment':
  // A despesa já foi contada na COMPRA. Aqui só liquidamos a fatura.
  return { income: 0, expense: 0 };
```

Existe um arquivo de teste dedicado só a isso: `tests/regra-cartao.test.ts`.

### As outras regras que evitam número errado

| Regra | Por quê |
|---|---|
| Dinheiro é **inteiro em centavos**, nunca decimal | `0.1 + 0.2 ≠ 0.3` em ponto flutuante; em relatório isso vira centavo perdido |
| Datas são **strings civis** `AAAA-MM-DD`, com aritmética própria | `new Date('2024-03-01')` é lido como UTC e, em UTC−3, joga o lançamento para fevereiro |
| Faturas são **derivadas**, nunca gravadas | Fatura guardada como registro é o caminho curto para fatura duplicada |
| Saldo é **calculado**, nunca digitado | Você só informa o saldo inicial da conta; o resto vem dos lançamentos |
| Parcelas distribuem o resto nas primeiras | R$ 100 em 3× vira 33,34 + 33,33 + 33,33 — soma exata, como as operadoras fazem |
| Transferência entre contas próprias **não** é receita nem despesa | Senão o mesmo dinheiro apareceria como ganho e como gasto |
| Reembolso **reduz a despesa**, não vira receita | Senão receita e despesa ficariam inflados juntos |
| Duplicidade é **sinalizada**, nunca apagada | Um falso positivo apagando seu histórico é pior do que um aviso |

---

## Arquitetura

**Aplicação 100% client-side.** Sem servidor, sem login, sem banco na nuvem.

```
Navegador
├── Interface (React + TypeScript)
├── Motor financeiro (funções puras, sem efeito colateral)
└── IndexedDB  ← seus dados, apenas neste dispositivo
```

### Por que essa escolha

| Critério | Resultado |
|---|---|
| Custo | R$ 0, para sempre — sem servidor e sem banco para pagar |
| Privacidade | Dados financeiros não saem do dispositivo |
| Segurança | Sem login, sem sessão, sem API: não há superfície de ataque remota |
| Manutenção | Nada para cair às 3h da manhã, nada para atualizar por segurança |
| Evolução | O motor é isolado da interface; um servidor pode ser somado depois sem reescrever as regras |

O custo dessa escolha é real e está declarado: **os dados ficam por dispositivo
e navegador**. É por isso que o backup existe e é levado a sério.

### Stack

| Camada | Escolha | Motivo |
|---|---|---|
| Interface | React 19 + TypeScript | Tipagem forte no domínio financeiro pega erro antes de virar número errado |
| Estilo | Tailwind CSS 4 | Sem CSS morto e sem biblioteca de componentes pesada |
| Banco | IndexedDB via Dexie | Banco real no navegador: transacional, com índices |
| Build | Vite 7 | Build rápido, saída estática |
| Testes | Vitest | Roda o motor financeiro em milissegundos |
| Gráficos | SVG escrito à mão | Controle total de cor e tema, sem dependência de biblioteca de gráficos |
| XLSX | `fflate` + XML | Lê planilha sem trazer uma biblioteca grande para dentro de um app financeiro |

Dependências de execução: **quatro** (`react`, `react-dom`, `dexie`, `fflate`).
Menos dependência é menos risco de cadeia de suprimentos.

### Modelo de dados

Existe **uma única base de lançamentos**. Visão semanal, mensal, por cartão, por
categoria e por conta são todas *derivadas* dela — nenhuma tabela paralela,
nenhum total guardado que possa divergir.

```
Conta ──┐
Cartão ─┼──► Lançamento ◄── Categoria (com subcategorias)
        │        │
        │        ├── parcelas (mesmo grupo)
        │        └── vínculo de reembolso/estorno
        │
Orçamento ── Categoria        Fatura = derivada das compras + ciclo do cartão
Regra de categorização        Semana/Mês = recortes por data
Conta fixa (projeção)
```

Cada lançamento é de um destes tipos, e cada tipo tem efeito definido e testado:

| Tipo | Mexe no saldo | Mexe no limite do cartão | É despesa/receita |
|---|---|---|---|
| Despesa (conta) | sim, reduz | — | despesa |
| Despesa (cartão) | **não** | consome | despesa |
| Receita | sim, aumenta | — | receita |
| Transferência | sai de uma, entra na outra | — | **não** |
| Pagamento de fatura | sim, reduz | libera | **não** |
| Reembolso / Estorno | sim, aumenta | devolve | **reduz** a despesa |
| Ajuste | sim, corrige | — | **não** |

---

## Instalação

Requisitos: [Node.js](https://nodejs.org) 20 ou superior.

```bash
git clone https://github.com/rafaelaschumacher/planilha.git
cd planilha
npm install
npm run dev
```

Abra o endereço que aparecer no terminal (normalmente `http://localhost:5173`).

Nas **Configurações → Backup e dados** há um botão para carregar seis meses de
dados fictícios, se você quiser conhecer a plataforma antes de colocar seus
números.

### Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | Roda em modo desenvolvimento |
| `npm run build` | Gera o site estático em `dist/` |
| `npm run preview` | Serve o build para conferência |
| `npm test` | Roda todos os testes das regras financeiras |
| `npm run test:watch` | Testes em modo contínuo |

---

## Publicar no GitHub Pages

Já existe uma automação em `.github/workflows/deploy.yml`. Ela roda os testes a
cada envio e, **só se todos passarem**, publica o site — a partir da branch
padrão do repositório, qualquer que seja o nome dela.

**São dois passos, uma única vez, e ambos só você pode dar:**

1. **Repositório público** — *Settings → General → Danger Zone → Change
   repository visibility*. No plano gratuito o GitHub só publica Pages de
   repositório público. (Alternativa: GitHub Pro, ~US$ 4/mês, e manter privado.)
2. **Ligar o Pages** — *Settings → Pages → Build and deployment → Source* →
   escolher **GitHub Actions**.

O passo 2 não dá para automatizar: o token do Actions tem permissão de escrever
no Pages, mas não de criar o site — isso exige direitos de admin.

Feito isso, o próximo envio publica em
`https://rafaelaschumacher.github.io/planilha/`. Antes disso, os testes e o
build rodam normalmente e só a etapa de publicação falha, com a mensagem
*"Ensure GitHub Pages has been enabled"*.

> **Tornar o código público expõe algo?** Não. A aplicação é 100% client-side: o
> repositório contém **apenas código**, e seus dados financeiros vivem no banco
> do seu navegador. É o mesmo risco de publicar uma calculadora.

Enquanto o Pages não estiver ligado, dá para rodar localmente com `npm run dev`
— tudo funciona igual.

---

## Como usar todo mês

Leva poucos minutos.

```
1. Importar o extrato da conta          → Importar
2. Na prévia, marcar as transferências  → trocar o tipo e escolher a outra conta
3. Importar a fatura do cartão          → Importar
4. Revisar as categorias pendentes      → Lançamentos › "Revisar categoria"
5. Conferir as duplicidades apontadas   → Diagnóstico
6. Exportar o backup                    → Ajustes › Backup
```

### Um mês só fecha depois que a fatura do mês seguinte chega

Compras feitas **após o dia de fechamento** do cartão não entram na fatura
daquele mês — entram na próxima. Isso significa que o total de um mês continua
crescendo até você importar a fatura seguinte.

Está financeiramente correto (é o regime de competência), e a plataforma avisa:
o dashboard e a visão mensal mostram um aviso dizendo exatamente qual pedaço do
mês ainda não tem fatura. O aviso desaparece quando ela é importada.

O dashboard, os totais do mês, a visão semanal e os compromissos futuros se
atualizam sozinhos — não existe nada para recalcular à mão.

Durante o mês, para lançar algo na hora: tecle **N** e preencha data,
descrição, valor e forma de pagamento. Mês, semana, tipo, categoria, conta,
cartão, parcela e fatura são inferidos.

**Atalhos:** `N` adiciona lançamento · `P` liga o modo privacidade (esconde os
valores na tela).

---

## Importação de dados

Formatos aceitos: **OFX**, **CSV** e **XLSX**.

Prefira **OFX** quando o banco oferecer: ele traz um identificador único por
transação (FITID), o que elimina a dúvida sobre duplicidade.

O fluxo é sempre o mesmo, e **nada entra na base sem a sua confirmação**:

```
arquivo → lê → normaliza → identifica → categoriza → procura duplicidades
        → PRÉVIA → você confirma → importa
```

Na prévia você vê, linha a linha, o que foi entendido: tipo, categoria
sugerida, parcela reconhecida e avisos. Dá para desmarcar qualquer linha e
corrigir a categoria antes de importar. Toda importação pode ser **desfeita**
depois.

### Você pode trocar o TIPO de cada linha, não só a categoria

Um extrato não sabe a diferença entre um gasto e um dinheiro que você moveu de
uma conta sua para outra. Por isso a prévia deixa você trocar o tipo de cada
linha:

| Situação no extrato | Palpite do sistema | Você troca para | Por que importa |
|---|---|---|---|
| Aporte na reserva | Despesa | **Transferência** | Sem isso, mover dinheiro entre suas contas contaria como gasto |
| Rateio de conta recebido | Receita | **Reembolso** | Reembolso REDUZ a despesa da categoria em vez de inflar a receita |
| Débito da fatura do cartão | Pagamento de fatura | — | Já vem certo se você escolher o cartão |

Ao escolher "Transferência", aparece um segundo campo para a outra conta. A
linha fica **bloqueada** até você preencher — ela não tem como virar um
lançamento válido sem isso.

### Três cuidados que evitam contar o mesmo dinheiro duas vezes

1. **Na fatura do cartão**, a linha "pagamento recebido" já vem **desmarcada** —
   ela costuma estar também no extrato da conta.
2. **No extrato da conta**, uma saída que parece pagamento de fatura vem
   **bloqueada** até você escolher o cartão. Como despesa comum ela duplicaria
   todas as compras daquele cartão.
3. **Se você importar os extratos das duas contas**, a transferência aparece nos
   dois — como saída num e entrada no outro. Depois de reclassificada, o par de
   contas identifica o movimento e a segunda é reconhecida como duplicidade.

### Detecção de duplicidade

Funciona em dois níveis:

- **Linha a linha**: compara valor, data, descrição, conta/cartão e
  identificador do banco. Valores diferentes nunca são considerados
  duplicidade.
- **Em lote**: se a maior parte das linhas já existe, avisa que o arquivo
  inteiro provavelmente já foi importado.

Nada é apagado automaticamente, nunca. O sistema levanta a mão e você decide.

### Se o CSV do seu banco não for reconhecido

O leitor descobre sozinho o separador, o cabeçalho (mesmo com cabeçalho do
banco antes da tabela), colunas separadas de débito e crédito, e até deduz as
colunas quando não há cabeçalho. Se ainda assim não funcionar, a prévia mostra
exatamente qual linha não foi entendida e por quê — nenhuma linha é descartada
em silêncio.

---

## Backup — leia isto

Seus dados vivem no banco do **seu navegador, neste dispositivo**. Isso é
ótimo para privacidade, mas significa que:

> Limpar os dados do site, trocar de navegador ou de computador **leva os dados
> embora**.

**Exporte um backup todo mês.** Ajustes → Backup e dados.

O backup criptografado usa **AES-256-GCM** com chave derivada da sua senha por
**PBKDF2-SHA256** (310 mil iterações, a recomendação da OWASP). Pode ser
guardado no Drive, no e-mail ou num pendrive sem expor nada.

> A senha **não é guardada em lugar nenhum**. Se você perdê-la, o backup é
> irrecuperável — nem por mim, nem por ninguém. É exatamente esse o objetivo.

Há também exportação sem criptografia, para quando você quiser abrir e
inspecionar os dados. Esse arquivo é legível por qualquer um que o tenha.

---

## Segurança e privacidade

| | |
|---|---|
| Dados enviados para servidor | **Nenhum.** Não existe servidor no projeto |
| Rastreamento, analytics, telemetria | Nenhum |
| Credencial ou senha bancária armazenada | **Nunca.** A aplicação não se conecta a banco nenhum |
| Chaves ou segredos no repositório | Nenhum. Não há o que guardar |
| Criptografia do backup | AES-256-GCM, chave derivada por PBKDF2-SHA256 |
| Onde a criptografia roda | No seu navegador, com a WebCrypto nativa |

**Nunca coloque dados financeiros reais neste repositório.** O `.gitignore` já
bloqueia `*.ofx`, `backup-financas-*` e as pastas `/dados` e `/extratos`. Para
testar, use os dados fictícios das Configurações.

---

## Variáveis de ambiente

A aplicação **não usa credenciais**. Existe uma única variável, e é só de build:

| Variável | Para quê | Padrão |
|---|---|---|
| `VITE_BASE_PATH` | Caminho base quando o site é servido em subpasta (GitHub Pages) | `/` |

A automação do GitHub Actions já preenche isso sozinha. Localmente não precisa
de nada. O arquivo `.env.example` está no repositório como referência.

---

## Testes

```bash
npm test
```

265 testes cobrindo as regras financeiras. Os principais:

| Arquivo | O que garante |
|---|---|
| `regra-cartao.test.ts` | **Compra no cartão + pagamento da fatura = UMA única despesa** |
| `lancamentos.test.ts` | Efeito de cada tipo, validação estrutural, parcelamento, saldos |
| `faturas.test.ts` | Ciclo de fechamento e vencimento, alocação de pagamentos, limite |
| `orcamento-futuro.test.ts` | Orçamento com subcategorias, compromissos sem dupla contagem |
| `casos-limite.test.ts` | Fronteiras de fatura, fevereiro, virada de ano, valores extremos |
| `importacao.test.ts` | CSV/OFX de vários bancos, duplicidade, linhas de pagamento |
| `auditoria.test.ts` | Coerência entre dashboard, semana, mês, faturas e saldos |
| `backup.test.ts` | Criptografia, senha errada, arquivo adulterado |
| `fluxo-mensal.test.ts` | **O fluxo mensal inteiro, de ponta a ponta** (abaixo) |

### O teste do fluxo mensal

`fluxo-mensal.test.ts` faz o caminho de volta: pega os dados fictícios, **gera
os arquivos que um banco realmente exportaria** para eles (CSV brasileiro, OFX
com FITID, fatura com sufixo de parcela) e importa num banco vazio pelo pipeline
de verdade — passando pelo IndexedDB, não só pelas funções puras. Depois compara
o resultado com o original, mês a mês.

Ele garante o que a plataforma existe para fazer:

- importar um mês novo **não altera, não remove e não duplica** nenhum
  lançamento anterior — verificado assinatura por assinatura;
- reimportar o mesmo arquivo (CSV ou OFX) **não grava nada**;
- assinatura mensal de valor igual **não** virá falso positivo de duplicidade;
- as parcelas de uma compra, chegando em faturas de meses diferentes, formam
  **um único parcelamento** — e duas compras diferentes na mesma loja não são
  fundidas;
- desfazer uma importação **volta exatamente** ao estado anterior;
- e, com as duas reclassificações que só você pode decidir (transferência e
  reembolso), o resultado importado reproduz **exatamente** receita, despesa e
  saldo dos dados originais.

Alguns testes verificam propriedades, não só exemplos: a divisão em parcelas é
conferida em **4.800 combinações** de valor e número de parcelas, e cada compra
de um **ano inteiro de datas** é conferida contra **cinco configurações de
cartão** para garantir que cai em exatamente uma fatura.

### Auditoria financeira

Além dos testes, a tela **Diagnóstico** roda a mesma auditoria contra os *seus*
dados. Ela procura:

despesa duplicada · receita duplicada · fatura paga duas vezes · transferência
classificada como despesa · pagamento de fatura lançado como despesa · parcelas
que não somam o total · parcela faltando · saldo que não bate com os
lançamentos · valor que não é centavo inteiro · data impossível ou muito
distante · lançamento apontando para conta, cartão ou categoria inexistente ·
lançamento anterior à abertura da conta · orçamento duplicado

E mostra também **o que passou** — saber o que foi conferido importa tanto
quanto saber o que falhou.

---

## Estrutura do repositório

```
src/
├── domain/          Regras financeiras. Funções puras, sem interface e sem banco.
│   ├── money.ts         Centavos inteiros, divisão de parcelas
│   ├── dates.ts         Datas civis, sem fuso horário
│   ├── types.ts         Modelo de dados
│   ├── transaction.ts   Validação e efeito de cada tipo  ← a regra crítica
│   ├── invoice.ts       Ciclo da fatura do cartão
│   ├── engine.ts        Saldos e resumos por período
│   ├── budget.ts        Orçamento
│   ├── commitments.ts   Compromissos futuros e disponível
│   ├── categorize.ts    Categorização automática
│   ├── duplicates.ts    Detecção de duplicidade
│   ├── alerts.ts        Alertas
│   ├── audit.ts         Auditoria financeira
│   └── seed.ts          Categorias e regras iniciais
├── import/          Leitura de CSV, OFX e XLSX + assistente de importação
├── db/              IndexedDB, backup criptografado, dados fictícios
├── state/           Estado da aplicação
├── ui/              Telas e componentes
└── styles/          Sistema visual
tests/               224 testes das regras financeiras
.github/workflows/   Testes e publicação automática
```

A separação importa: **`src/domain/` não sabe que existe interface nem banco de
dados.** É por isso que as regras podem ser testadas em milissegundos e que
trocar a interface no futuro não colocaria nenhum número em risco.

---

## Manutenção

**Atualizar dependências**

```bash
npm outdated
npm update
npm test          # os testes precisam passar antes de qualquer coisa
npm run build
```

**Adicionar uma regra de categorização** — Ajustes → Regras automáticas. Ou
simplesmente corrija a categoria de um lançamento: a plataforma aprende com o
histórico e passa a sugerir sozinha nas próximas vezes.

**Mudar o ciclo do cartão** — Cartões → Editar. As faturas são recalculadas na
hora, porque nunca foram gravadas.

**O saldo não bate com o banco** — Vá em Diagnóstico. Normalmente é lançamento
faltando, duplicado, ou uma transferência classificada como despesa. O saldo
inicial da conta e a data dele também valem conferir: lançamentos anteriores a
essa data são ignorados de propósito, para não somar duas vezes.

**Mexer nas regras financeiras** — Comece pelos testes. Toda regra em
`src/domain/` tem teste correspondente em `tests/`. Se um teste falhar depois
de uma mudança, é ele que está certo até prova em contrário.

---

## Integração direta com bancos (Open Finance)

**Ainda não implementada, e por um motivo concreto.**

No Brasil, ler dados bancários por Open Finance exige ser instituição
autorizada pelo Banco Central ou contratar um agregador licenciado (Pluggy,
Belvo, Klavi e similares). Na prática isso significa:

| O que seria necessário | Situação |
|---|---|
| Contrato com um agregador licenciado | Serviço B2B pago, com mensalidade |
| Um servidor para guardar as credenciais da API | O projeto deixaria de ser sem servidor |
| Seus dados passando por terceiros | Hoje eles não saem do seu dispositivo |
| Consentimento renovado periodicamente no app do banco | Manutenção recorrente |

Ou seja: adotar Open Finance custaria dinheiro, exigiria um servidor e faria
seus dados financeiros trafegarem por uma empresa intermediária — desfazendo as
três melhores propriedades da arquitetura atual.

A importação de OFX cobre quase o mesmo terreno: praticamente todo banco
brasileiro exporta OFX, o arquivo traz identificador único por transação, e a
importação leva menos de um minuto por mês.

Se um dia isso mudar, o caminho já está preparado: o pipeline de importação é
uma sequência de etapas independentes (ler → normalizar → categorizar →
deduplicar → confirmar). Uma integração via API entraria apenas na primeira
etapa, sem tocar em nenhuma regra financeira.

**Antes de qualquer integração com dados reais, isso será discutido: quais
permissões, quais dados, por onde trafegam e por quanto tempo.**
