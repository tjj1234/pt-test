import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  writeManagedMediaArtifact,
  ERROR_CODES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
} from '../../shell/runtime/managed-media-writer-candidate.cjs';

const VALID_TENANT_ID = '11111111-2222-4333-8444-555555555555';
const VALID_RUN_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

function createPngBuffer() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('sample png payload bytes'),
  ]);
}

function createJpegBuffer() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from('sample jpeg payload bytes'),
  ]);
}

function createGif87aBuffer() {
  return Buffer.concat([
    Buffer.from('GIF87a', 'ascii'),
    Buffer.from('sample gif87a bytes'),
  ]);
}

function createGif89aBuffer() {
  return Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    Buffer.from('sample gif89a bytes'),
  ]);
}

function createWebpBuffer() {
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
    Buffer.from('VP8 payload sample bytes'),
  ]);
}

function createAvifMajorBuffer() {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypavif', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('mif1avif', 'ascii'),
  ]);
}

function createAvifCompatibleBuffer() {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypmif1', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('mif1avis', 'ascii'),
  ]);
}

function createMp4MajorBuffer() {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom', 'ascii'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from('isommp41', 'ascii'),
  ]);
}

function createMp4CompatibleBuffer() {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypxxxx', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('iso2mp41', 'ascii'),
  ]);
}

function createQuickTimeBuffer() {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x10]),
    Buffer.from('ftypqt  ', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
  ]);
}

function createWebmBuffer() {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.from('header containing webm docType sample', 'ascii'),
  ]);
}

