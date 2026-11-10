'use strict';
const {createBillingClient}=require('../candidates/billing-20261103/index.cjs');
const fail=code=>Object.assign(new Error('Official account query is unavailable'),{code});
function createBillingAccountService({db,keys,clientFactory=createBillingClient}){
 async function query(identity,input,{signal,runId,leaseOwner}={}){
  require('../contracts/phase1.cjs').assertContract('identity',identity);
  if(!input||Object.keys(input).some(k=>!['kind','startDate','endDate'].includes(k))||!['balance','usage','agreement','latest'].includes(input.kind))throw fail('BILLING_INPUT_INVALID');
  async function verify(){if(!runId)return;const {rows:[row]}=await db.query('SELECT state,lease_owner,lease_expires_at>clock_timestamp() AS active FROM agent_runs WHERE run_id=$1 AND user_id=$2 AND tenant_id=$3',[runId,identity.userId,identity.tenantId]);if(!row||row.state!=='running'||row.lease_owner!==leaseOwner||!row.active)throw fail('LEASE_LOST');}
  if(signal?.aborted)throw fail('BILLING_CANCELLED');await verify();
  const token=await keys.loadBillingToken(identity);if(!token)throw fail('BILLING_TOKEN_REQUIRED');
  const client=clientFactory({tenantId:identity.tenantId,userId:identity.userId,accountRead:true,credentialKind:'login-token',token});
  const method={balance:'getBalance',usage:'getUsageSummary',agreement:'getAgreementStatus',latest:'getConsumeLog'}[input.kind];
  const result=await client[method]({...(runId?{runId}:{}),startDate:input.startDate,endDate:input.endDate,signal});
  if(signal?.aborted)throw fail('BILLING_CANCELLED');await verify();return result;
 }
 return Object.freeze({query});
}
module.exports={createBillingAccountService};
