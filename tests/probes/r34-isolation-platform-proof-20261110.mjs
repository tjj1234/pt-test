import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire('/opt/northstar/releases/controlled-trial-20261106-candidate-34-r33-questions-m1-draft/shell/package.json');
const {launcherPath,grantArgs,probe}=await import(pathToFileURL(require.resolve('@deepseek-ai/node-addon-landlock-run')));
const helper='/tmp/pt-r34-isolation-49a81986-r3/offline-analysis',parent=path.dirname(helper),root=fs.mkdtempSync(path.join(parent,'inputs-')),outside=path.join(parent,'outside-canary');
fs.writeFileSync(path.join(root,'input.csv'),'name,value\none,3\ntwo,4\n',{mode:0o400});fs.writeFileSync(outside,'OWNED_TEST_CANARY',{mode:0o600});
try{
 if(probe()!=='full')throw Error('NATIVE_LANDLOCK_NOT_FULL');
 const ro=[...new Set(['/usr','/lib','/lib64','/bin','/sbin'].filter(p=>fs.existsSync(p)).map(p=>fs.realpathSync(p)))];ro.push('/etc/ld.so.cache',helper,root);
 const argv=[...grantArgs({readOnly:ro,readWrite:['/dev/null']}),'--',helper,'/usr/bin/python3','-I','-S','-B','-c'];
 const execute=(code,options={})=>spawnSync(launcherPath(),[...argv,code],{cwd:root,env:{PATH:'/usr/bin:/bin',R34_PUBLIC_CANARY:'MUST_NOT_INHERIT'},encoding:'utf8',timeout:6000,maxBuffer:32768,...options});
 const code=`import os,socket,json
checks={}
checks['owned_input']=open('input.csv').read().endswith('two,4\\n')
checks['environment']='R34_PUBLIC_CANARY' not in os.environ
def blocked(name,fn):
 try: fn();checks[name]=False
 except (PermissionError,OSError):checks[name]=True
blocked('outside_input',lambda:open(${JSON.stringify(outside)}).read())
blocked('system_secret',lambda:open('/etc/passwd').read())\nblocked('parent_environment',lambda:open('/proc/'+str(os.getppid())+'/environ','rb').read())
blocked('tcp',lambda:socket.socket(socket.AF_INET,socket.SOCK_STREAM))
blocked('udp',lambda:socket.socket(socket.AF_INET,socket.SOCK_DGRAM))
blocked('unix_socket',lambda:socket.socket(socket.AF_UNIX,socket.SOCK_STREAM))
blocked('fork',lambda:os.fork())
blocked('foreign_signal',lambda:os.kill(os.getppid(),0))
blocked('metadata_chmod',lambda:os.chmod(${JSON.stringify(outside)},0))\nblocked('cross_process_rlimit',lambda:__import__('resource').prlimit(os.getppid(),__import__('resource').RLIMIT_NOFILE,(0,0)))\nblocked('write',lambda:open('output.txt','w'))
blocked('hard_link',lambda:os.link('input.csv','hard.csv'))
blocked('soft_link',lambda:os.symlink('/etc/passwd','soft.csv'))
print(json.dumps(checks))
assert all(checks.values())`;
 const result=execute(code);if(result.status!==0)throw Error('ISOLATION_MATRIX_FAILED '+result.status+' '+result.stderr);console.log('R34_NATIVE_ISOLATION_MATRIX '+result.stdout.trim());
 const memory=execute("try:\n x=bytearray(200*1024*1024)\nexcept MemoryError:\n print('MEMORY_BOUND_PASS')".replaceAll('\\n','\n'));if(!memory.stdout.includes('MEMORY_BOUND_PASS'))throw Error('MEMORY_LIMIT_FAILED');console.log('MEMORY_BOUND_PASS');
 const wallStart=Date.now(),wall=execute('import time; time.sleep(30)',{timeout:7000});if(wall.signal!=='SIGKILL'||wall.error||Date.now()-wallStart>6500)throw Error('WALL_LIMIT_FAILED');console.log('INDEPENDENT_WALL_BOUND_PASS');
 const cpu=execute('while True: pass');if(cpu.signal!=='SIGKILL')throw Error('CPU_LIMIT_FAILED');console.log('CPU_BOUND_PASS');
 const cancel=execute('while True: pass',{timeout:150});if(cancel.error?.code!=='ETIMEDOUT')throw Error('CANCEL_LIMIT_FAILED');console.log('BOUNDED_CANCEL_PASS');
 const [{Context},{default:Subprocess}]=await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-subprocess-local'].map(name=>import(pathToFileURL(require.resolve(name)))));
 const ctx=new Context();await ctx.plugin(Subprocess);const native=ctx.get('subprocess');
 const actual=native.spawn({argv:[launcherPath(),...argv,"print('NATIVE_DSH_ISOLATED_OK')"],cwd:root,graceMs:100,stdio:{stdin:'ignore',stdout:{maxBytes:16384},stderr:{maxBytes:16384}}});await actual.done;if(!(await actual.waitForExit())||!actual.collected.stdout.readFrom(0).text.includes('NATIVE_DSH_ISOLATED_OK'))throw Error('NATIVE_DSH_SUBPROCESS_FAILED');console.log('NATIVE_DSH_ISOLATED_PROCESS_PASS');
 const abort=new AbortController(),running=native.spawn({argv:[launcherPath(),...argv,"import os,time; print(os.getpid(),flush=True); time.sleep(30)"],cwd:root,signal:abort.signal,graceMs:100,stdio:{stdin:'ignore',stdout:{maxBytes:16384},stderr:{maxBytes:16384}}});setTimeout(()=>abort.abort(),150);await running.done;if(!(await running.waitForExit()))throw Error('NATIVE_DSH_CANCEL_FAILED');const pid=Number(running.collected.stdout.readFrom(0).text.trim());if(!Number.isSafeInteger(pid)||pid<1)throw Error('NATIVE_DSH_PID_FAILED');let gone=false;try{process.kill(pid,0);}catch(error){gone=error.code==='ESRCH';}if(!gone)throw Error('NATIVE_DSH_PROCESS_SURVIVED');console.log('NATIVE_DSH_CANCEL_AND_JOIN_PASS');
 const ownerCode=`import fs from 'node:fs';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';const require=createRequire(${JSON.stringify('/opt/northstar/releases/controlled-trial-20261106-candidate-34-r33-questions-m1-draft/shell/package.json')});const [{Context},{default:S}]=await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-subprocess-local'].map(name=>import(pathToFileURL(require.resolve(name)))));const ctx=new Context();await ctx.plugin(S);const h=ctx.get('subprocess').spawn({argv:${JSON.stringify([launcherPath(),...argv,"import os,time;print(os.getpid(),flush=True);time.sleep(30)"])},cwd:${JSON.stringify(root)},graceMs:100,stdio:{stdin:'ignore',stdout:{maxBytes:16384},stderr:{maxBytes:16384}}});for(let n=0;n<200;n++){const pid=Number(h.collected.stdout.readFrom(0).text.trim());if(pid>1){fs.writeSync(1,JSON.stringify({supervisor:h.pid,guest:pid})+'\\n');process.kill(process.pid,'SIGKILL');}await new Promise(r=>setTimeout(r,5));}process.exit(90);`;
 const died=spawnSync(process.execPath,['--input-type=module','-e',ownerCode],{encoding:'utf8',timeout:5000,maxBuffer:32768});if(died.signal!=='SIGKILL')throw Error('OWNER_DEATH_FIXTURE_FAILED '+died.stderr);const orphan=JSON.parse(died.stdout.trim());let bothGone=false;for(let n=0;n<100;n++){bothGone=[orphan.supervisor,orphan.guest].every(pid=>!fs.existsSync('/proc/'+pid)||fs.readFileSync('/proc/'+pid+'/stat','utf8').split(' ')[2]==='Z');if(bothGone)break;await new Promise(r=>setTimeout(r,10));}if(!bothGone)throw Error('OWNER_DEATH_LEFT_LIVE_PROCESS');console.log('OWNER_SIGKILL_NO_LIVE_GUEST_PASS');
}finally{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{force:true});}
