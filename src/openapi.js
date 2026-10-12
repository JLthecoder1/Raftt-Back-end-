const uuid={type:'string',format:'uuid',example:'11111111-1111-4111-8111-111111111111'};
const address={type:'string',minLength:32,maxLength:44,description:'Endereço público Solana em base58. Use um endereço real da rede configurada.',example:'So11111111111111111111111111111111111111112'};
const units={type:'string',pattern:'^[0-9]+$',maxLength:20,description:'u64 em texto decimal de unidades mínimas do token, até 18446744073709551615. Não enviar number nem valor com casas decimais.',example:'10000000'};
const signature={type:'string',description:'Assinatura base58 de uma transação real e finalizada na rede configurada.'};
const datetime={type:'string',format:'date-time'};
const object=(properties,required=[])=>({type:'object',properties,...(required.length?{required}:{})});
const ref=name=>({$ref:'#/components/schemas/'+name});
const list=name=>({type:'array',items:ref(name)});
const text=(maxLength)=>({type:'string',...(maxLength?{maxLength}:{})});
const decision={type:'string',enum:['approved','rejected','changes_requested']};
const schemas={
 Error:object({error:object({code:text(),message:text(),requestId:{type:'string',format:'uuid'}},['code','message','requestId'])},['error']),
 Health:object({status:{type:'string',enum:['ok']},network:{type:'string',enum:['devnet','localnet']},programId:address,aiConfigured:{type:'boolean'},agentEnabled:{type:'boolean'},aiProvider:{type:'string'}},['status','network','programId','aiConfigured']),
 User:object({id:uuid,email:{type:'string',format:'email'}},['id']),
 Wallet:object({id:uuid,user_id:uuid,address,verified_at:datetime,created_at:datetime}),
 WalletChallengeRequest:object({address},['address']),
 WalletChallenge:object({id:uuid,message:{type:'string',description:'Texto exato a assinar via signMessage da carteira. Expira em cinco minutos.'},expiresAt:datetime},['id','message','expiresAt']),
 WalletVerifyRequest:object({challengeId:uuid,signature:{type:'string',description:'Assinatura Ed25519 do texto do desafio, 64 bytes codificados em base64. Não é assinatura de transação.'}},['challengeId','signature']),
 Company:object({id:uuid,owner_id:uuid,name:text(200),description:text(),sector:text(),website:text(),headquarters:text(),logo_path:text(),cover_path:text(),publication_status:{type:'string',enum:['draft','published','archived']},created_at:datetime,updated_at:datetime}),
 Application:object({id:uuid,company_id:uuid,submitted_by:uuid,version:{type:'integer',minimum:1},payload:{type:'object',description:'Snapshot da candidatura, incluindo IDs de documentos e plano de metas quando enviado.'},status:{type:'string',enum:['submitted','reviewing','approved','rejected']},created_at:datetime}),
 AgentJob:object({id:uuid,kind:{type:'string',enum:['application','milestone']},target_id:uuid,source_id:uuid,status:{type:'string',enum:['queued','processing','completed','failed','superseded']},attempts:{type:'integer',minimum:0,maximum:3},error_code:{type:'string',nullable:true},report_id:{...uuid,nullable:true},created_at:datetime,updated_at:datetime}),
 AIReport:object({id:uuid,company_id:uuid,application_id:{...uuid,nullable:true},milestone_id:{...uuid,nullable:true},model:text(),model_version:text(),input_hash:text(),canonical_input:text(),report:object({recommendation:{type:'string',enum:['review_required','changes_requested','insufficient_evidence']},summary:text(),risks:{type:'array',items:text()},missing_information:{type:'array',items:text()},milestone_assessment:text(),processing:{type:'object',description:'Provedor, versão de prompt, documentos lidos e consumo retornado pela IA.'}}),created_at:datetime}),
 ApplicationDecisionRequest:object({decision,reason:{...text(5000),minLength:1},reportId:uuid},['decision','reason']),
 DecisionResult:object({id:uuid,reviewHash:text(),chainAuthorization:{type:'boolean',description:'Registrar uma decisão não assina a autorização Solana.'}}),
 Round:object({id:uuid,company_id:uuid,network:{type:'string',enum:['devnet','localnet']},program_id:address,chain_address:address,mint:address,decimals:{type:'integer',minimum:0,maximum:18},minimum_units:units,cap_units:units,raised_units:units,released_units:units,deadline:datetime,recipient:address,instrument:{type:'string',enum:['equity','safe','convertible']},terms:{type:'object'},terms_version:{type:'integer'},plan_hash:text(),chain_status:text(),synced_at:datetime}),
 RoundPrepareRequest:object({applicationId:uuid,walletId:uuid,roundId:units,minimumUnits:units,capUnits:units,deadline:{...datetime,description:'Prazo superior a 48 horas a partir do horário atual.'},mint:address,recipient:address,instrument:{type:'string',enum:['equity','safe','convertible']},terms:{type:'object',example:{description:'Condições da rodada de teste'}}},['applicationId','walletId','minimumUnits','capUnits','deadline','mint','recipient','instrument','terms']),
 UnsignedTransaction:object({transaction:{type:'string',format:'byte',description:'Transação Solana base64 SEM assinatura. Deve ser assinada na carteira e enviada pelo cliente.'},blockhash:text(),last_valid_block_height:{type:'integer'},instruction_data:text(),signer:address}),
 PreparedRound:{allOf:[ref('UnsignedTransaction'),object({draftId:uuid,planDocument:text(),planHash:text()})]},
 RoundRegisterRequest:object({draftId:uuid,signature},['draftId','signature']),
 WalletIdRequest:object({walletId:uuid},['walletId']),
 Milestone:object({id:uuid,round_id:uuid,sequence:{type:'integer',minimum:0,maximum:65535},title:text(200),description:text(5000),acceptance_criteria:text(5000),use_of_funds:text(5000),amount_units:units,plan_hash:text(),plan_document:text(),chain_status:{type:'string',enum:['planned','submitted','authorized','paid']}}),
 MilestoneRequest:object({sequence:{type:'integer',minimum:0,maximum:65535},title:{...text(200),minLength:1},description:{...text(5000),minLength:1},acceptanceCriteria:{...text(5000),minLength:1},useOfFunds:{...text(5000),minLength:1},amountUnits:units,signature},['sequence','title','description','acceptanceCriteria','useOfFunds','amountUnits']),
 PreparedMilestone:{allOf:[ref('UnsignedTransaction'),object({planDocument:text(),planHash:text()})]},
 TermsRequest:object({termsVersion:{type:'integer',minimum:1,example:1}},['termsVersion']),
 TermsAcceptance:object({id:uuid,user_id:uuid,round_id:uuid,terms_version:{type:'integer'},terms_hash:text(),created_at:datetime}),
 TransactionRequest:object({walletId:uuid,signature,operation:{type:'string',enum:['invest_round','cancel_round','refund_round','close_round','open_round','fail_round','submit_milestone','approve_milestone','release_milestone']},sequence:{type:'integer',minimum:0,maximum:65535,description:'Obrigatório para submit_milestone, approve_milestone e release_milestone.'}},['walletId','signature','operation']),
 ChainTransaction:object({id:uuid,user_id:uuid,round_id:uuid,signature,operation:text(),status:text(),created_at:datetime}),
 Investment:object({id:uuid,user_id:uuid,round_id:uuid,wallet_id:uuid,position_address:address,principal_units:units,synced_at:datetime}),
 EvidenceRequest:object({description:{...text(20000),minLength:1},documentId:uuid},['description']),
 Evidence:object({id:uuid,milestone_id:uuid,submitted_by:uuid,description:text(),document_id:{...uuid,nullable:true},evidence_hash:text(),canonical_document:text(),created_at:datetime}),
 EvidencePrepareRequest:object({evidenceId:uuid},['evidenceId']),
 MilestoneDecisionRequest:object({decision,reason:{...text(5000),minLength:1},reportId:uuid,evidenceId:uuid},['decision','reason','reportId','evidenceId']),
 MilestoneDecision:object({id:uuid,company_id:uuid,milestone_id:uuid,reviewer_id:uuid,decision,reason:text(),report_id:uuid,review_hash:text(),chainAuthorization:{type:'boolean',enum:[false]}}),
 ApprovalPrepareRequest:object({decisionId:uuid,walletId:uuid},['decisionId','walletId']),
 PreparedReview:{allOf:[ref('UnsignedTransaction'),object({reviewDocument:text(),reviewHash:text()})]},
 Notification:object({id:uuid,user_id:uuid,kind:text(),content:{type:'object'},read_at:{...datetime,nullable:true},created_at:datetime}),
 SyncResult:object({roundId:uuid,state:{type:'object'},slot:{type:'integer'},vault_balance:{type:'string'}}),
 SyncJobResult:object({results:{type:'array',items:object({roundId:uuid,status:{type:'string',enum:['synced','error']},code:text()})}})
};
const errors={400:'Parâmetros, UUID, valores ou JSON inválidos.',401:'Token ausente, inválido ou expirado. Faça login novamente.',403:'Conta sem permissão, carteira incorreta ou origem não autorizada.',404:'Registro ou endpoint não encontrado.',409:'Estado conflitante: versão antiga, parcela já paga, prazo ou condição não atendida.',413:'Corpo acima de 256 KB ou limite de conteúdo para IA. Arquivos usam Supabase Storage.',415:'Content-Type deve ser application/json.',422:'Contas, documentos ou provas incompatíveis.',429:'Limite de requisições atingido. Análise manual: uma por minuto por usuário.',500:'Falha interna.',502:'Falha em serviço externo.',503:'Serviço indisponível ou IA ainda não configurada.'};
const paths={};
function add(method,path,summary,tag,result,{body,description='',security,raw=false}={}){
 const operation={tags:[tag],summary,description,operationId:method+'_'+path.replace(/[^a-zA-Z0-9]+/g,'_'),responses:{200:{description:'Operação concluída.',content:{'application/json':{schema:raw?result:object({data:result},['data'])}}}}};
 for(const [status,label] of Object.entries(errors))operation.responses[status]={description:label,content:{'application/json':{schema:ref('Error')}}};
 const params=[...path.matchAll(/\{([^}]+)\}/g)].map(m=>({name:m[1],in:'path',required:true,schema:uuid,description:'UUID do registro no Supabase; não é endereço público da Solana.'}));
 if(params.length)operation.parameters=params;
 if(body)operation.requestBody={required:true,content:{'application/json':{schema:ref(body)}}};
 if(security)operation.security=security;
 (paths[path]??={})[method]=operation;
}
add('get','/health','Consultar saúde e configuração pública','Servidor',ref('Health'),{security:[],raw:true});
add('get','/v1/me','Consultar usuário autenticado','Conta',ref('User'));
add('get','/v1/wallets','Listar carteiras verificadas da própria conta','Carteiras',list('Wallet'));
add('post','/v1/wallets/challenges','Criar desafio de assinatura','Carteiras',ref('WalletChallenge'),{body:'WalletChallengeRequest',description:'Válido por 5 minutos. Assine message com a carteira. Limite de 10 desafios/minuto por usuário.'});
add('post','/v1/wallets/verify','Verificar prova de controle da carteira','Carteiras',ref('Wallet'),{body:'WalletVerifyRequest'});
add('get','/v1/companies','Listar empresas publicadas ou próprias','Empresas',list('Company'));paths['/v1/companies'].get.parameters=[{name:'mine',in:'query',schema:{type:'boolean',default:false},description:'true lista as empresas do proprietário; sem isso lista empresas publicadas.'}];
add('get','/v1/companies/{id}','Consultar cadastro da empresa','Empresas',ref('Company'),{description:'Empresa publicada ou acesso privado autorizado por proprietário, membro ou equipe.'});
add('get','/v1/companies/{id}/applications','Consultar versões da candidatura','Candidaturas',list('Application'),{description:'Acesso privado autorizado. Até 20 versões, da mais recente para a mais antiga.'});
add('get','/v1/companies/{id}/agent-jobs','Consultar fila e status do agente','Agente',list('AgentJob'),{description:'Acesso privado à empresa. Até 100 tarefas. Não expõe tokens de lease.'});
add('post','/v1/companies/{id}/publish','Publicar empresa','Empresas',{}, {description:'Equipe RAFTT; candidatura atual aprovada e rodada aberta válida na rede configurada.'});
add('post','/v1/applications/{id}/analyze','Analisar candidatura com IA','Agente',ref('AIReport'),{description:'Equipe RAFTT; versão mais recente. Resultado salvo, sem decisão ou transferência automática. Uma análise manual por minuto por usuário (compartilhado com parcelas).'});
add('post','/v1/applications/{id}/decisions','Registrar decisão da candidatura','Candidaturas',ref('DecisionResult'),{body:'ApplicationDecisionRequest',description:'Equipe RAFTT; somente versão atual. changes_requested mantém a candidatura em revisão. Não assina a carteira.'});
add('post','/v1/rounds/prepare','Preparar criação da rodada','Rodadas',ref('PreparedRound'),{body:'RoundPrepareRequest',description:'Proprietário com candidatura aprovada e carteira verificada. Rascunho expira em 30 minutos. roundId u64 opcional; mínimo positivo e cap ≥ mínimo. Assine/envie a transação no cliente antes de registrar.'});
add('post','/v1/rounds/register','Registrar criação finalizada da rodada','Rodadas',{}, {body:'RoundRegisterRequest',description:'Confere programa, instrução, assinante e parâmetros da criação real; registra vínculo com empresa. Assinatura deve estar finalizada.'});
add('get','/v1/rounds/{id}','Consultar cadastro autorizado da rodada','Rodadas',ref('Round'));
add('post','/v1/rounds/{id}/sync','Sincronizar rodada e parcelas com Solana','Rodadas',ref('SyncResult'),{description:'Atualiza o estado real. Até 10 sincronizações/minuto por usuário.'});
add('post','/v1/rounds/{id}/open/prepare','Preparar abertura da captação','Rodadas',ref('PreparedReview'),{body:'WalletIdRequest',description:'Equipe e carteira RAFTT verificada; candidatura aprovada e plano inicial completo somando o mínimo.'});
add('post','/v1/rounds/{id}/milestones','Preparar ou registrar parcela','Parcelas',{oneOf:[ref('PreparedMilestone'),ref('Milestone')]},{body:'MilestoneRequest',description:'Proprietário. Sem signature: retorna transação não assinada. Após assinatura/envio/finalização, envie o mesmo corpo com signature para registrar. sequence inicia em zero.'});
add('post','/v1/rounds/{id}/positions/sync','Sincronizar posições das carteiras da conta','Investimentos',list('Investment'));
add('post','/v1/rounds/{id}/terms','Registrar aceite dos termos atuais','Investimentos',list('TermsAcceptance'),{body:'TermsRequest',description:'Aceita somente a versão atual dos termos.'});
add('post','/v1/rounds/{id}/transactions','Registrar operação finalizada','Transações',ref('ChainTransaction'),{body:'TransactionRequest',description:'Valida programa, instrução, assinante e contas. Registra a assinatura já finalizada. O servidor não solicita chave privada nem assina transferências.'});
add('post','/v1/rounds/{id}/close/prepare','Preparar encerramento pelo prazo','Rodadas',ref('UnsignedTransaction'),{body:'WalletIdRequest',description:'Rodada aberta e prazo alcançado segundo o relógio da Solana. Carteira verificada.'});
add('get','/v1/investments','Listar posições cadastradas da própria conta','Investimentos',list('Investment'));
add('get','/v1/milestones/{id}','Consultar parcela autorizada para leitura','Parcelas',ref('Milestone'));
add('post','/v1/milestones/{id}/evidence','Salvar evidências de uma parcela','Evidências',ref('Evidence'),{body:'EvidenceRequest',description:'Proprietário da empresa. Documento opcional deve pertencer à mesma empresa. O envio cria tarefa automática do agente quando a migração 005 está aplicada.'});
add('post','/v1/milestones/{id}/evidence/prepare','Preparar submissão de evidências na Solana','Evidências',ref('UnsignedTransaction'),{body:'EvidencePrepareRequest',description:'Carteira criadora verificada. Assine/envie no cliente e registre submit_milestone em /transactions.'});
add('post','/v1/milestones/{id}/analyze','Analisar evidências da parcela com IA','Agente',ref('AIReport'),{description:'Equipe RAFTT. Uma análise manual/minuto por usuário, compartilhada com candidaturas. O relatório não é autorização financeira.'});
add('post','/v1/milestones/{id}/decisions','Registrar decisão sobre evidências','Evidências',ref('MilestoneDecision'),{body:'MilestoneDecisionRequest',description:'Equipe RAFTT; evidência correspondente à solicitação on-chain e relatório que analisou essa evidência. Não assina autorização.'});
add('post','/v1/milestones/{id}/approval/prepare','Preparar autorização da parcela','Parcelas',ref('PreparedReview'),{body:'ApprovalPrepareRequest',description:'Equipe com carteira RAFTT verificada; decisão atual aprovada e evidência compatível.'});
add('post','/v1/milestones/{id}/release/prepare','Preparar pagamento autorizado da parcela','Parcelas',ref('UnsignedTransaction'),{body:'WalletIdRequest',description:'Carteira verificada. Rodada bem-sucedida, parcela autorizada e na ordem correta. Destinatário é o fixado no contrato.'});
add('get','/v1/notifications','Listar notificações da própria conta','Conta',list('Notification'),{description:'Até 100 notificações, da mais recente para a mais antiga.'});
add('post','/jobs/sync','Sincronizar até 50 rodadas em tarefa interna','Tarefas internas',ref('SyncJobResult'),{security:[{JobBearer:[]}],raw:true,description:'Exige JOB_TOKEN do servidor, não o token Supabase. Até duas chamadas/minuto. Não use essa credencial no frontend.'});
export const openapi={openapi:'3.0.3',info:{title:'RAFTT API',version:'0.3.0',description:'API existente de empresas, agente e operações Solana de teste. Todos os endpoints /v1 exigem access_token Supabase em Authorize → SupabaseBearer. Não use publishable key, service role nem chave Gemini como token de usuário. Login/cadastro, perfis, candidaturas e uploads usam Supabase diretamente pelo frontend, conforme API-INTEGRATIONS.md; não há /login ou /upload nesta API. Valores u64 são strings. Transações preparadas precisam de assinatura da carteira no cliente. Respostas /v1 usam {data}; /health e /jobs/sync não usam esse envelope. Limites gerais: 120 requisições/minuto por usuário e 300/minuto por IP. Uma chamada de documentação não modifica dados; Try it out executa as operações descritas.'},servers:[{url:'/',description:'Mesmo servidor que hospeda esta documentação'}],tags:['Servidor','Conta','Carteiras','Empresas','Candidaturas','Agente','Rodadas','Parcelas','Evidências','Investimentos','Transações','Tarefas internas'].map(name=>({name})),security:[{SupabaseBearer:[]}],paths,components:{securitySchemes:{SupabaseBearer:{type:'http',scheme:'bearer',bearerFormat:'JWT',description:'access_token da sessão de um usuário autenticado no Supabase. Cole apenas o token; Swagger acrescenta Bearer.'},JobBearer:{type:'http',scheme:'bearer',description:'JOB_TOKEN privado, exclusivo de /jobs/sync. Não é token de usuário.'}},schemas}};
