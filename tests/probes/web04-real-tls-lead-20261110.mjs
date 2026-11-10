import assert from 'node:assert/strict';import https from 'node:https';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {execFileSync} from 'node:child_process';import {gzipSync} from 'node:zlib';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createTrustedHttpTransport}=require('../../shell/candidates/web-20261103/index.cjs');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'web04-tls-'));let server;const sockets=new Set();let dispatched=0,pins=0;
try{
 fs.writeFileSync(path.join(temp,'cert.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=safe.example\n[ext]\nsubjectAltName=DNS:safe.example\n');
 execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',path.join(temp,'cert.cnf'),'-keyout',path.join(temp,'key.pem'),'-out',path.join(temp,'cert.pem')],{stdio:'ignore'});
 const cert=fs.readFileSync(path.join(temp,'cert.pem'));server=https.createServer({key:fs.readFileSync(path.join(temp,'key.pem')),cert},(req,res)=>{
  dispatched++;
  if(req.url==='/redirect'){res.writeHead(302,{Location:'https://127.0.0.1/private'});res.end();return;}
  if(req.url==='/gzip'){const body=gzipSync('A'.repeat(100000));res.writeHead(200,{'Content-Encoding':'gzip','Content-Length':body.length});res.end(body);return;}
  if(req.url==='/slow'){res.writeHead(200,{'Content-Type':'text/plain'});res.write('start');const timer=setInterval(()=>res.write('tail'),10);res.once('close',()=>clearInterval(timer));return;}
  res.writeHead(200,{'Content-Type':'text/plain'});res.end('real TLS body');
 });
 server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const transport=createTrustedHttpTransport({trustedDomains:['safe.example'],dnsLookup:async()=>[{address:'93.184.216.34',family:4}],request:(url,opts,callback)=>https.request(url,{...opts,port:server.address().port,ca:cert,
  // Test-only local wire adapter: assert the production pin, then map that
  // single address to the controlled TLS fixture. No public network is used.
  lookup:(host,options,cb)=>opts.lookup(host,options,(err,address,family)=>{assert.ifError(err);assert.equal(address,'93.184.216.34');pins++;cb(null,'127.0.0.1',4);})},callback)});
 assert.equal((await transport('https://safe.example/ok')).content,'real TLS body');
 const before=dispatched;await assert.rejects(transport('https://safe.example/redirect'),{code:'PRIVATE_IP_REJECTED'});assert.equal(dispatched,before+1);
 await assert.rejects(transport('https://safe.example/gzip',{maxBytes:1000}),{code:'CONTENT_TOO_LARGE'});
 await assert.rejects(transport('https://safe.example/slow',{timeoutMs:40}),{code:'FETCH_TIMEOUT'});
 const abort=new AbortController();const pending=transport('https://safe.example/slow',{signal:abort.signal});setTimeout(()=>abort.abort(),40);await assert.rejects(pending,{code:'RUN_CANCELLED'});
 for(let n=0;n<100&&sockets.size;n++)await new Promise(r=>setTimeout(r,5));assert.equal(sockets.size,0);assert.ok(pins>=5);
 console.log('PASS real TLS verification/body, production-pin assertion with local test mapping, pre-hop private redirect denial, gzip decoded cutoff, deadline/abort and zero live sockets');
}finally{for(const socket of sockets)socket.destroy();if(server)await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});}
