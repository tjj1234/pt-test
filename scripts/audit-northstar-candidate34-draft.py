#!/usr/bin/env python3
"""Independent artifact/source audit; does not import or trust the builder."""
import hashlib,json,pathlib,re,tarfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'release-artifacts'
NAME='northstar-controlled-trial-20261028-candidate-34-draft'
def sha(data):return hashlib.sha256(data).hexdigest()
def audit_candidate(name=NAME, unit_name="northstar-shell-candidate-34-draft.service"):
 NAME=name
 plan_file=OUT/(NAME+'.sources.json');plan=json.loads(plan_file.read_bytes())
 assert plan['status']=='DRAFT_NOT_FOR_DEPLOYMENT'
 for row in (OUT/(NAME+'.sha256')).read_text().splitlines():
  digest,name=row.split('  ');assert pathlib.PurePosixPath(name).name==name;assert sha((OUT/name).read_bytes())==digest
 with tarfile.open(OUT/(NAME+'.tar.gz'),'r:gz') as tar:
  members=tar.getmembers();assert len(members)<=1000;assert len({m.name for m in members})==len(members)
  files={}
  for m in members:
   parts=m.name.split('/');assert not m.name.startswith('/') and '\\' not in m.name
   assert not any(p in ('','..','.','node_modules','__pycache__','.git','wb copy') or p.startswith('.env') or p.endswith('.pyc') for p in parts)
   assert m.isfile() or m.isdir();assert not m.pax_headers;assert not m.mode & 0o6002;assert m.size<64*1024*1024
   if m.isfile():files[m.name]=tar.extractfile(m).read()
 for name,digest in plan['sources'].items():assert sha(files[name])==digest==sha((ROOT/name).read_bytes())
 assert len(plan['sources'])>=165
 for name in plan['addedFiles']:assert name in files
 required=['shell/media/ptvideo-worker.py','shell/media/ptvideo-executor.cjs','shell/media/ptvideo-result-guard-candidate.cjs','shell/db-migrations/021_text_price_catalogs.sql','shell/runtime/run-budget-csv.json']
 assert all(name in files for name in required)
 vendor='shell/media/vendor/powertokens_video/'
 upstream=json.loads(files[vendor+'UPSTREAM.json']);assert sha(files[vendor+'pt_video.py'])==upstream['engineSha256'];assert sha(files[vendor+'LICENSE'])==upstream['licenseSha256']
 closure=json.loads(files['shell/dependency-closure-manifest.json'])
 for filename,key in [('package.json','packageJsonSha256'),('package-lock.json','packageLockSha256'),('.npmrc','npmrcSha256')]:assert sha(files['shell/'+filename])==closure['evidence'][key]
 # Prove all explicit relative JS imports/requires have a file in this archive.
 # Dynamic module/resource paths remain a separate clean-install/runtime gate.
 missing=[]
 for name,body in files.items():
  if not name.startswith(('shell/','business/media/')) or not name.endswith(('.cjs','.mjs','.js')):continue
  text=body.decode('utf8')
  pattern=r'''(?:require\(\s*|from\s*|import\(\s*)['"](\.[^'"]+)['"]'''
  for spec in re.findall(pattern,text):
   if name=='shell/persistent-runner.mjs' and spec in ('./budget.cjs','./usage.cjs','./presets.cjs','./native-image-message.mjs','./dsh-native-context-r4-candidate.mjs'):
    mapped={'./budget.cjs':'shell/tasks/budget.cjs','./usage.cjs':'shell/runtime/usage.cjs','./presets.cjs':'business/media/presets.cjs','./native-image-message.mjs':'shell/runtime/native-image-message.mjs','./dsh-native-context-r4-candidate.mjs':'shell/runtime/dsh-native-context-r4-candidate.mjs'}[spec]
    assert mapped in files;continue
   parts=[]
   for part in (pathlib.PurePosixPath(name).parent/pathlib.PurePosixPath(spec)).parts:
    if part=='..':
     if not parts:raise AssertionError('IMPORT_ESCAPES_ARCHIVE')
     parts.pop()
    elif part!='.':parts.append(part)
   target='/'.join(parts)
   if not any(p in files for p in [target,target+'.cjs',target+'.mjs',target+'.js',target+'.json',target+'/index.js',target+'/index.cjs']):missing.append((name,spec))
 assert not missing, 'RELATIVE_IMPORT_MISSING: '+repr(missing[:5])
 unit=(OUT/unit_name).read_text();assert '/opt/northstar/releases/'+NAME.removeprefix('northstar-')+'/shell' in unit
 print(json.dumps({'status':'DRAFT_ARTIFACT_AUDIT_PASS_NOT_DEPLOYMENT_APPROVAL','members':len(members),'files':len(files),'boundSources':len(plan['sources']),'relativeImports':'present','npmInputs':'match-existing-portable-closure'}))
if __name__=='__main__':audit_candidate()
