#!/usr/bin/env python3
"""Read-only R34 live incident inventory. Root for /proc/env/logs only.
No HTTP/model calls, DDL, cache sync, sessions, config changes, or raw secrets output.
Run through audited SHA in the server terminal. Output can be shared with lead.
"""
import os,json,re,subprocess,hashlib,datetime,shlex,sys
from pathlib import Path
assert os.geteuid()==0,'ROOT_REQUIRED'
target_user=sys.argv[1] if len(sys.argv)==2 else ''
assert not target_user or re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',target_user,re.I),'TARGET_USER_UUID_REQUIRED'
def call(argv,**kw):return subprocess.run(argv,capture_output=True,text=True,timeout=kw.pop('timeout',20),**kw)
props=dict(x.split('=',1) for x in call(['systemctl','show','northstar-shell','--property=ActiveState,MainPID,NRestarts,WorkingDirectory,User,MemoryMax,TasksMax,LimitNOFILE,CPUQuotaPerSecUSec','--no-pager']).stdout.splitlines())
pid=int(props['MainPID']);shell=Path(props['WorkingDirectory']);assert str(shell).startswith('/opt/northstar/releases/') and shell.name=='shell'
env={x.split(b'=',1)[0].decode():x.split(b'=',1)[1].decode(errors='replace') for x in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in x}
runtime=Path(env.get('PT_RUNTIME_DIR',str(shell.parent/'runtime')))
keys=['TRUST_PROXY','PT_AUTO08_ROUTE_CONFIG_FILE','PT_RUNS_PER_USER','PT_RUNS_GLOBAL','PT_RATE_CHAT_PER_MIN','PT_RATE_LOGIN_PER_MIN','PT_RATE_REGISTER_PER_MIN','PT_RATE_FORGOT_PER_MIN','PT_RATE_CHANGE_PW_PER_MIN','PT_BF_MAX_FAILURES','PT_BF_WINDOW_MS','PT_BF_LOCK_MS','PT_PG_POOL_MAX','PT_PG_CONNECT_TIMEOUT_MS','PT_SESSION_TTL_MS','PT_DSH_UID','PT_DSH_GID','PT_MEDIA_GENERATION','PT_CONTROLLED_MEDIA_AUTHORIZATION','PT_DOC_UPLOAD_MB','PT_DOC_CONTEXT_CHARS','PT_MEDIA_UPLOAD_MB','PT_UPLOAD_QUOTA_MB','PT_HEARTBEAT_ENABLED','PT_HEARTBEAT_INTERVAL_MS','PT_LISTEN_HOST','PT_CHAT_DRYRUN']
out={'scope':'R34_LIVE_READONLY_AUDIT','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'service':props,'processEnvironment':{k:{'set':k in env,'value':env.get(k)} for k in keys},'readOnly':True,'paidCalls':0,'targetUserId':target_user or None}
selected=['server.cjs','auth-routes.cjs','auth-google-routes.cjs','ratelimit.cjs','models/task-router.cjs','models/auto-route-policy.cjs','models/capabilities.cjs','models/catalog-cache.cjs','model-catalog.cjs','runtime/session-scheduler.cjs','runtime/dsh-adapter.cjs','db-pg.cjs','tasks/store.cjs','tasks/budget.cjs','tenant.cjs','auth-google.cjs','member-routes.cjs','runtime/native-image-message.mjs','runtime/native-analysis-provider.mjs','runtime/offline-analysis.mjs','isolation/offline-analysis.c','tasks/analysis-workspace.cjs','tasks/document-export-handler.cjs','exports/conversation-docx.cjs','attachments/office-document-parser.cjs','attachments/pdf-text-parser.cjs','attachments/office-zip-guard.cjs','attachments/document-bundle-worker.cjs','attachments/document-bundle.cjs','attachments/csv-parser.cjs','media/local-content-runtime.cjs','memory/provenance-store.cjs']
out['sourceSha256']={n:hashlib.sha256((shell/n).read_bytes()).hexdigest() for n in selected}
out['sourceSha256'].update({str(p.relative_to(shell)):hashlib.sha256(p.read_bytes()).hexdigest() for p in (shell/'runtime').glob('run-budget*.json')})
out['liveBudgetProfiles']={p.name:json.loads(p.read_text()) for p in (runtime/'dsh-home/profiles/run-persistent').glob('run-budget*.json')}
ng=call(['nginx','-T']);txt=ng.stdout;vhosts=[];active=[];depth=0
for line in txt.splitlines():
 if not active and re.match(r'\s*server\s*\{',line):active=[line];depth=line.count('{')-line.count('}');continue
 if active:
  active.append(line);depth+=line.count('{')-line.count('}')
  if depth<=0:
   if any('agent-fat.adorado.top' in x for x in active):vhosts.append(active)
   active=[]
allowed=re.compile(r'^\s*(?:server_name|listen|location|proxy_pass|proxy_set_header\s+(?:X-Real-IP|X-Forwarded-For|Host)|client_max_body_size|proxy_read_timeout|proxy_send_timeout|limit_req|limit_conn|access_log|error_log)\b')
out['nginx']={'configurationReadable':ng.returncode==0,'allLimitDirectivesForInheritance':[x.strip() for x in txt.splitlines() if re.match(r'\s*(?:client_max_body_size|client_body_timeout|proxy_read_timeout|proxy_send_timeout|limit_req_zone|limit_conn_zone|worker_connections)\b',x)],'targetVhosts':[[x.strip() for x in b if allowed.search(x)] for b in vhosts]}
# Collect only status/time/path metadata, stripping all query strings and addresses.
accessFiles=set(['/var/log/nginx/access.log'])
for block in vhosts:
 for line in block:
  m=re.match(r'\s*access_log\s+(/[^;\s]+)',line)
  if m:accessFiles.add(m.group(1))
access=[]
for filename in sorted(accessFiles):
 p=Path(filename)
 if not p.is_file():continue
 with p.open('rb') as f:
  f.seek(max(0,p.stat().st_size-8*1024*1024));lines=f.read().decode(errors='replace').splitlines()[-20000:]
 for line in lines:
  m=re.search(r'\[([^\]]+)\]\s+"([A-Z]+)\s+([^\s]+)\s+HTTP/[^" ]+"\s+(\d{3})',line)
  if not m:continue
  when,method,path,status=m.groups();path=path.split('?',1)[0]
  if path.startswith(('/api/chat','/api/auth/google','/api/login','/api/auth/login','/api/models')) and int(status)>=400:access.append({'time':when,'method':method,'path':path,'status':int(status)})
out['nginx']['recentErrorRequests']=access[-150:]
# Bounded selected journal metadata; never dump request bodies, environment or messages.
journal=call(['journalctl','-u','northstar-shell','--since','48 hours ago','-n','15000','-o','cat','--no-pager'],timeout=30)
logfiles=[]
logdirs={Path(env.get('PT_LOG_DIR',str(shell.parent/'logs'))),Path('/opt/northstar/releases/controlled-trial-20261106-candidate-34-r33-questions-m1-draft/logs')}
for logdir in logdirs:
 if logdir.is_dir():logfiles.extend(sorted(logdir.glob('app-*.log'))[-3:])
logfiles=sorted(set(p.resolve() for p in logfiles))
rows=[];ipGroups={}
def tail(p):
 with p.open('rb') as f:
  f.seek(max(0,p.stat().st_size-4*1024*1024));return f.read().decode(errors='replace')
for blob in [journal.stdout]+[tail(p) for p in logfiles if p.is_file()]:
 for line in blob.splitlines():
  try:r=json.loads(line)
  except Exception:continue
  if not isinstance(r,dict):continue
  row={k:r[k] for k in ['ts','level','event','status','statusCode','method','path','runId','code','errorCode','failureStage','trustProxy','rateChatPerMin','googleAuthConfigured','stage','modelCount','upstreamStatus'] if k in r and isinstance(r[k],(str,int,float,bool,type(None)))}
  if isinstance(r.get('ip'),str):
   if r['ip'] not in ipGroups:ipGroups[r['ip']]='IP'+str(len(ipGroups)+1)
   row['ipGroup']=ipGroups[r['ip']]
  if row.get('level') in ('error','warn') or row.get('event') in ('listening','init') or (row.get('event')=='request' and isinstance(row.get('status'),int) and row['status']>=400):rows.append(row)
out['logs']={'journalRead':journal.returncode==0,'appLogFileCount':len(logfiles),'selectedMetadata':rows[-200:],'rawMessagesNotExported':True}
# SQL and credentials remain in this short-lived server process only. Node opens a
# READ ONLY transaction and only reads cache; it never calls getCatalog/sync/write.
node=r'''
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=process.argv[2],runtime=process.env.PT_RUNTIME_DIR||path.join(root,'../runtime');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),safeCode=x=>typeof x==='string'&&/^[A-Z][A-Z0-9_]{0,80}$/.test(x)?x:null;
(async()=>{
 const {openPg}=require(path.join(root,'db-pg.cjs'));const connection=await openPg();
 try{const result=await connection.db.transaction(async db=>{
 await db.query('SET TRANSACTION READ ONLY');await db.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'");
 const identity=(await db.query('SELECT current_database() AS database,current_user AS role')).rows[0];const maxConnections=(await db.query('SHOW max_connections')).rows;
 const users=(await db.query('SELECT id,tenant_id,username,created_at FROM users ORDER BY created_at,id LIMIT 100')).rows;
 const label=new Map(users.map((u,i)=>[u.id,'U'+String(i+1).padStart(2,'0')]));
 const keyRows=(await db.query('SELECT user_id,iv,ciphertext,updated_at FROM api_keys')).rows;
 const groups=new Map(),salt=crypto.randomBytes(32);let master;
 try{const m=JSON.parse(fs.readFileSync(process.env.PT_MASTER_KEY_FILE||path.join(root,'../secrets/master.key'),'utf8'));if(m.scheme==='raw-0600')master=Buffer.from(m.key,'base64');}catch{}
 const catalog=require(path.join(root,'model-catalog.cjs')),cache=require(path.join(root,'models/catalog-cache.cjs'));
 const configured=require(path.join(root,'models/dsh-configured-catalog.cjs'));
 const ids=configured.configuredModels({settings:path.join(runtime,'dsh-home/settings.yaml'),template:path.join(root,'dsh-settings.yaml')});
 const policy=require(path.join(root,'models/auto-route-policy.cjs')).readAutoRoutePolicy(process.env.PT_AUTO08_ROUTE_CONFIG_FILE);
 const router=require(path.join(root,'models/task-router.cjs'));
 const reports=[];
 for(const u of users){const k=keyRows.find(k=>k.user_id===u.id);const row={user:label.get(u.id),userId:u.id,tenantId:u.tenant_id,accountHint:u.username.slice(0,2)+'…'+u.username.slice(-1),createdAt:u.created_at,keyPresent:!!k};
 if(k&&master){let plain;try{const all=Buffer.from(k.ciphertext,'base64'),d=crypto.createDecipheriv('aes-256-gcm',master,Buffer.from(k.iv,'base64'));d.setAuthTag(all.subarray(-16));plain=Buffer.concat([d.update(all.subarray(0,-16)),d.final()]);const fingerprint=crypto.createHmac('sha256',salt).update(plain).digest('hex');if(!groups.has(fingerprint))groups.set(fingerprint,'K'+String(groups.size+1).padStart(2,'0'));row.keyGroup=groups.get(fingerprint);row.keyUpdatedAt=k.updated_at;
 const scope=catalog.resolveScopeId({apiKey:plain.toString('utf8'),baseURL:catalog.DEFAULT_BASE_URL,scopeId:u.id});
 const observed=cache.inspectScopedCache(runtime,scope);row.cacheStatus=observed.status;
 if(observed.snapshot){const snapshot=observed.snapshot;const projected=configured.constrainCatalog({...snapshot,models:require(path.join(root,'models/release-media-policy.cjs')).visibleModels(snapshot.models)},ids);const known=!!snapshot.lastSuccessfulAt&&Number.isFinite(Date.parse(snapshot.lastSuccessfulAt));const availability={status:known?'available':'unknown',modelIds:known?projected.models.filter(m=>m.availability==='present').map(m=>m.id):[]};
 row.snapshotLastSuccessfulAt=snapshot.lastSuccessfulAt;row.snapshotAvailability=snapshot.availability??null;
 row.note='Offline replay of stored cache only; no fresh /v1/models query. Not live in-memory catalog or current key permission proof.';
 const input={candidates:projected.models,requirements:{task:'textChat'},selection:{mode:'auto'},availability};
 const routed=require(path.join(root,'models/auto-route-policy.cjs')).routeWithPolicy({...input,policy});
 row.storedScopeRoute={ok:routed.ok,code:routed.code??null,selected:routed.resolvedModelId??null};
 row.eligibleFromStoredFacts=projected.models.filter(m=>router.routeChatTask({...input,candidates:[m]}).ok).map(m=>m.id);
 row.eligibleInConfiguredOrder=policy?.routes?.textChat?policy.routes.textChat.filter(id=>row.eligibleFromStoredFacts.includes(id)):row.eligibleFromStoredFacts;
 const failures={};for(const m of projected.models){const r=router.routeChatTask({...input,candidates:[m]});if(!r.ok){const code=r.detail?.[0]?.code||r.code||'UNKNOWN';failures[code]=(failures[code]||0)+1;}}row.rejectionCounts=failures;
 row.verifiedTextModels=projected.models.filter(m=>m.states?.textChat?.verified===true).map(m=>({id:m.id,scopeId:m.verifications?.textChat?.scopeId,verifiedAt:m.verifications?.textChat?.verifiedAt}));
 }
 }catch{row.keyOrCacheCheck='FAILED_NO_SECRET_OUTPUT';}finally{plain?.fill(0);}}
 reports.push(row);
 }
 master?.fill(0);salt.fill(0);
 const runs=(await db.query(`SELECT r.run_id,r.user_id,r.created_at,r.updated_at,r.state,r.request->'modelSelection'->>'requestedModelId' AS requested_model,
 (SELECT jsonb_agg(jsonb_build_object('type',e.event->>'type','code',e.event->'payload'->>'code','errorCode',e.event->'payload'->>'errorCode','reasonCodes',e.event->'payload'->'reasonCodes','action',e.event->'payload'->>'action','toolName',e.event->'payload'->'step'->>'name','isError',e.event->'payload'->'step'->'isError','budget',CASE WHEN e.event->'payload'->>'kind'='run_budget' THEN e.event->'payload' ELSE NULL END,'modelId',COALESCE(e.event->'payload'->>'modelId',e.event->'payload'->>'resolvedModelId'),'noEligibleMessage',COALESCE((e.event->'payload'->>'error') LIKE '%没有满足当前文字对话资格%',false))) FROM agent_run_events e WHERE e.run_id=r.run_id AND (e.event->>'type' IN ('done','error','state','step','usage'))) AS metadata
 FROM agent_runs r WHERE r.created_at>now()-interval '7 days' AND ($1::uuid IS NULL OR r.user_id=$1::uuid) ORDER BY r.created_at DESC LIMIT 200`,[process.env.PT_AUDIT_TARGET_USER_ID||null])).rows;
 const safeRuns=runs.map(r=>({runId:r.run_id,user:label.get(r.user_id)||'other',createdAt:r.created_at,updatedAt:r.updated_at,state:r.state,requestedModel:r.requested_model,events:(r.metadata||[]).filter(e=>e.code||e.errorCode||e.reasonCodes||e.noEligibleMessage||e.toolName||e.budget||['model_selection','text_chat_runtime_verified','image_understanding_runtime_verified'].includes(e.action)).map(e=>({...e,code:safeCode(e.code),errorCode:safeCode(e.errorCode)}))}));
 const external=(await db.query("SELECT r.run_id,o.operation_id,o.provider,o.status,o.task_id,o.query_attempts,o.last_query->>'outcome' AS query_outcome,o.last_query->>'reason' AS query_reason,o.created_at,o.updated_at FROM run_external_operations o JOIN agent_runs r ON r.run_id=o.run_id WHERE ($1::uuid IS NULL OR r.user_id=$1::uuid) AND r.created_at>now()-interval '7 days' ORDER BY o.created_at DESC LIMIT 100",[process.env.PT_AUDIT_TARGET_USER_ID||null])).rows;
 return {identity,postgresMaxConnections:maxConnections,accounts:reports,externalOperationMetadata:external,keyGroupsAreEphemeral:true,keyMaterialNotExported:true,activeRoutePolicy:policy?{version:policy.version,sha256:policy.sha256,routes:policy.routes}:null,configuredDshModelCount:ids.length,recentRunMetadata:safeRuns};
 });console.log(JSON.stringify(result));}finally{await connection.close();}
})().catch(()=>{console.log(JSON.stringify({diagnosticFailed:true,error:'READONLY_DB_OR_CACHE_DIAGNOSTIC_FAILED'}));process.exitCode=1;});
'''
node_env={k:v for k,v in env.items() if k.startswith('PT_PG_') or k in ['PT_RUNTIME_DIR','PT_MASTER_KEY_FILE','PT_AUTO08_ROUTE_CONFIG_FILE']}
node_env.update({'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/','LANG':'C.UTF-8','PT_PG_POOL_MAX':'1','PT_AUDIT_TARGET_USER_ID':target_user})
r=call(['runuser','-u','northstar','--','/usr/local/bin/node','-',str(shell)],input=node,env=node_env,cwd='/',timeout=60)
try:out['databaseAudit']=json.loads(r.stdout)
except Exception:out['databaseAudit']={'diagnosticFailed':True,'noRawErrorExported':True}
out['databaseAuditExit']=r.returncode
end=call(['systemctl','show','northstar-shell','--property=MainPID','--value']).stdout.strip();out['samePidAtEnd']=end==str(pid)
print(json.dumps(out,ensure_ascii=False,indent=2))
