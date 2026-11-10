#!/usr/bin/env python3
"""Controlled no-credential test; writes only a new remote temporary directory."""
import gzip,hashlib,json,secrets,shlex,subprocess
from pathlib import Path
root=Path(__file__).resolve().parent.parent
binary=root/'.release-inputs/isolation/offline-analysis'
fingerprint=hashlib.sha256(binary.read_bytes()).hexdigest()
remote='/tmp/pt-r34-isolation-'+fingerprint[:12]+'-'+secrets.token_hex(3)
probe=(root/'tests/probes/r34-isolation-platform-proof-20261110.mjs').read_text()
probe=probe.replace('/tmp/pt-r34-isolation-49a81986-r3/offline-analysis',remote+'/offline-analysis')
expected='/opt/northstar/releases/controlled-trial-20261106-candidate-34-r33-questions-m1-draft/shell'
script='set -eu\numask 077\n'+'test "$(systemctl show northstar-shell --property=WorkingDirectory --value)" = '+shlex.quote(expected)+'\n'
script+='mkdir '+shlex.quote(remote)+'\ngzip -dc > '+shlex.quote(remote+'/offline-analysis')+'\nchmod 700 '+shlex.quote(remote+'/offline-analysis')+'\n'
script+='printf %s '+shlex.quote(fingerprint+'  '+remote+'/offline-analysis\n')+' | sha256sum -c -\n'
script+=shlex.quote(remote+'/offline-analysis')+' --probe\n'
script+='ulimit -c 0\nnode --input-type=module -e '+shlex.quote(probe)+'\n'
result=subprocess.run(['ssh','-S','/private/tmp/pt-ops-20261105.sock','-o','BatchMode=yes','-o','ConnectTimeout=8','tongjiawan@47.237.22.191','sh -c '+shlex.quote(script)],input=gzip.compress(binary.read_bytes()),capture_output=True,timeout=35)
receipt={'scope':'R34_TEMPORARY_ISOLATION_PROBE_ONLY','helperSha256':fingerprint,'remoteDirectory':remote,'exitCode':result.returncode,'stdout':result.stdout.decode(errors='replace'),'stderr':result.stderr.decode(errors='replace')}
(root/'.release-inputs/isolation'/('receipt-'+fingerprint[:12]+'-'+remote.rsplit('-',1)[-1]+'.json')).write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt));raise SystemExit(result.returncode)
