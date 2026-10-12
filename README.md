# Agente automático v2

Leia README-AGENT.md. Rode database/005_agent.sql após a migração 003 e configure a chave Gemini no servidor. Candidaturas/evidências são processadas automaticamente; permissões financeiras permanecem no contrato e na revisão RAFTT.

# RAFTT Backend — desenvolvimento / devnet

API Node.js para conectar o frontend existente, Supabase e o contrato V2. Login, confirmação de e-mail, recuperação de senha, perfis, cadastro da empresa e uploads continuam usando Supabase Auth/Storage e as políticas existentes. Esta API adiciona verificação de carteira, revisão, vínculo de rodadas e confirmação de operações reais da Solana.

## Instalar

1. No SQL Editor do projeto Supabase de desenvolvimento, execute `database/003_backend.sql` inteiro. É uma migração adicional: exige as tabelas e políticas das migrações anteriores do frontend. Não substitui o SQL inicial.
2. Instale Node.js 22 ou superior. Na pasta extraída:

```bash
cp .env.example .env
npm ci
```

3. Preencha `.env` com a publishable key e a chave `service_role` do mesmo projeto. A chave de servidor fica exclusivamente neste backend. Configure as origens reais do frontend em `ALLOWED_ORIGINS`.

```bash
npm start
```

A API local responde em `http://127.0.0.1:3000/health`. Esse endpoint verifica que o servidor está funcionando; não comprova acesso ao banco, contrato ou IA. Não envie `.env`, tokens, frases de recuperação ou chaves privadas para o GitHub.

## Contas da equipe

Criar usuário no Auth não concede autoridade administrativa. Um operador do banco precisa inserir o UUID da conta da equipe em `platform_staff`, com papel `reviewer` ou `admin`. Não exponha essa operação em cadastro público.

```sql
-- Substitua pelo UUID real do usuário no Supabase Auth.
insert into public.platform_staff (user_id, role)
values ('UUID-DA-CONTA-DA-EQUIPE', 'admin');
```

A conta de equipe também deve verificar, por assinatura, a carteira configurada como autoridade RAFTT no contrato. Ser administrador no banco não dá poder de assinar por essa carteira. A carteira criadora da rodada deve ser diferente da carteira RAFTT.

## Solana

Configuração padrão: devnet, programa `7rxcmdNRE9Ve7ocjAzG1S5LxyPxuSQ5fifhydpRJqt85`. IDL incluído em `idl/raftt.json`. Use mint de teste realmente existente na devnet; os antigos endereços de localnet não migram automaticamente.

O backend prepara transações **sem assinatura**. A carteira do usuário assina no frontend. O registro no banco exige transação finalizada, instrução e contas esperadas, PDA correta e parâmetros reais do contrato. Valores em unidades mínimas são strings, por exemplo `"10000000"` representa 10 tokens com 6 casas decimais.

O fluxo V2 é: candidatura enviada → revisão RAFTT → criação e registro da rodada → parcelas iniciais → abertura assinada pela RAFTT → publicação da empresa → investimento → encerramento no prazo → reembolso se falhar, ou evidências/revisão/autorização/liberação de parcelas se tiver sucesso.

O backend não guarda chaves privadas Solana. A configuração `PlatformConfig` precisa existir na devnet antes da criação de rodadas. O deploy do servidor não inicializa nem atualiza o contrato.

## Conectar ao frontend

O arquivo `frontend/raftt-api.js` é um adaptador para o frontend existente; **não está automaticamente instalado nas telas**. Copie-o para `assets/js/backend/raftt-api.js` e carregue depois dos clientes Supabase e Solana:

```html
<script>
  window.RafttApiConfig = { baseUrl: "http://127.0.0.1:3000" };
</script>
<script src="assets/js/backend/raftt-api.js"></script>
```

Use `RafttApi.request` para os endpoints e `RafttApi.signPrepared` para transações preparadas. `RafttApi.createLinkedRound(provider, params)` verifica a carteira, prepara, solicita assinatura e registra a rodada confirmada no banco. Os eventos das telas de revisão e criação de rodadas ainda precisam chamar essas funções. Veja `API.md`.

## IA

Opcional: configure `OPENAI_API_KEY` e um modelo compatível com Structured Outputs em `OPENAI_MODEL`. Sem configuração, endpoints de análise retornam indisponibilidade; não simulam relatórios. A IA recomenda revisão ou ajustes, nunca aprova nem transfere dinheiro. A equipe decide e a carteira autorizada assina.

Nesta versão a análise utiliza texto declarado e metadados de documentos. Não extrai PDF/PPT, não pesquisa fontes externas e não realiza KYC. Dados da candidatura enviados para análise são transmitidos ao provedor configurado; defina a política de consentimento e privacidade antes de disponibilizar essa função a usuários reais.

## Sincronização e hospedagem

Dockerfile e `railway.json` incluídos. Configure as mesmas variáveis no servidor, porta disponibilizada pelo ambiente e origens HTTPS do frontend. O backend não foi publicado por este pacote.

Opcionalmente configure um agendador externo para `POST /jobs/sync` com `Authorization: Bearer JOB_TOKEN`. Gere um segredo aleatório para esse token. A tarefa atualiza até 50 rodadas por chamada, priorizando as mais antigas, e suas parcelas cadastradas. Posições dos investidores sincronizam sob demanda autenticada; não existe indexador completo nem fila automática de IA.

## Validação e limites

```bash
npm run check
npm test
```

21 testes automatizados cobrem autenticação HTTP, CORS, assinatura Ed25519, dados financeiros u64, prova de transações, derivação de PDAs, revisão, migração SQL em PostgreSQL embarcado, replay, registro atômico de rodada e proteção contra sincronização antiga. Não substituem teste integrado com seu Supabase, carteira, devnet e provedor de IA.

O contrato atual não recebe `expected_evidence_hash` em `approve_milestone`. O backend confere as evidências antes de preparar a autorização, mas uma nova submissão entre a preparação e a confirmação não pode ser bloqueada atomicamente por ele. Antes de uso financeiro real, ajuste o contrato para vincular a aprovação à versão exata das evidências e amplie os testes.

Somente localnet/devnet são suportadas. Não implementa emissão societária, SAFE, votação, taxas ou conformidade regulatória. `instrument` é metadado, não emissão de um título. Limites de requisição são em memória por instância; múltiplas instâncias exigem controle compartilhado. Leituras de rodada e vault são finalizadas, mas feitas em chamadas separadas. A auditoria de dependências identificou 4 avisos moderados transitivos no SDK Solana; atualizar com `--force` troca a versão principal e exige validar compatibilidade.

## Documentação interativa da API
Após `npm ci` e `npm start`, acesse **http://127.0.0.1:3000/docs**.
Especificação OpenAPI: `/openapi.json`. As 32 operações existentes estão documentadas.
Veja [API-INTEGRATIONS.md](API-INTEGRATIONS.md) para autorização Supabase, assinatura de transações e configuração em hospedagem.
