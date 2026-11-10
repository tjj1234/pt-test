#!/usr/bin/env python3
"""Run only inside the isolated Debian Linux/amd64 build container.
Exports the actual signed-distribution FFmpeg/Tesseract ELF closure and the
source-built Whisper CLI; no runtime npm download or user credential is used.
"""
import hashlib,json,re,shutil,subprocess
from pathlib import Path
root=Path('/work');out=root/'runtime-linux-x64';out.mkdir(exist_ok=True)
for name in ['bin','lib','tessdata','licenses']:(out/name).mkdir(exist_ok=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
model=root/'ggml-tiny.bin'
assert hashlib.sha1(model.read_bytes()).hexdigest()=='bd577a113a864445d4c299885e0cb97d4ba92b5f'
programs={'ffmpeg':Path('/usr/bin/ffmpeg'),'ffprobe':Path('/usr/bin/ffprobe'),'tesseract':Path('/usr/bin/tesseract'),'whisper-cli':root/'build-linux/bin/whisper-cli'}
libs=set()
for name,source in programs.items():
 shutil.copy2(source,out/'bin'/name)
 text=subprocess.check_output(['ldd',str(source)],text=True)
 assert 'not found' not in text,text
 for filename in re.findall(r'(?:=>\s*)?(/[^\s]+)',text):
  file=Path(filename)
  if file.is_file():libs.add(file)
for file in libs:shutil.copy2(file,out/'lib'/file.name)
for language in ['eng','chi_sim']:
 files=list(Path('/usr/share/tesseract-ocr').glob('*/tessdata/'+language+'.traineddata'));assert len(files)==1
 shutil.copy2(files[0],out/'tessdata'/files[0].name)
shutil.copy2(model,out/'ggml-tiny.bin')
shutil.copy2(root/'whisper.cpp-1.7.6/LICENSE',out/'licenses/whisper.cpp-MIT.txt')
shutil.copy2(root/'OPENAI-WHISPER-MIT.txt',out/'licenses/OPENAI-WHISPER-MIT.txt')
# Preserve installed binary/library licenses, including FFmpeg GPL terms.
for copyright in Path('/usr/share/doc').glob('*/copyright'):
 destination=out/'licenses'/copyright.parent.name;destination.mkdir(exist_ok=True);shutil.copy2(copyright,destination/'copyright')
versions=subprocess.check_output(['dpkg-query','-W','-f=${Package}\t${Version}\n'],text=True)
(out/'licenses/debian-package-versions.txt').write_text(versions)
files={str(p.relative_to(out)):{'sha256':sha(p),'size':p.stat().st_size} for p in sorted(out.rglob('*')) if p.is_file() and p != out/'manifest.json'}
manifest={'schemaVersion':1,'platform':'linux','arch':'x64','whisperVersion':'1.7.6','whisperSource':'https://github.com/ggml-org/whisper.cpp/tree/v1.7.6','whisperSourceSha256':sha(root/'whisper-v1.7.6.tar.gz'),'modelSource':'https://huggingface.co/ggerganov/whisper.cpp','modelOfficialSha1':'bd577a113a864445d4c299885e0cb97d4ba92b5f','files':files}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'files':len(files),'bytes':sum(f['size'] for f in files.values()),'manifestSha256':sha(out/'manifest.json')}))