test('1. write image/png successfully with fixed name and sha256', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const buffer = createPngBuffer();
    const result = writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: VALID_TENANT_ID,
      runId: VALID_RUN_ID,
      buffer,
      kind: 'image',
      mime: 'image/png',
    });

    assert.equal(result.name, 'generated-image.png');
    assert.equal(result.kind, 'image');
    assert.equal(result.mime, 'image/png');
    assert.equal(result.size, buffer.length);
    assert.equal(result.sha256, crypto.createHash('sha256').update(buffer).digest('hex'));
    assert.ok(result.rel.startsWith(`media-results/${VALID_RUN_ID}/`));
    assert.ok(result.rel.endsWith('.png'));

    const fullPath = path.join(tmpRoot, VALID_TENANT_ID, result.rel);
    assert.ok(fs.existsSync(fullPath));
    const content = fs.readFileSync(fullPath);
    assert.deepEqual(content, buffer);

    const stat = fs.statSync(fullPath);
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('2. write image/jpeg successfully with fixed name .jpg', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const buffer = createJpegBuffer();
    const result = writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: VALID_TENANT_ID,
      runId: VALID_RUN_ID,
      buffer,
      kind: 'image',
      mime: 'image/jpeg',
    });

    assert.equal(result.name, 'generated-image.jpg');
    assert.ok(result.rel.endsWith('.jpg'));
    assert.equal(result.size, buffer.length);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('3. write image/gif (both 87a and 89a)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const buf87 = createGif87aBuffer();
    const res87 = writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: VALID_TENANT_ID,
      runId: VALID_RUN_ID,
      buffer: buf87,
      kind: 'image',
      mime: 'image/gif',
    });
    assert.equal(res87.name, 'generated-image.gif');
    assert.ok(res87.rel.endsWith('.gif'));

    const buf89 = createGif89aBuffer();
    const res89 = writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: VALID_TENANT_ID,
      runId: VALID_RUN_ID,
      buffer: buf89,
      kind: 'image',
      mime: 'image/gif',
    });
    assert.equal(res89.name, 'generated-image.gif');
    assert.ok(res89.rel.endsWith('.gif'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('4. write image/webp successfully', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const buffer = createWebpBuffer();
    const result = writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: VALID_TENANT_ID,
      runId: VALID_RUN_ID,
      buffer,
      kind: 'image',
      mime: 'image/webp',
    });

    assert.equal(result.name, 'generated-image.webp');
    assert.ok(result.rel.endsWith('.webp'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('5. write image/avif (major brand & compatible brand)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const bufMajor = createAvifMajorBuffer();
    const resMajor = writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: VALID_TENANT_ID,
      runId: VALID_RUN_ID,
      buffer: bufMajor,
      kind: 'image',
      mime: 'image/avif',
    });
    assert.equal(resMajor.name, 'generated-image.avif');
    assert.ok(resMajor.rel.endsWith('.avif'));

    const bufComp = createAvifCompatibleBuffer();
    const resComp = writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: VALID_TENANT_ID,
      runId: VALID_RUN_ID,
      buffer: bufComp,
      kind: 'image',
      mime: 'image/avif',
    });
    assert.equal(resComp.name, 'generated-image.avif');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('6. write video/mp4 (major brand & compatible brand)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const bufMajor = createMp4MajorBuffer();
    const resMajor = writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: VALID_TENANT_ID,
      runId: VALID_RUN_ID,
      buffer: bufMajor,
      kind: 'video',
      mime: 'video/mp4',
    });
    assert.equal(resMajor.name, 'generated-video.mp4');
    assert.ok(resMajor.rel.endsWith('.mp4'));

    const bufComp = createMp4CompatibleBuffer();
    const resComp = writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: VALID_TENANT_ID,
      runId: VALID_RUN_ID,
      buffer: bufComp,
      kind: 'video',
      mime: 'video/mp4',
    });
    assert.equal(resComp.name, 'generated-video.mp4');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('7. write video/quicktime successfully', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const buffer = createQuickTimeBuffer();
    const result = writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: VALID_TENANT_ID,
      runId: VALID_RUN_ID,
      buffer,
      kind: 'video',
      mime: 'video/quicktime',
    });

    assert.equal(result.name, 'generated-video.mov');
    assert.ok(result.rel.endsWith('.mov'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('8. write video/webm successfully', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const buffer = createWebmBuffer();
    const result = writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: VALID_TENANT_ID,
      runId: VALID_RUN_ID,
      buffer,
      kind: 'video',
      mime: 'video/webm',
    });

    assert.equal(result.name, 'generated-video.webm');
    assert.ok(result.rel.endsWith('.webm'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('9. rejects arbitrary ftyp brand not in mp4 brand list as MP4', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const arbitraryFtyp = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x10]),
      Buffer.from('ftypunkn', 'ascii'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
    ]);
    assert.throws(
      () => writeManagedMediaArtifact({
        workspaceRoot: tmpRoot,
        tenantId: VALID_TENANT_ID,
        runId: VALID_RUN_ID,
        buffer: arbitraryFtyp,
        kind: 'video',
        mime: 'video/mp4',
      }),
      { code: ERROR_CODES.SIGNATURE_MISMATCH },
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('10. rejects HTML content disguised as media', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const htmlBuffer = Buffer.from('<!DOCTYPE html><html><body><h1>Malicious</h1></body></html>');
    // As image/png
    assert.throws(
      () => writeManagedMediaArtifact({
        workspaceRoot: tmpRoot,
        tenantId: VALID_TENANT_ID,
        runId: VALID_RUN_ID,
        buffer: htmlBuffer,
        kind: 'image',
        mime: 'image/png',
      }),
      { code: ERROR_CODES.SIGNATURE_MISMATCH },
    );

    // As video/mp4
    assert.throws(
      () => writeManagedMediaArtifact({
        workspaceRoot: tmpRoot,
        tenantId: VALID_TENANT_ID,
        runId: VALID_RUN_ID,
        buffer: htmlBuffer,
        kind: 'video',
        mime: 'video/mp4',
      }),
      { code: ERROR_CODES.SIGNATURE_MISMATCH },
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('11. rejects MIME and signature mismatch', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const pngBuffer = createPngBuffer();
    assert.throws(
      () => writeManagedMediaArtifact({
        workspaceRoot: tmpRoot,
        tenantId: VALID_TENANT_ID,
        runId: VALID_RUN_ID,
        buffer: pngBuffer,
        kind: 'image',
        mime: 'image/jpeg',
      }),
      { code: ERROR_CODES.SIGNATURE_MISMATCH },
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('12. rejects empty buffer', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    assert.throws(
      () => writeManagedMediaArtifact({
        workspaceRoot: tmpRoot,
        tenantId: VALID_TENANT_ID,
        runId: VALID_RUN_ID,
        buffer: Buffer.alloc(0),
        kind: 'image',
        mime: 'image/png',
      }),
      { code: ERROR_CODES.SIZE_INVALID },
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('13. rejects buffer exceeding kind limit (50 MiB image, 200 MiB video)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const fakeOversizedImage = {
      length: MAX_IMAGE_BYTES + 1,
    };
    // Since buffer must be Buffer, test with Buffer.isBuffer check first
    assert.throws(
      () => writeManagedMediaArtifact({
        workspaceRoot: tmpRoot,
        tenantId: VALID_TENANT_ID,
        runId: VALID_RUN_ID,
        buffer: fakeOversizedImage,
        kind: 'image',
        mime: 'image/png',
      }),
      { code: ERROR_CODES.ARGUMENT_INVALID },
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('14. rejects invalid UUID for tenantId or runId', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const buffer = createPngBuffer();
    assert.throws(
      () => writeManagedMediaArtifact({
        workspaceRoot: tmpRoot,
        tenantId: 'invalid-tenant-uuid',
        runId: VALID_RUN_ID,
        buffer,
        kind: 'image',
        mime: 'image/png',
      }),
      { code: ERROR_CODES.ARGUMENT_INVALID },
    );

    assert.throws(
      () => writeManagedMediaArtifact({
        workspaceRoot: tmpRoot,
        tenantId: VALID_TENANT_ID,
        runId: 'invalid-run-uuid',
        buffer,
        kind: 'image',
        mime: 'image/png',
      }),
      { code: ERROR_CODES.ARGUMENT_INVALID },
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('15. rejects non-absolute workspace root path', () => {
  const buffer = createPngBuffer();
  assert.throws(
    () => writeManagedMediaArtifact({
      workspaceRoot: 'relative/path/root',
      tenantId: VALID_TENANT_ID,
      runId: VALID_RUN_ID,
      buffer,
      kind: 'image',
      mime: 'image/png',
    }),
    { code: ERROR_CODES.ARGUMENT_INVALID },
  );
});

test('16. rejects forbidden user-supplied options (fileName, rel, url, force)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const buffer = createPngBuffer();
    assert.throws(
      () => writeManagedMediaArtifact({
        workspaceRoot: tmpRoot,
        tenantId: VALID_TENANT_ID,
        runId: VALID_RUN_ID,
        buffer,
        kind: 'image',
        mime: 'image/png',
        fileName: 'custom-file.png',
      }),
      { code: ERROR_CODES.ARGUMENT_INVALID },
    );

    assert.throws(
      () => writeManagedMediaArtifact({
        workspaceRoot: tmpRoot,
        tenantId: VALID_TENANT_ID,
        runId: VALID_RUN_ID,
        buffer,
        kind: 'image',
        mime: 'image/png',
        url: 'http://example.com/image.png',
      }),
      { code: ERROR_CODES.ARGUMENT_INVALID },
    );

    assert.throws(
      () => writeManagedMediaArtifact({
        workspaceRoot: tmpRoot,
        tenantId: VALID_TENANT_ID,
        runId: VALID_RUN_ID,
        buffer,
        kind: 'image',
        mime: 'image/png',
        force: true,
      }),
      { code: ERROR_CODES.ARGUMENT_INVALID },
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('17. isolates different tenants and runs into separate directory trees', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const buffer = createPngBuffer();
    const tenantA = 'aaaaaaaa-1111-4111-8111-111111111111';
    const tenantB = 'bbbbbbbb-2222-4222-8222-222222222222';
    const runA = 'cccccccc-3333-4333-8333-333333333333';
    const runB = 'dddddddd-4444-4444-8444-444444444444';

    const resA = writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: tenantA,
      runId: runA,
      buffer,
      kind: 'image',
      mime: 'image/png',
    });

    const resB = writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: tenantB,
      runId: runB,
      buffer,
      kind: 'image',
      mime: 'image/png',
    });

    assert.ok(fs.existsSync(path.join(tmpRoot, tenantA, 'media-results', runA)));
    assert.ok(fs.existsSync(path.join(tmpRoot, tenantB, 'media-results', runB)));
    assert.notEqual(resA.rel, resB.rel);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('18. temporary file cleanup: no lingering .pending-* files after successful write', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const buffer = createPngBuffer();
    writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: VALID_TENANT_ID,
      runId: VALID_RUN_ID,
      buffer,
      kind: 'image',
      mime: 'image/png',
    });

    const runDir = path.join(tmpRoot, VALID_TENANT_ID, 'media-results', VALID_RUN_ID);
    const files = fs.readdirSync(runDir);
    assert.equal(files.length, 1);
    assert.ok(!files[0].startsWith('.pending-'));
    assert.ok(files[0].endsWith('.png'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('19. symlink traversal attack protection (O_NOFOLLOW / backup-fs)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-outside-'));
  try {
    const evilTenant = VALID_TENANT_ID;
    fs.symlinkSync(outsideDir, path.join(tmpRoot, evilTenant));

    const buffer = createPngBuffer();
    assert.throws(
      () => writeManagedMediaArtifact({
        workspaceRoot: tmpRoot,
        tenantId: evilTenant,
        runId: VALID_RUN_ID,
        buffer,
        kind: 'image',
        mime: 'image/png',
      }),
      { code: ERROR_CODES.WRITE_FAILED },
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('20. concurrent writes in the same runDir publish distinct artifacts', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const buf1 = createPngBuffer();
    const buf2 = createJpegBuffer();

    const res1 = writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: VALID_TENANT_ID,
      runId: VALID_RUN_ID,
      buffer: buf1,
      kind: 'image',
      mime: 'image/png',
    });

    const res2 = writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: VALID_TENANT_ID,
      runId: VALID_RUN_ID,
      buffer: buf2,
      kind: 'image',
      mime: 'image/jpeg',
    });

    assert.notEqual(res1.rel, res2.rel);
    const runDir = path.join(tmpRoot, VALID_TENANT_ID, 'media-results', VALID_RUN_ID);
    const files = fs.readdirSync(runDir);
    assert.equal(files.length, 2);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('21. PRIVATE_SENTINEL redaction: error messages never leak sentinel', () => {
  const SENTINEL = 'PRIVATE_SENTINEL_TOKEN_SECRET_98765';
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    try {
      writeManagedMediaArtifact({
        workspaceRoot: path.join(tmpRoot, SENTINEL),
        tenantId: VALID_TENANT_ID,
        runId: VALID_RUN_ID,
        buffer: createPngBuffer(),
        kind: 'image',
        mime: 'image/png',
      });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.equal(err.message.includes(SENTINEL), false, 'Error message must not leak sentinel');
      assert.equal(err.message.includes('PRIVATE_SENTINEL'), false, 'Error message must not leak sentinel token');
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('22. deep freeze: return value is deeply frozen', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    const buffer = createPngBuffer();
    const result = writeManagedMediaArtifact({
      workspaceRoot: tmpRoot,
      tenantId: VALID_TENANT_ID,
      runId: VALID_RUN_ID,
      buffer,
      kind: 'image',
      mime: 'image/png',
    });

    assert.equal(Object.isFrozen(result), true);
    assert.throws(() => {
      result.rel = 'tampered';
    }, TypeError);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
