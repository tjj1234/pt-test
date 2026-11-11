#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
stage=/home/tongjiawan/pt-r34-stage-37930c7/assembled-1586f76
name=northstar-controlled-trial-20261111-r34-all8-1586f76-target
old=/opt/northstar/releases/controlled-trial-20261106-candidate-34-r33-questions-m1-draft
[[ $(systemctl show northstar-shell --property=WorkingDirectory --value) == "$old/shell" ]]
systemctl is-active --quiet northstar-shell
cd "$stage"
mkdir -p "$stage/preflight-tmp" "$stage/media-processing"
chmod 0700 "$stage/preflight-tmp" "$stage/media-processing"
export TMPDIR="$stage/preflight-tmp" PT_MEDIA_PROCESSING_DIR="$stage/media-processing"
printf '%s  %s\n' cb36cdc5002bdc70a855fd30558893632c9442d847dd609534ea027efe94e4bf "$name.tar.gz" 8ee72b3d955eb79918409536380fe83c9b2eaf3e8a83cb9303e127aed9bb46c9 "$name.sources.json" cdfd10f196e7156ae296c17a4fd6f4708dd8602c198ce94f17e10cf5bf2ba9de r34-target-linux-node-modules-20261111.tar.gz | sha256sum -c -
python3 - "$name.tar.gz" r34-target-linux-node-modules-20261111.tar.gz <<'PY'
import sys,tarfile,posixpath
for archive in sys.argv[1:]:
 with tarfile.open(archive) as t:
  seen=set()
  for m in t:
   p=m.name
   assert p not in seen and not p.startswith('/') and all(c not in ('..','') and not c.startswith('._') for c in p.split('/')), 'ARCHIVE_MEMBER_INVALID'
   seen.add(p)
   assert m.isfile() or m.isdir() or m.issym() or m.islnk(), 'ARCHIVE_TYPE_INVALID'
   if m.issym() or m.islnk():
    assert archive=='r34-target-linux-node-modules-20261111.tar.gz' and not m.linkname.startswith('/'), 'ARCHIVE_LINK_INVALID'
    resolved=posixpath.normpath(posixpath.join(posixpath.dirname(p) if m.issym() else '',m.linkname))
    assert resolved.startswith('node_modules/'), 'ARCHIVE_LINK_ESCAPE'
print('ARCHIVE_PATHS_PASS')
PY
if [[ ! -e verified-app ]]; then
 mkdir verified-app
 tar -xzf "$name.tar.gz" -C verified-app
 tar -xzf r34-target-linux-node-modules-20261111.tar.gz -C verified-app/shell
fi
python3 - "$name.sources.json" verified-app <<'PY'
import sys,json,hashlib
from pathlib import Path
plan=json.loads(Path(sys.argv[1]).read_text());root=Path(sys.argv[2])
assert len(plan['members'])==1095
for name,digest in plan['members'].items():
 file=root/name
 assert not file.is_symlink() and file.is_file() and hashlib.sha256(file.read_bytes()).hexdigest()==digest, 'ARCHIVE_MEMBER_BINDING_FAILED'
print('ARCHIVE_MEMBER_BINDING_PASS',len(plan['members']))
PY
node verified-app/shell/northstar-dependency-closure.cjs --check verified-app/shell/dependency-closure-manifest.json
node --check verified-app/shell/server.cjs
node --check verified-app/shell/public/app.js
node --input-type=module - "$stage/verified-app" <<'NODE'
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {spawnSync} from 'node:child_process';
const root=process.argv[2],require=createRequire(path.join(root,'shell/package.json'));
const media=require(path.join(root,'shell/media/local-content-runtime.cjs'));media.verifyRuntime();require(path.join(root,'shell/attachments/legacy-office.cjs')).verifyLegacyRuntime();await media.run('ffmpeg',['-version'],{maxBytes:65536});await media.run('tesseract',['--version'],{maxBytes:65536});
const {createHash}=await import('node:crypto');const audio=fs.readFileSync(path.join(path.dirname(root),'jfk.wav')),ocrBytes=fs.readFileSync(path.join(path.dirname(root),'ocr-proof.png'));
if(createHash('sha256').update(audio).digest('hex')!=='59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e'||createHash('sha256').update(ocrBytes).digest('hex')!=='8506434d7d6582163c4d9e63dff526112e4acca68a8ece67cd2b5797d465186c')throw Error('PUBLIC_FIXTURE_CHANGED');
const transcript=await media.processMedia({bytes:audio,mimeType:'audio/wav'});if(!/ask not what your country/i.test(transcript.segments.map(s=>s.text).join(' '))||transcript.durationMs!==11000)throw Error('TARGET_ASR_FAILED');console.log('TARGET_REAL_AUDIO_TRANSCRIPTION_PASS');
const ocr=await media.recognizeImage(ocrBytes);if(!/12345/.test(ocr)||!/中文/.test(ocr))throw Error('TARGET_OCR_FAILED');console.log('TARGET_REAL_CHINESE_OCR_PASS');
const videoDir=fs.mkdtempSync(path.join(os.tmpdir(),'northstar-r34-video-proof-'));try{const file=path.join(videoDir,'test.mp4');await media.run('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=10','-t','3','-c:v','mpeg4',file],{cwd:videoDir});const video=await media.processMedia({bytes:fs.readFileSync(file),mimeType:'video/mp4'});if(video.durationMs!==3000||JSON.stringify(video.frames.map(f=>f.timestampMs))!=='[0,1500,2000]')throw Error('TARGET_VIDEO_FAILED');console.log('TARGET_REAL_VIDEO_FRAMES_PASS');}finally{fs.rmSync(videoDir,{recursive:true,force:true});}
const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'northstar-r34-preflight-'));try{const {offlineAnalysisArguments}=await import(pathToFileURL(path.join(root,'shell/runtime/offline-analysis.mjs')));const config=offlineAnalysisArguments({workspaceRoot:workspace,code:"print('R34_KERNEL_PREFLIGHT_PASS')"});const out=spawnSync(config.argv[0],config.argv.slice(1),{cwd:workspace,encoding:'utf8',timeout:6000,maxBuffer:32768});if(out.status!==0||!out.stdout.includes('R34_KERNEL_PREFLIGHT_PASS'))throw Error('R34_KERNEL_PREFLIGHT_FAILED');}finally{fs.rmdirSync(workspace);}console.log('TARGET_NATIVE_MEDIA_AND_ISOLATION_PASS');
NODE
curl --max-time 10 -fsS http://127.0.0.1:8098/healthz >/dev/null
printf 'R34_TARGET_PREFLIGHT_PASS_NO_DEPLOYMENT\n'
