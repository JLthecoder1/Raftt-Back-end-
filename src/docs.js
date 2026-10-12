import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import swaggerUi from 'swagger-ui-dist';
import { openapi } from './openapi.js';
const assets = new Map(['swagger-ui.css', 'swagger-ui-bundle.js'].map(name => [name, readFileSync(join(swaggerUi.getAbsoluteFSPath(), name))]));
const initializer = `window.onload = () => SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',deepLinking:true,displayRequestDuration:true,validatorUrl:null,persistAuthorization:false,queryConfigEnabled:false});`;
const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RAFTT · API</title><link rel="stylesheet" href="/docs/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/docs/swagger-ui-bundle.js"></script><script src="/docs/swagger-initializer.js"></script></body></html>`;
export function serveDocumentation(req, res, path) {
  if (req.method !== 'GET') return false;
  let content, type;
  if (path === '/openapi.json') { content = JSON.stringify(openapi); type = 'application/json'; }
  else if (path === '/docs' || path === '/docs/') { content = html; type = 'text/html'; }
  else if (path === '/docs/swagger-initializer.js') { content = initializer; type = 'text/javascript'; }
  else if (path.startsWith('/docs/') && assets.has(path.slice(6))) { const name = path.slice(6); content = assets.get(name); type = name.endsWith('.css') ? 'text/css' : 'text/javascript'; }
  else return false;
  res.setHeader('Content-Type', type + '; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  res.statusCode = 200;
  res.end(content);
  return true;
}
