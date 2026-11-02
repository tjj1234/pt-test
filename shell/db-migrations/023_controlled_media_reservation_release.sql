-- Candidate only. Preserve consumed grants and all reservation history.
DO $$
DECLARE item RECORD;
BEGIN
  FOR item IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid='controlled_media_reservations'::regclass AND
      ((c.contype='u' AND
        (SELECT array_agg(a.attname::text ORDER BY a.attname)
         FROM unnest(c.conkey) AS k(attnum)
         JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)
         = ARRAY['credential_scope_id','model_id','task_type']::text[])
       OR (c.contype='c' AND c.conkey=ARRAY[
         (SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='status')
       ]::smallint[]))
  LOOP
    EXECUTE format('ALTER TABLE controlled_media_reservations DROP CONSTRAINT %I',item.conname);
  END LOOP;
END $$;
CREATE UNIQUE INDEX controlled_media_reserved_slot
 ON controlled_media_reservations(credential_scope_id,model_id,task_type) WHERE status='reserved';
ALTER TABLE controlled_media_reservations
 ADD COLUMN provider TEXT,
 ADD COLUMN capability_revision TEXT,
 ADD COLUMN adapter_id TEXT,
 ADD COLUMN adapter_version TEXT,
 ADD COLUMN released_at TIMESTAMPTZ,
 ADD COLUMN release_reason TEXT,
 ADD COLUMN release_operation_id UUID REFERENCES run_external_operations(operation_id),
 ADD COLUMN released_by UUID REFERENCES users(id);
UPDATE controlled_media_reservations r SET provider=g.provider,
 capability_revision=g.capability_revision,adapter_id=g.adapter_id,adapter_version=g.adapter_version
 FROM controlled_media_grants g WHERE g.grant_id=r.grant_id;
-- Keep the existing reservation insert API while snapshotting grant identity.
CREATE FUNCTION controlled_media_snapshot_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT g.provider,g.capability_revision,g.adapter_id,g.adapter_version
 INTO NEW.provider,NEW.capability_revision,NEW.adapter_id,NEW.adapter_version
 FROM controlled_media_grants g WHERE g.grant_id=NEW.grant_id;
 RETURN NEW;
END $$;
CREATE TRIGGER controlled_media_snapshot_grant_insert BEFORE INSERT ON controlled_media_reservations
 FOR EACH ROW EXECUTE FUNCTION controlled_media_snapshot_grant();
ALTER TABLE controlled_media_reservations
 ALTER COLUMN provider SET NOT NULL,ALTER COLUMN capability_revision SET NOT NULL,
 ALTER COLUMN adapter_id SET NOT NULL,ALTER COLUMN adapter_version SET NOT NULL;
ALTER TABLE controlled_media_reservations ADD CONSTRAINT controlled_media_release_state
 CHECK ((status='reserved' AND released_at IS NULL AND release_reason IS NULL AND release_operation_id IS NULL AND released_by IS NULL)
 OR (status='released' AND released_at IS NOT NULL AND release_reason IS NOT NULL AND release_operation_id IS NOT NULL AND released_by IS NOT NULL));
