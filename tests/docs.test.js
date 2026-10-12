import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import SwaggerParser from '@apidevtools/swagger-parser';
import { openapi } from '../src/openapi.js';
import { createApp } from '../src/app.js';
import { ApiError } from '../src/core.js';
test('OpenAPI specification validates and has unique operations', async () => {
  await SwaggerParser.validate(structuredClone(openapi));
  const operations = Object.values(openapi.paths).flatMap(p => Object.values(p));
  assert.equal(operations.length, 32);
  assert.equal(new Set(operations.map(o => o.operationId)).size, 32);
  assert.deepEqual(openapi.servers.map(s => s.url), ['/']);
  assert.deepEqual(openapi.paths['/jobs/sync'].post.security, [{JobBearer:[]}]);
});
test('local Swagger assets are public while API authentication and CORS remain enforced', async () => {
  const server=createServer(createApp({db:{authenticate:async()=>{throw new ApiError(401,'unauthorized','Entre na sua conta.');}},chain:{},services:{},cfg:{origins:[],documentationOrigins:['http://localhost:3000']}}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port;
  try {
    for(const path of ['/docs','/docs/','/openapi.json','/docs/swagger-ui.css','/docs/swagger-ui-bundle.js','/docs/swagger-initializer.js']) assert.equal((await fetch(url+path)).status,200,path);
    const initializer=await (await fetch(url+'/docs/swagger-initializer.js')).text();
    assert.match(initializer,/persistAuthorization:false/);
    assert.match(initializer,/validatorUrl:null/);
    assert.equal((await fetch(url+'/v1/me')).status,401);
    assert.equal((await fetch(url+'/docs/../../package.json')).status,401);
    assert.equal((await fetch(url+'/v1/rounds/prepare',{method:'POST',headers:{Origin:'http://localhost:3000'}})).status,401);
    assert.equal((await fetch(url+'/openapi.json',{headers:{Origin:'https://evil.example'}})).status,403);
  } finally {await new Promise(r=>server.close(r));}
});
