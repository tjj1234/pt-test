// Public vendor example only; no credentials, generation or upload endpoints.
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createPinnedAssetFetch}=require('../../shell/media/pinned-asset-fetch.cjs');
const {ingestMediaAssetCandidate}=require('../../shell/media/asset-ingest-candidate.cjs');
const {verifyMagicBytes}=require('../../shell/runtime/managed-media-writer-candidate.cjs');
const resultUrl='https://pub-ee388a8463c1497c8b4f503044a80ee1.r2.dev/upload/20260911/f2093d539a51d10e6e97b3023c8b5d75.jpg';
const host=new URL(resultUrl).hostname;
try {
 const asset=await ingestMediaAssetCandidate({resultUrl,expectedKind:'image',allowedHosts:[host],fetchImpl:createPinnedAssetFetch({allowedHosts:[host]}),maxBytes:2*1024*1024,timeoutMs:15000});
 if(!verifyMagicBytes(asset.buffer,asset.mime))throw Object.assign(new Error('signature'),{code:'PUBLIC_FIXTURE_SIGNATURE_MISMATCH'});
 console.log(JSON.stringify({result:'PASS',host,mime:asset.mime,byteCount:asset.byteCount,sha256:asset.sha256,anonymous:true,providerPostCount:0,scope:'public-static-vendor-example-only'}));
}catch(error){
 console.log(JSON.stringify({result:'FAIL',code:error.code||'PUBLIC_FIXTURE_FAILED',anonymous:true,providerPostCount:0,scope:'public-static-vendor-example-only'}));process.exitCode=1;
}
