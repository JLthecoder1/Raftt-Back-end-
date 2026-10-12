# Swagger e integrações RAFTT

## Executar
Mantenha seu `.env` atual. Execute `npm ci` e `npm start` na pasta do backend.
Abra http://127.0.0.1:3000/docs. O documento OpenAPI está em `/openapi.json`.
A documentação inclui as 32 operações reais do backend com parâmetros, permissões, respostas e erros. Arquivos do Swagger são servidos localmente, sem CDN.

## Autenticação
Entre na conta pelo frontend. Use o access_token da sessão Supabase no botão **Authorize**, campo **SupabaseBearer**. Cole apenas o token, sem escrever `Bearer`. O Swagger não guarda essa autorização após recarregar.
Nunca use a service role, chave da IA ou chave privada de carteira nesse campo. `/jobs/sync` usa **JobBearer**, com o JOB_TOKEN configurado exclusivamente no servidor; não usa a sessão do usuário.
Os botões Try it out executam operações reais, incluindo gravações no banco. As permissões, limites e regras existentes continuam ativos.

## Transações Solana
Rotas `/prepare` devolvem transações sem assinatura em base64. A carteira do usuário deve assinar e o cliente deve enviar a transação para a Solana. Depois da finalização, registre a assinatura na rota correspondente. O Swagger não substitui a carteira.
IDs das rotas são UUIDs do banco. Valores u64 usam strings de unidades mínimas, nunca números JavaScript com ponto decimal.

## Integrações que não são rotas deste servidor
| Integração | Uso |
| --- | --- |
| Supabase Auth | Cadastro com senha, login, confirmação por email, recuperação, alteração de senha e sessão são chamadas pelo SDK no frontend. |
| Supabase Database | Perfis, empresas, candidaturas, documentos e demais registros são acessados pelo cliente com RLS e pelas operações autorizadas do backend. A submissão utiliza a RPC `submit_company_application`. |
| Supabase Storage | Avatares, logos, capas e documentos nos buckets `profile-avatars`, `company-logos`, `company-covers`, `company-private`; acesso conforme políticas. |
| Solana RPC e carteira | Consultas on-chain e assinatura/envio de transações. |
| Provedor de IA | Chamado pelo servidor para análise; a aprovação e autorização financeira continuam com a RAFTT. |

Esses serviços não são representados como endpoints fictícios de login ou upload no Swagger do backend. A interface usa suas integrações existentes.

## Publicação
O Swagger usa o próprio endereço do servidor, sem fixar localhost no OpenAPI. Em hospedagem, configure `PUBLIC_API_URL=https://seu-backend` no `.env` para permitir Try it out na origem do backend. Preserve `ALLOWED_ORIGINS` com o endereço do frontend. HTTP local nas portas configuradas funciona automaticamente. Não use curingas de CORS.
Não há migração SQL adicional para instalar o Swagger.
