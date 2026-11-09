'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const {routeChatTask}=require('./task-router.cjs');
const fail=code=>Object.assign(Error('AUTO route policy invalid'),{code});
function readAutoRoutePolicy(file){
 if(!file)return null;
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 let body;try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>65536)throw fail('AUTO_POLICY_INVALID');body=fs.readFileSync(fd,'utf8');if(Buffer.byteLength(body)>65536)throw fail('AUTO_POLICY_INVALID');}finally{fs.closeSync(fd);}
 const p=JSON.parse(body);if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).sort().join(',')!=='routes,version'||typeof p.version!=='string'||!p.version.trim()||p.version.length>128||!p.routes||typeof p.routes!=='object'||Array.isArray(p.routes))throw fail('AUTO_POLICY_INVALID');
 for(const [task,list] of Object.entries(p.routes)){if(!['textChat','imageUnderstanding'].includes(task)||!Array.isArray(list)||!list.length||list.length>64||new Set(list).size!==list.length||list.some(id=>typeof id!=='string'||!id.trim()||id.length>256))throw fail('AUTO_POLICY_INVALID');Object.freeze(list);}
 if(!Object.keys(p.routes).length)throw fail('AUTO_POLICY_INVALID');
 return Object.freeze({version:p.version,sha256:crypto.createHash('sha256').update(body).digest('hex'),routes:Object.freeze(p.routes)});
}
function routeWithPolicy({policy,candidates,requirements,selection,availability}){
 if(!policy||selection.mode==='manual')return routeChatTask({candidates,requirements,selection,availability});
 const ids=policy.routes[requirements.task];if(!ids)return {ok:false,code:'AUTO_TASK_NOT_CONFIGURED'};
 if(!Array.isArray(candidates))return {ok:false,code:'CANDIDATES_INVALID'};
 // Validate the full catalog first: filtering must not hide duplicate identities.
 const allIds=candidates.filter(x=>typeof x?.id==='string').map(x=>x.id);if(new Set(allIds).size!==allIds.length)return {ok:false,code:'CANDIDATE_ID_AMBIGUOUS'};
 const ordered=ids.flatMap(id=>candidates.filter(c=>c.id===id));
 const result=routeChatTask({candidates:ordered,requirements,selection,availability});
 return {...result,routePolicy:{version:policy.version,sha256:policy.sha256}};
}
module.exports={readAutoRoutePolicy,routeWithPolicy};
