'use strict';
// Operator-reviewed, offline-only transition for the exact r14 -> r26 baseline.
// This helper does not stop/start services, back up databases or modify unit files.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const OLD='3cb40b5978d2eb234a43577196af859315e310c956647d11fdcad52b8206557e';
const NEXT='5df264dce03602cc49b201f19e80ccf6b72e8d6d67ea29740240a79bd46fdce9';
const PROFILE='08e5a633b227427522aa802cff5cb8b61a1b859e687eb4358d141dd9c7e135af';
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fail=code=>Object.assign(Error(code),{code});
function run({home,oldTemplate,newRelease,apply=false,offlineAndBackupConfirmed=false,isServiceStopped=()=>false}){
 if(typeof home!=='string'||!path.isAbsolute(home)||typeof oldTemplate!=='string'||!path.isAbsolute(oldTemplate)||typeof newRelease!=='string'||!path.isAbsolute(newRelease))throw fail('TRANSITION_PATH_INVALID');
 const shell=path.join(newRelease,'shell'),template=path.join(shell,'dsh-settings.yaml'),runner=path.join(shell,'persistent-runner.mjs');
 const {inspectSettings,adoptSettings}=require(path.join(shell,'runtime/settings-version.cjs')),{upgradeSettings}=require(path.join(shell,'runtime/settings-upgrade.cjs')),{rebuildProfile,makeProfile}=require(path.join(shell,'runtime/dsh-adapter.cjs'));
 if(digest(oldTemplate)!==OLD||digest(template)!==NEXT)throw fail('TRANSITION_TEMPLATE_MISMATCH');
 const before=inspectSettings({home,template:oldTemplate}),manifest=path.join(home,'profiles/run-persistent/northstar-profile-manifest.json');
 if(before.status!=='untracked'||before.settingsHash!==OLD||before.templateHash!==OLD||before.baselineHash!==null)throw fail('TRANSITION_SETTINGS_DRIFT');
 if(digest(manifest)!==PROFILE)throw fail('TRANSITION_PROFILE_DRIFT');
 const summary={status:'READY_FOR_REVIEW',oldSettingsHash:before.settingsHash,oldProfileManifestHash:PROFILE,newTemplateHash:NEXT,providerCalls:0};
 if(!apply)return summary;
 if(offlineAndBackupConfirmed!==true||isServiceStopped()!==true)throw fail('TRANSITION_OFFLINE_BACKUP_REQUIRED');
 let stage='adopt',transaction=null,profileBackup=null;
 try{
  adoptSettings({home,template:oldTemplate,expected:before,reviewed:true});stage='settings_upgrade';
  const expected=inspectSettings({home,template});const result=upgradeSettings({home,template,expected,reviewed:true,offline:true});transaction=result.transaction;
  stage='profile_rebuild';const profile=rebuildProfile(home,template,runner);profileBackup=profile.backupDir;
  stage='profile_verify';makeProfile(home,template,runner);
  return {...summary,status:'TRANSITION_COMPLETE',transaction,profileBackup};
 }catch(error){const wrapped=fail(typeof error?.code==='string'&&/^[A-Z_]{1,80}$/.test(error.code)?error.code:'TRANSITION_FAILED');wrapped.stage=stage;wrapped.transaction=transaction;wrapped.profileBackup=profileBackup;throw wrapped;}
}
function serviceStopped(){const p=spawnSync('systemctl',['is-active','northstar-shell'],{encoding:'utf8',timeout:5000});return p.status===3&&p.stdout.trim()==='inactive';}
if(require.main===module){
 try{
  const [mode,newRelease,oldRelease,...flags]=process.argv.slice(2);if(!['inspect','apply'].includes(mode)||!newRelease||!oldRelease||flags.some(f=>f!=='--offline-and-backup-confirmed'))throw fail('TRANSITION_ARGUMENTS_INVALID');
  const {DSH_HOME}=require(path.join(newRelease,'shell/tenant.cjs'));
  const result=run({home:DSH_HOME,oldTemplate:path.join(oldRelease,'shell/dsh-settings.yaml'),newRelease,apply:mode==='apply',offlineAndBackupConfirmed:flags.includes('--offline-and-backup-confirmed'),isServiceStopped:serviceStopped});console.log(JSON.stringify(result));
 }catch(error){console.log(JSON.stringify({status:'TRANSITION_BLOCKED',code:error.code||'TRANSITION_FAILED',stage:error.stage||'preflight',transaction:error.transaction||null,profileBackup:error.profileBackup||null}));process.exitCode=1;}
}
module.exports={run};
