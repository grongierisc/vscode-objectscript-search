import * as assert from 'assert';
import { resolveMatchLine } from '../../../utils/matchResolver';
import type { ISearchMatch } from '../../../types';

// ---------------------------------------------------------------------------
// Suite: matchResolver > resolveMatchLine
//
// Logic ported from vscode-objectscript's TextSearchProvider.ts.
// ---------------------------------------------------------------------------

suite('utils > resolveMatchLine', () => {
  // ── ClassMethod body (member + line) ───────────────────────────────────────

  test('ClassMethod body: returns memend + line', () => {
    const content = [
      'ClassMethod Save() As %Status',   // 0  declaration
      '{',                               // 1  brace  (memend = 1)
      '  Set sc = $$$OK',                // 2  body line 1
      '  Quit sc',                       // 3  body line 2
      '}',
    ];
    const match: ISearchMatch = { text: 'sc', member: 'Save', line: 1 };
    assert.strictEqual(resolveMatchLine(content, match, 'Pkg.Cls.cls', false), 2);
  });

  test('ClassMethod body: line 2 resolves correctly', () => {
    const content = [
      'ClassMethod Save() As %Status',
      '{',
      '  Set sc = $$$OK',               // body line 1
      '  Quit sc',                      // body line 2
      '}',
    ];
    const match: ISearchMatch = { text: 'Quit sc', member: 'Save', line: 2 };
    assert.strictEqual(resolveMatchLine(content, match, 'Pkg.Cls.cls', false), 3);
  });

  // ── Multi-line method signature (multilineMethodArgs = true) ──────────────

  test('multi-line args: finds { and uses it as memend', () => {
    const content = [
      'ClassMethod Create(',             // 0  declaration
      '  pName As %String,',            // 1
      '  pAge As %Integer)',            // 2
      '{',                              // 3  brace  → memend = 3
      '  Set obj = ##class(Foo).%New()',// 4  body line 1
      '  Quit obj',                     // 5  body line 2
      '}',
    ];
    const match: ISearchMatch = { text: 'obj', member: 'Create', line: 1 };
    assert.strictEqual(resolveMatchLine(content, match, 'Foo.cls', true), 4);
  });

  test('multi-line args disabled: still works for single-line signature', () => {
    const content = [
      'ClassMethod Foo()',               // 0
      '{',                              // 1  → memend = 1
      '  Quit 1',                       // 2  body line 1
      '}',
    ];
    const match: ISearchMatch = { text: '1', member: 'Foo', line: 1 };
    assert.strictEqual(resolveMatchLine(content, match, 'My.cls', false), 2);
  });

  // ── Member declaration (no line, no attr) ─────────────────────────────────

  test('no offset → returns declaration line', () => {
    const content = [
      'Property Name As %String;',      // 0
      '',
      'ClassMethod Greet()',            // 2  declaration
      '{',
      '  Quit "hello"',
      '}',
    ];
    const match: ISearchMatch = { text: 'Greet', member: 'Greet' };
    assert.strictEqual(resolveMatchLine(content, match, 'My.cls', false), 2);
  });

  // ── XData Code attribute ──────────────────────────────────────────────────

  test('attr=Code: returns memend + attrline', () => {
    const content = [
      'XData MyData [ MimeType = application/json ]', // 0
      '{',                                             // 1  memend = 1
      '  { "hello": "world" }',                       // 2  attrline 1
      '  { "foo": "bar" }',                            // 3  attrline 2
      '}',
    ];
    const match: ISearchMatch = { text: 'hello', member: 'MyData', attr: 'Code', attrline: 1 };
    assert.strictEqual(resolveMatchLine(content, match, 'My.cls', false), 2);
  });

  test('attr=Code and attrline=2', () => {
    const content = [
      'XData MyData [ MimeType = application/json ]',
      '{',
      '  { "hello": "world" }',
      '  { "foo": "bar" }',
      '}',
    ];
    const match: ISearchMatch = { text: 'foo', member: 'MyData', attr: 'Code', attrline: 2 };
    assert.strictEqual(resolveMatchLine(content, match, 'My.cls', false), 3);
  });

  // ── Description attribute ─────────────────────────────────────────────────

  test('attr=Description: resolves via descLineToDocLine', () => {
    const content = [
      '/// First description line',     // 0
      '/// Second description line',    // 1
      'ClassMethod Foo()',              // 2  memberLine = 2
      '{',
      '  Quit 1',
      '}',
    ];
    const match: ISearchMatch = { text: 'First', member: 'Foo', attr: 'Description', attrline: 1 };
    assert.strictEqual(resolveMatchLine(content, match, 'My.cls', false), 0);
  });

  test('attr=Description: attrline=2 → second description line', () => {
    const content = [
      '/// First description line',
      '/// Second description line',
      'ClassMethod Foo()',
      '{',
      '}',
    ];
    const match: ISearchMatch = { text: 'Second', member: 'Foo', attr: 'Description', attrline: 2 };
    assert.strictEqual(resolveMatchLine(content, match, 'My.cls', false), 1);
  });

  // ── Member keyword (attr defined, no attrline) ────────────────────────────

  test('attr=SqlProc (member keyword): returns line of keyword', () => {
    const content = [
      'Query ListAll() As %SQLQuery [',  // 0
      '  SqlProc,',                       // 1  ← attr search
      '  SqlName = "ListAll" ]',
      '{',
      'SELECT * FROM Items',
      '}',
    ];
    const match: ISearchMatch = { text: 'SqlProc', member: 'ListAll', attr: 'SqlProc' };
    assert.strictEqual(resolveMatchLine(content, match, 'My.cls', false), 1);
  });

  // ── Storage XML path ──────────────────────────────────────────────────────

  test('Storage XML path: walks tag chain to find text', () => {
    const content = [
      'Storage Default',                               // 0
      '{',                                             // 1
      '<Data name="AppData">',                         // 2
      '<DataLocation>^MyGlobal</DataLocation>',        // 3
      '</Data>',                                       // 4
      '}',
    ];
    const match: ISearchMatch = {
      text: '^MyGlobal',
      member: 'Storage',
      attr: 'Default,DataLocation',
    };
    assert.strictEqual(resolveMatchLine(content, match, 'My.cls', false), 3);
  });

  // ── Member not found → null ────────────────────────────────────────────────

  test('member not found (no line fallback) → null', () => {
    const content = [
      'ClassMethod Foo()',
      '{',
      '  Quit 1',
      '}',
    ];
    const match: ISearchMatch = { text: 'Bar', member: 'Bar' };
    assert.strictEqual(resolveMatchLine(content, match, 'My.cls', false), null);
  });

  // ── Class-level attributes (no member) ────────────────────────────────────

  test('attr=IncludeCode: finds Include line', () => {
    const content = [
      'Include MyMacros',                // 0
      '',
      'Class My.Cls',
      '{',
      '}',
    ];
    const match: ISearchMatch = { text: 'MyMacros', attr: 'IncludeCode' };
    assert.strictEqual(resolveMatchLine(content, match, 'My.Cls.cls', false), 0);
  });

  test('attr=Import: finds Import line', () => {
    const content = [
      'Import %Library',                 // 0
      '',
      'Class My.Cls',
      '{',
      '}',
    ];
    const match: ISearchMatch = { text: '%Library', attr: 'Import' };
    assert.strictEqual(resolveMatchLine(content, match, 'My.Cls.cls', false), 0);
  });

  test('attr=Copyright: returns (attrline - 1)', () => {
    const match: ISearchMatch = { text: '2024', attr: 'Copyright', attrline: 3 };
    const content = ['/// Copyright 2024', '/// line 2', '/// line 3', 'Class Foo'];
    assert.strictEqual(resolveMatchLine(content, match, 'Foo.cls', false), 2);
  });

  // ── Routine header ────────────────────────────────────────────────────────

  test('routine header: no member, no attr, text === fileName → line 0', () => {
    const content = [
      'MyRoutine',                       // 0  routine header
      'Label1',
      '  Quit 1',
    ];
    const match: ISearchMatch = { text: 'MyRoutine.mac' };
    assert.strictEqual(resolveMatchLine(content, match, 'MyRoutine.mac', false), 0);
  });

  // ── Routine body (no member, no attr, line set) ────────────────────────────

  test('routine body: no member, no attr, line=3 → 3 (0-based passthrough)', () => {
    const content = ['Row0', 'Row1', 'Row2', 'Row3 match'];
    const match: ISearchMatch = { text: 'match', line: 3 };
    assert.strictEqual(resolveMatchLine(content, match, 'MyRoutine.mac', false), 3);
  });

  // ── CSP file: line - 1 ────────────────────────────────────────────────────

  test('CSP file: subtracts 1 from line (1-based API → 0-based)', () => {
    const content = ['<html>', '<body>', '<p>hello</p>', '</body>', '</html>'];
    const match: ISearchMatch = { text: 'hello', line: 3 };
    assert.strictEqual(resolveMatchLine(content, match, '/csp/user/page.csp', false), 2);
  });

  // ── No match info at all → null ────────────────────────────────────────────

  test('no member, no attr, no line, text does not match fileName → null', () => {
    const content = ['Row0', 'Row1'];
    const match: ISearchMatch = { text: 'something else' };
    assert.strictEqual(resolveMatchLine(content, match, 'MyRoutine.mac', false), null);
  });
});
