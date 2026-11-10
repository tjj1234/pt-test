import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {launcherPath,grantArgs,probe} from '@deepseek-ai/node-addon-landlock-run';
const fail=code=>Object.assign(new Error('Offline analysis isolation is unavailable'),{code});
export const POLICY_REVISION='r34-readonly-python-1641b251b3dc-v1';
const HELPER_SHA256='1641b251b3dcac6baf18816b3dd2dc57ace858f9bd4c740ffea2af0b30ed0835';
let verifiedLauncher;
export function offlineAnalysisArguments({workspaceRoot,code,runtimeRoot=process.env.PT_ISOLATION_RUNTIME||path.resolve(import.meta.dirname,'../isolation/vendor')}={}){
 if(process.platform!=='linux'||process.arch!=='x64')throw fail('ISOLATION_BACKEND_UNAVAILABLE');
 if(typeof code!=='string'||!code.trim()||Buffer.byteLength(code)>8192||code.includes('\0'))throw fail('ISOLATION_INPUT_INVALID');
 if(typeof workspaceRoot!=='string'||!path.isAbsolute(workspaceRoot))throw fail('ISOLATION_SCOPE_INVALID');
 const root=fs.lstatSync(workspaceRoot);if(!root.isDirectory()||root.isSymbolicLink()||fs.realpathSync(workspaceRoot)!==workspaceRoot)throw fail('ISOLATION_SCOPE_INVALID');
 const helper=path.resolve(runtimeRoot,'offline-analysis'),stat=fs.lstatSync(helper);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024||(stat.mode&0o022)||createHash('sha256').update(fs.readFileSync(helper)).digest('hex')!==HELPER_SHA256)throw fail('ISOLATION_RUNTIME_UNTRUSTED');
 const launcher=launcherPath();if(verifiedLauncher!==launcher){if(probe(launcher)!=='full')throw fail('ISOLATION_BACKEND_UNAVAILABLE');verifiedLauncher=launcher;}
 const roots=[...new Set(['/usr','/lib','/lib64','/bin','/sbin'].filter(file=>fs.existsSync(file)).map(file=>fs.realpathSync(file)))];
 if(fs.existsSync('/etc/ld.so.cache'))roots.push('/etc/ld.so.cache');
 roots.push(helper,workspaceRoot);
 return {argv:[launcher,...grantArgs({readOnly:roots,readWrite:['/dev/null']}),'--',helper,'/usr/bin/python3','-I','-S','-B','-c',code],policyRevision:POLICY_REVISION,timeoutMs:5000,maxOutputBytes:16384};
}
