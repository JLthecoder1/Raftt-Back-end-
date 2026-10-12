# API V1

Todos os endpoints `/v1` exigem `Authorization: Bearer <access_token>` da sessão Supabase. O servidor valida essa sessão com Supabase Auth; não aceita UUID de usuário enviado pelo cliente como identidade. POST exige `Content-Type: application/json`. Resposta: `{ "data": ... }`; erro: `{ "error": { "code", "message", "requestId" } }`.

| Endpoint                                   | Finalidade / permissão                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| GET `/health`                              | Funcionamento do servidor, público                                     |
| GET `/v1/me`                               | Usuário autenticado                                                    |
| GET `/v1/wallets`                          | Carteiras verificadas da própria conta                                 |
| POST `/v1/wallets/challenges`              | `{address}`; desafio válido por 5 minutos                              |
| POST `/v1/wallets/verify`                  | `{challengeId,signature}`; assinatura Ed25519 do texto exato em base64 |
| GET `/v1/companies?mine=true`              | Empresas do proprietário; sem parâmetro, empresas publicadas           |
| GET `/v1/companies/:id`                    | Empresa publicada ou acesso privado autorizado                         |
| GET `/v1/companies/:id/applications`       | Histórico privado autorizado                                           |
| POST `/v1/applications/:id/analyze`        | Análise de IA, equipe                                                  |
| POST `/v1/applications/:id/decisions`      | `{decision,reason,reportId?}`; equipe; versão atual                    |
| POST `/v1/rounds/prepare`                  | Preparar criação, proprietário aprovado                                |
| POST `/v1/rounds/register`                 | `{draftId,signature}`; registrar criação finalizada                    |
| GET `/v1/rounds/:id`                       | Cadastro da rodada autorizado                                          |
| POST `/v1/rounds/:id/sync`                 | Atualizar estado real da rodada e parcelas                             |
| POST `/v1/rounds/:id/milestones`           | Preparar/registrar parcela; proprietário                               |
| POST `/v1/rounds/:id/open/prepare`         | `{walletId}`; equipe e carteira RAFTT                                  |
| POST `/v1/companies/:id/publish`           | Equipe; candidatura aprovada e rodada aberta                           |
| POST `/v1/rounds/:id/terms`                | `{termsVersion}`; registrar aceite da versão atual                     |
| POST `/v1/rounds/:id/transactions`         | `{walletId,signature,operation,sequence?}`; conferir operação real     |
| POST `/v1/rounds/:id/positions/sync`       | Posições das próprias carteiras verificadas                            |
| GET `/v1/investments`                      | Posições cadastradas da própria conta                                  |
| POST `/v1/rounds/:id/close/prepare`        | `{walletId}`; encerramento após prazo da rede                          |
| GET `/v1/milestones/:id`                   | Parcela autorizada para leitura                                        |
| POST `/v1/milestones/:id/evidence`         | `{description,documentId?}`; proprietário                              |
| POST `/v1/milestones/:id/evidence/prepare` | `{evidenceId}`; preparar submissão on-chain                            |
| POST `/v1/milestones/:id/analyze`          | IA, equipe                                                             |
| POST `/v1/milestones/:id/decisions`        | `{decision,reason,reportId,evidenceId}`; equipe                        |
| POST `/v1/milestones/:id/approval/prepare` | `{decisionId,walletId}`; carteira RAFTT verificada                     |
| POST `/v1/milestones/:id/release/prepare`  | `{walletId}`; parcela autorizada na ordem correta                      |
| GET `/v1/notifications`                    | Notificações da própria conta                                          |
| POST `/jobs/sync`                          | Tarefa interna com JOB_TOKEN; não usar token de usuário                |

`decision`: `approved`, `rejected` ou `changes_requested`. O registro de uma decisão não assina autorização Solana.

## Criar e vincular rodada

Exemplo de corpo para `/v1/rounds/prepare`. Substitua UUIDs, endereços e prazo pelo ambiente real:

```json
{
  "applicationId": "UUID-DA-CANDIDATURA-APROVADA",
  "walletId": "UUID-DA-CARTEIRA-CRIADORA-VERIFICADA",
  "roundId": "1",
  "minimumUnits": "10000000",
  "capUnits": "50000000",
  "deadline": "2030-01-01T18:00:00Z",
  "mint": "MINT-SPL-DA-DEVNET",
  "recipient": "ENDERECO-PUBLICO-DESTINATARIO",
  "instrument": "equity",
  "terms": { "description": "Condições do teste" }
}
```

`roundId` é opcional: o servidor gera um u64 se não informado. `recipient` é a carteira destinatária, não uma conta de token arbitrária. Todas as quantias u64 precisam ser strings decimais de unidades mínimas. O prazo deve estar a mais de 48 horas.

A resposta inclui `draftId`, `transaction` base64 sem assinatura, `last_valid_block_height`, `planHash` e `planDocument`. Assine com a carteira conectada, envie à devnet e aguarde finalização. Em seguida envie `{draftId,signature}` para `/register`. O frontend deve lidar com expiração do blockhash preparando novamente; não reutilize a transação expirada. Rascunhos do backend expiram em 30 minutos.

## Parcelas e operações

Preparar parcela: POST `/v1/rounds/:id/milestones` com `sequence` inteiro, `title`, `description`, `acceptanceCriteria`, `useOfFunds`, `amountUnits` string. Após assinar e confirmar, envie o mesmo corpo com `signature` para registrar o plano. Índices iniciam em zero. As parcelas iniciais devem somar exatamente o mínimo exigido pelo contrato.

Para abertura, submissão de evidências, aprovação, fechamento e liberação, assine a transação preparada e registre sua assinatura em `/v1/rounds/:id/transactions`, com `operation` correspondente e `sequence` quando aplicável. Investimento, cancelamento, reembolso e falha usam as instruções existentes do frontend V2 e podem ser registrados no mesmo endpoint. Operações aceitas: `invest_round`, `cancel_round`, `refund_round`, `close_round`, `open_round`, `fail_round`, `submit_milestone`, `approve_milestone`, `release_milestone`.

Atualize a interface com `/sync` e `/positions/sync`; não trate dinheiro captado como saldo da carteira. Operações financeiras legadas `Offering` não são indexadas por esta API V2. As rotas de leitura têm limites de 100 itens (20 para histórico de candidaturas); paginação geral ainda não foi implementada.
