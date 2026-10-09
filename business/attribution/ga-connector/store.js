"use strict";
const { encryptWithKey, decryptWithKey } = require('../../../shell/keys.cjs');
function createGaStore({ pool, key }) {
 if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('GA_TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
 async function scoped(tenantId, fn) {
  const c = await pool.connect();
  try {
   await c.query('BEGIN');
   await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
   const out = await fn(c); await c.query('COMMIT'); return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
 }
 return {
  async putState(t, s) {
   return scoped(t, async c => {
    await c.query('DELETE FROM ga_oauth_states WHERE tenant_id=$1::uuid AND expires_at <= now()', [t]);
    await c.query('INSERT INTO ga_oauth_states (state_hash,tenant_id,session_hash,property_id,verifier,expires_at) VALUES ($1,$2::uuid,$3,$4,$5,$6)', [s.hash,t,s.session,s.property,s.verifier,s.expires]);
   });
  },
  async consumeState(t, hash, session) {
   return scoped(t, async c => (await c.query('DELETE FROM ga_oauth_states WHERE tenant_id=$1::uuid AND state_hash=$2 AND session_hash=$3 AND expires_at>now() RETURNING property_id,verifier', [t,hash,session])).rows[0]);
  },
  async save(t, property, token) {
   const {iv,ciphertext} = encryptWithKey(key, JSON.stringify({tenantId:t,token}));
   return scoped(t, c => c.query('INSERT INTO ga_connections (tenant_id,property_id,refresh_iv,refresh_ciphertext) VALUES ($1::uuid,$2,$3,$4) ON CONFLICT (tenant_id) DO UPDATE SET property_id=$2,refresh_iv=$3,refresh_ciphertext=$4,updated_at=now()', [t,property,iv,ciphertext]));
  },
  async get(t) {
   return scoped(t, async c => {
    const r = (await c.query('SELECT * FROM ga_connections WHERE tenant_id=$1::uuid', [t])).rows[0];
    if (!r) return null;
    const secret = JSON.parse(decryptWithKey(key,r.refresh_iv,r.refresh_ciphertext));
    if (secret.tenantId !== t) throw new Error('GA credential tenant mismatch');
    return {property:r.property_id, refreshToken:secret.token};
   });
  }
 };
}
module.exports = {createGaStore};
