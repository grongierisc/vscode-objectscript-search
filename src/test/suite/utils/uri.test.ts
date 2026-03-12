import * as assert from 'assert';
import { buildObjectScriptUri } from '../../../utils/uri';

suite('utils > buildObjectScriptUri', () => {
  // ── scheme ────────────────────────────────────────────────────────────────

  test('uses objectscript scheme', () => {
    const uri = buildObjectScriptUri('Foo.cls', 'myFolder', 'USER');
    assert.strictEqual(uri.scheme, 'objectscript');
  });

  // ── authority (workspace folder name) ────────────────────────────────────

  test('sets authority to workspace folder name', () => {
    const uri = buildObjectScriptUri('Foo.cls', 'myWorkspace', 'USER');
    assert.strictEqual(uri.authority, 'myWorkspace');
  });

  // ── namespace query param ─────────────────────────────────────────────────

  test('encodes namespace as ns= query param', () => {
    const uri = buildObjectScriptUri('Foo.cls', 'ws', 'IRISAPP');
    assert.ok(uri.query.includes('ns=IRISAPP'), `query was: ${uri.query}`);
  });

  // ── .cls path conversion ──────────────────────────────────────────────────

  test('converts package dots to slashes in .cls path', () => {
    const uri = buildObjectScriptUri('My.Package.ClassName.cls', 'ws', 'USER');
    assert.strictEqual(uri.path, '/My/Package/ClassName.cls');
  });

  test('handles top-level class (no package dots)', () => {
    const uri = buildObjectScriptUri('MyClass.cls', 'ws', 'USER');
    assert.strictEqual(uri.path, '/MyClass.cls');
  });

  test('handles deeply nested package', () => {
    const uri = buildObjectScriptUri('A.B.C.D.E.cls', 'ws', 'USER');
    assert.strictEqual(uri.path, '/A/B/C/D/E.cls');
  });

  test('preserves .cls extension case', () => {
    const uri = buildObjectScriptUri('Foo.Bar.cls', 'ws', 'USER');
    assert.ok(uri.path.endsWith('.cls'));
  });

  // ── routine / include path (no conversion) ────────────────────────────────

  test('keeps .mac routine name verbatim', () => {
    const uri = buildObjectScriptUri('MyRoutine.mac', 'ws', 'USER');
    assert.strictEqual(uri.path, '/MyRoutine.mac');
  });

  test('keeps .int routine name verbatim', () => {
    const uri = buildObjectScriptUri('Generated.int', 'ws', 'USER');
    assert.strictEqual(uri.path, '/Generated.int');
  });

  test('keeps .inc include name verbatim', () => {
    const uri = buildObjectScriptUri('My.Include.inc', 'ws', 'USER');
    assert.strictEqual(uri.path, '/My.Include.inc');
  });

  // ── URI shape ─────────────────────────────────────────────────────────────

  test('path always starts with /', () => {
    const cls = buildObjectScriptUri('Foo.cls', 'ws', 'USER');
    const mac = buildObjectScriptUri('Foo.mac', 'ws', 'USER');
    assert.ok(cls.path.startsWith('/'));
    assert.ok(mac.path.startsWith('/'));
  });

  test('full URI components for a class are well-formed', () => {
    const uri = buildObjectScriptUri('My.Package.ClassName.cls', 'myFolder', 'IRISAPP');
    assert.strictEqual(uri.scheme, 'objectscript');
    assert.strictEqual(uri.authority, 'myFolder');
    assert.strictEqual(uri.path, '/My/Package/ClassName.cls');
    assert.ok(uri.query.includes('ns=IRISAPP'));
  });
});
