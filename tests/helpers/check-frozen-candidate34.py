"""Retain original candidate34 reproducibility/audit against its frozen inputs."""
import hashlib,importlib.util,json,pathlib,sys,tarfile,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'release-artifacts'
NAME='northstar-controlled-trial-20261028-candidate-34-draft'
EXPECTED={NAME+'.tar.gz':'27dc651494661f7bf657404a0fe091be9a3319be10f79506b826dedf18dbb14c',NAME+'.sources.json':'d2c4d2ef5ad806e79fc09ee49f774ce47754b0da09756364057eb7c708a112bc','northstar-shell-candidate-34-draft.service':'a35b790eea2611a4476251192e09220834421ccaf16d6f4fcce5125085d0c853'}
for name,digest in EXPECTED.items():assert hashlib.sha256((OUT/name).read_bytes()).hexdigest()==digest
files={}
with tarfile.open(OUT/(NAME+'.tar.gz')) as tar:
 for member in tar.getmembers():
  name=pathlib.PurePosixPath(member.name);assert not name.is_absolute() and '..' not in name.parts and (member.isfile() or member.isdir())
  if member.isfile():files[member.name]=tar.extractfile(member).read()
mode=sys.argv[1];assert mode in ('build','audit')
spec=importlib.util.spec_from_file_location('frozen34',ROOT/('scripts/package-northstar-candidate34-draft.py' if mode=='build' else 'scripts/audit-northstar-candidate34-draft.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
if mode=='build':
 module.source=lambda name:files[name]
 sys.argv=['frozen-builder','--check'];module.main()
else:
 with tempfile.TemporaryDirectory(prefix='northstar-frozen34-') as directory:
  snapshot=pathlib.Path(directory)
  for name in json.loads((OUT/(NAME+'.sources.json')).read_bytes())['sources']:
   target=snapshot/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(files[name])
  module.ROOT=snapshot;module.audit_candidate()
