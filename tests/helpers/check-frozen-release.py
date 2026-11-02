"""Rebuild legacy releases from hash-pinned frozen sources, never today's tree."""
import hashlib,importlib.util,pathlib,shutil,sys,tarfile,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
HASHES={30:'dcabffe5cfc04e4280e92e221cc5c15e4c64379134be1747c59ac401ffb21559',31:'c006237dd8d48fcae71f13f852f772ec4a87fc986696c6d2d1007088cab01fa8'}
version=int(sys.argv[1]);assert version in HASHES
archive=ROOT/f'release-artifacts/northstar-controlled-trial-20261022-candidate-{version}.tar.gz'
assert hashlib.sha256(archive.read_bytes()).hexdigest()==HASHES[version]
spec=importlib.util.spec_from_file_location('frozen_builder',ROOT/f'scripts/package-northstar-candidate{version}.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='northstar-frozen-build-') as directory:
 snapshot=pathlib.Path(directory)
 with tarfile.open(archive) as tar:
  for name in getattr(module,'OVERLAYS',(getattr(module,'OVERLAY',None),)):
   assert name and not pathlib.PurePosixPath(name).is_absolute() and '..' not in pathlib.PurePosixPath(name).parts
   member=tar.getmember(name);assert member.isfile()
   target=snapshot/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(tar.extractfile(member).read())
 book=pathlib.Path(f'docs/refactor/北极星受控试运行部署命令清单-20261022-candidate-{version-1}.md')
 (snapshot/book).parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/book,snapshot/book)
 module.ROOT=snapshot
 sys.argv=['frozen-builder','--check'];module.main()
