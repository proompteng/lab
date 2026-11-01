#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
case "${1:---check}" in --check|--write) ;; *) printf 'Expected --check or --write\n' >&2; exit 2 ;; esac
fixture_name="ofz-platform-policy-$(uuidgen | tr '[:upper:]' '[:lower:]')"
trap 'docker rm -f "$fixture_name" >/dev/null 2>&1 || true' EXIT
docker run --detach --name "$fixture_name" --publish 127.0.0.1::8443 --memory 512m \
  ghcr.io/authzed/spicedb@sha256:aa96009a0477f8a759149823407d47ad16d1a74390bae3102b3b0b7143502764 \
  serve --datastore-engine=memory --grpc-preshared-key=ofz-policy-fixture --http-enabled=true \
  --dispatch-cache-enabled=false --dispatch-cluster-cache-enabled=false --telemetry-endpoint='' \
  --skip-release-check=true --log-level=warn >/dev/null
fixture_port="$(docker port "$fixture_name" 8443/tcp | sed 's/.*://')"
python3 - "$fixture_port" "${1:---check}" <<'PY'
import hashlib,json,sys,time,urllib.request
from pathlib import Path
base=f'http://127.0.0.1:{int(sys.argv[1])}'
def post(path,body):
    request=urllib.request.Request(base+path,data=json.dumps(body).encode(),headers={'Authorization':'Bearer ofz-policy-fixture','Content-Type':'application/json'})
    return json.load(urllib.request.urlopen(request,timeout=5))
for attempt in range(100):
    try:
        urllib.request.urlopen(base+'/healthz',timeout=1).close()
        break
    except OSError:
        if attempt==99: raise
        time.sleep(.1)
schema=Path('schema.zed').read_text()+'\n'+Path('platform/schema.zed').read_text()
post('/v1/schema/write',{'schema':schema})
installed=post('/v1/schema/read',{})['schemaText']
digest=hashlib.sha256(installed.encode()).hexdigest()+'\n'
catalog=json.loads(Path('platform/policies.json').read_text())
resources={r['kind']:r['nativeType'] for r in catalog['resources']}
for index,action in enumerate(catalog['actions']):
    result=post('/v1/permissions/check',{'consistency':{'fullyConsistent':True},'resource':{'objectType':resources[action['resourceKind']],'objectId':'qualification'},'permission':action['permission'],'subject':{'object':{'objectType':'human','objectId':'qualification'}}})
    assert result['permissionship']=='PERMISSIONSHIP_NO_PERMISSION',action['id']
    if relation:=action.get('grantRelation'):
        target={'objectType':resources[action['resourceKind']],'objectId':f'qualification-{index}'}
        subject={'object':{'objectType':'human','objectId':'qualification'}}
        post('/v1/relationships/write',{'updates':[{'operation':'OPERATION_TOUCH','relationship':{'resource':target,'relation':relation,'subject':subject}}]})
        allowed=post('/v1/permissions/check',{'consistency':{'fullyConsistent':True},'resource':target,'permission':action['permission'],'subject':subject})
        assert allowed['permissionship']=='PERMISSIONSHIP_HAS_PERMISSION',action['id']
        for other in catalog['actions']:
            if other['resourceKind']==action['resourceKind'] and other['permission']!=action['permission']:
                denied=post('/v1/permissions/check',{'consistency':{'fullyConsistent':True},'resource':target,'permission':other['permission'],'subject':subject})
                assert denied['permissionship']=='PERMISSIONSHIP_NO_PERMISSION',(action['id'],other['id'])
output=Path('platform/schema.sha256')
if sys.argv[2]=='--write':output.write_text(digest)
else:assert output.read_text()==digest,'qualified schema hash differs; run qualify-platform.sh --write and review the schema'
print('PASS: installed native schema and every onboarded action; sha256='+digest.strip())
PY
