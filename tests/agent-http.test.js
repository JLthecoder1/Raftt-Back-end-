import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {createApp} from '../src/app.js';import {ApiError} from '../src/core.js';
test('agent status route authorizes company access before selecting jobs and never exposes lease tokens',async()=>{
 const id='11111111-1111-1111-1111-111111111111';let allow=false,read=0,filter;
 const db={authenticate:async()=>({id:'user'}),company:async()=>{if(!allow)throw new ApiError(403,'staff_required','No access')},rest:async(table,p)=>{assert.equal(table,'agent_jobs');read++;filter=p;return []}};
 const server=createServer(createApp({db,chain:{},services:{ai:{configured:()=>true}},cfg:{origins:['http://localhost:8765'],network:'devnet',programId:'program',aiProvider:'gemini',agentEnabled:true}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const url='http://127.0.0.1:'+server.address().port;
 const health=await (await fetch(url+'/health')).json();assert.equal(health.aiConfigured,true);assert.equal(health.agentEnabled,true);assert.equal(health.aiProvider,'gemini');
 assert.equal((await fetch(url+'/v1/companies/'+id+'/agent-jobs',{headers:{Authorization:'Bearer token'}})).status,403);assert.equal(read,0);allow=true;
 assert.equal((await fetch(url+'/v1/companies/'+id+'/agent-jobs',{headers:{Authorization:'Bearer token'}})).status,200);assert.equal(filter.company_id,'eq.'+id);assert(!filter.select.includes('lease'));
 }finally{await new Promise(r=>server.close(r))}
});
