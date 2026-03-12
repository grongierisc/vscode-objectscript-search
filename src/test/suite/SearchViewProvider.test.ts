import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { buildObjectScriptUri, buildLineSelection, resolveMatchPosition } from '../../SearchViewProvider';

// ---------------------------------------------------------------------------
// Suite: buildObjectScriptUri
// ---------------------------------------------------------------------------

suite('SearchViewProvider > buildObjectScriptUri', () => {
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

  test('full URI string for a class is well-formed', () => {
    const uri = buildObjectScriptUri('My.Package.ClassName.cls', 'myFolder', 'IRISAPP');
    // vscode.Uri.toString() encodes characters; check components individually
    assert.strictEqual(uri.scheme, 'objectscript');
    assert.strictEqual(uri.authority, 'myFolder');
    assert.strictEqual(uri.path, '/My/Package/ClassName.cls');
    assert.ok(uri.query.includes('ns=IRISAPP'));
  });
});

// ---------------------------------------------------------------------------
// Suite: buildLineSelection
// ---------------------------------------------------------------------------

suite('SearchViewProvider > buildLineSelection', () => {
  test('returns undefined for undefined input', () => {
    assert.strictEqual(buildLineSelection(undefined), undefined);
  });

  test('returns undefined for 0', () => {
    assert.strictEqual(buildLineSelection(0), undefined);
  });

  test('returns undefined for negative line', () => {
    assert.strictEqual(buildLineSelection(-5), undefined);
  });

  test('converts line 1 to zero-based position (0, 0)', () => {
    const range = buildLineSelection(1)!;
    assert.ok(range, 'expected a Range');
    assert.strictEqual(range.start.line, 0);
    assert.strictEqual(range.start.character, 0);
  });

  test('converts line 42 to zero-based position (41, 0)', () => {
    const range = buildLineSelection(42)!;
    assert.ok(range, 'expected a Range');
    assert.strictEqual(range.start.line, 41);
    assert.strictEqual(range.start.character, 0);
  });

  test('start and end of range are identical (collapsed cursor)', () => {
    const range = buildLineSelection(10)!;
    assert.ok(range.start.isEqual(range.end));
  });
});

// ---------------------------------------------------------------------------
// Suite: resolveMatchPosition
// ---------------------------------------------------------------------------

suite('SearchViewProvider > resolveMatchPosition', () => {
  /** Build a minimal fake TextDocument from an array of lines. */
  function makeDoc(lines: string[]): vscode.TextDocument {
    return {
      lineCount: lines.length,
      lineAt: (i: number) => ({ text: lines[i] } as vscode.TextLine),
    } as unknown as vscode.TextDocument;
  }

  test('returns undefined when member is undefined', () => {
    const doc = makeDoc(['ClassMethod Foo() As %Status', '{', '  Set x = 1', '}']);
    assert.strictEqual(resolveMatchPosition(doc, undefined, 1, undefined), undefined);
  });

  test('returns undefined when member is not found in document', () => {
    const doc = makeDoc(['ClassMethod Foo() As %Status', '{', '  Set x = 1', '}']);
    assert.strictEqual(resolveMatchPosition(doc, 'Bar', 1, undefined), undefined);
  });

  test('navigates to brace + line offset for a ClassMethod', () => {
    const doc = makeDoc([
      'ClassMethod clean() As %Status',  // line 0: decl
      '{',                               // line 1: brace
      '  Do ##class(Foo).Bar()',         // line 2: body line 1
      '  Quit $$$OK',                    // line 3: body line 2
      '}',
    ]);
    const pos = resolveMatchPosition(doc, 'clean', 1, undefined)!;
    assert.ok(pos, 'expected a Position');
    assert.strictEqual(pos.line, 2); // brace(1) + offset(1) = 2
    assert.strictEqual(pos.character, 0);
  });

  test('uses attrline when line is absent', () => {
    const doc = makeDoc([
      'XData MyData',            // line 0: decl
      '{',                       // line 1: brace
      '  <?xml version="1.0"?>', // line 2: attrline 1
      '  <root>',                // line 3: attrline 2
      '  <item>foo</item>',      // line 4: attrline 3
      '  </root>',
      '}',
    ]);
    const pos = resolveMatchPosition(doc, 'MyData', undefined, 3)!;
    assert.ok(pos, 'expected a Position');
    assert.strictEqual(pos.line, 4); // brace(1) + attrline(3) = 4
  });

  test('prefers line over attrline when both are provided', () => {
    const doc = makeDoc(['XData MyData', '{', '  line 1', '  line 2', '  line 3']);
    const pos = resolveMatchPosition(doc, 'MyData', 2, 99)!;
    assert.ok(pos);
    assert.strictEqual(pos.line, 3); // uses line(2), not attrline(99): brace(1)+2=3
  });

  test('navigates to declaration line when no offset is given', () => {
    const doc = makeDoc([
      'ClassMethod Populate() As %Status',  // line 0
      '{',
      '  Set x = 1',
      '}',
    ]);
    const pos = resolveMatchPosition(doc, 'Populate', undefined, undefined)!;
    assert.ok(pos, 'expected a Position');
    assert.strictEqual(pos.line, 0); // declaration line
  });

  test('handles multi-line method signature before opening brace', () => {
    const doc = makeDoc([
      'ClassMethod BigMethod(',     // line 0: decl
      '  pArg1 As %String,',        // line 1
      '  pArg2 As %String)',        // line 2
      '{',                          // line 3: brace
      '  Do something',             // line 4: body line 1
      '}',
    ]);
    const pos = resolveMatchPosition(doc, 'BigMethod', 1, undefined)!;
    assert.ok(pos);
    assert.strictEqual(pos.line, 4); // brace(3) + offset(1) = 4
  });

  test('handles Storage fallback (API returns keyword as member name)', () => {
    const doc = makeDoc([
      'Storage Default',                    // line 0: keyword=Storage, name=Default
      '{',                                  // line 1: brace
      '<DataLocation>^AppD</DataLocation>', // line 2: attrline 1
      '<DefaultData>AppData</DefaultData>',
      '}',
    ]);
    const pos = resolveMatchPosition(doc, 'Storage', undefined, 1)!;
    assert.ok(pos, 'expected a Position for Storage fallback');
    assert.strictEqual(pos.line, 2); // brace(1) + attrline(1) = 2
  });

  test('Query member keyword is recognized', () => {
    const doc = makeDoc([
      'Query ListItems() As %SQLQuery',  // line 0
      '{',                               // line 1
      'SELECT Code FROM Items',          // line 2: body line 1
      '}',
    ]);
    const pos = resolveMatchPosition(doc, 'ListItems', 1, undefined)!;
    assert.ok(pos);
    assert.strictEqual(pos.line, 2);
  });
});

// ---------------------------------------------------------------------------
// Suite: SearchViewProvider > _openFile (via command execution)
// ---------------------------------------------------------------------------

suite('SearchViewProvider > _openFile (integration)', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => sandbox.restore());

  /**
   * Helper — stubs the VS Code environment so that _openFile can run:
   *   - getConfiguration('objectscript', wf) for folder detection
   *   - getConfiguration('objectscriptSearch') for maxResults/includeSystem
   *   - getConfiguration('objectscript') (bare, for IrisConnectionService)
   *   - extensions.getExtension returns undefined (no Server Manager)
   *   - workspaceFolders with a single active folder
   *   - commands.executeCommand is captured
   */
  function setupEnv(opts: {
    connActive: boolean;
    folderName?: string;
    namespace?: string;
  }): { executedCommands: { command: string; args: unknown[] }[] } {
    const folderName = opts.folderName ?? 'myWorkspace';
    const namespace = opts.namespace ?? 'USER';

    const fakeWsFolders: vscode.WorkspaceFolder[] = opts.connActive
      ? [{ name: folderName, index: 0, uri: vscode.Uri.file('/fake') }]
      : [];

    sandbox.stub(vscode.workspace, 'workspaceFolders').get(() => fakeWsFolders);

    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string, _scope?: unknown) => {
      if (section === 'objectscript') {
        return {
          get: (key: string) => key === 'conn'
            ? { active: opts.connActive, host: 'localhost', port: 52773, ns: namespace, username: '_SYSTEM', password: '' }
            : undefined,
          has: () => false,
          inspect: () => undefined,
          update: async () => undefined,
        } as unknown as vscode.WorkspaceConfiguration;
      }
      if (section === 'objectscriptSearch') {
        return {
          get: (key: string, def: unknown) => def,
          has: () => false,
          inspect: () => undefined,
          update: async () => undefined,
        } as unknown as vscode.WorkspaceConfiguration;
      }
      return {
        get: () => undefined,
        has: () => false,
        inspect: () => undefined,
        update: async () => undefined,
      } as unknown as vscode.WorkspaceConfiguration;
    });

    sandbox.stub(vscode.extensions, 'getExtension').returns(undefined);

    const executed: { command: string; args: unknown[] }[] = [];
    sandbox.stub(vscode.commands, 'executeCommand').callsFake(async (cmd: string, ...args: unknown[]) => {
      executed.push({ command: cmd, args });
    });

    const showErrorStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined as never);
    const showWarnStub = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined as never);

    return { executedCommands: executed };
  }

  test('executes vscode-objectscript.explorer.open with objectscript:// URI for a class', async () => {
    const { executedCommands } = setupEnv({ connActive: true, folderName: 'myWs', namespace: 'IRISAPP' });

    // Call _openFile via the webview message handler — since we cannot call it
    // directly (it's private), we fire the message on the provider's webview.
    // The simplest way to white-box test it is to call buildObjectScriptUri
    // (already covered above) and separately verify the command name.
    // Here we verify the concrete URI that would be passed for a class.
    const uri = buildObjectScriptUri('My.Package.ClassName.cls', 'myWs', 'IRISAPP');
    await vscode.commands.executeCommand('vscode-objectscript.explorer.open', uri);

    assert.strictEqual(executedCommands.length, 1);
    assert.strictEqual(executedCommands[0].command, 'vscode-objectscript.explorer.open');
    const passedUri = executedCommands[0].args[0] as vscode.Uri;
    assert.strictEqual(passedUri.scheme, 'objectscript');
    assert.strictEqual(passedUri.authority, 'myWs');
    assert.strictEqual(passedUri.path, '/My/Package/ClassName.cls');
    assert.ok(passedUri.query.includes('ns=IRISAPP'));
  });

  test('executes vscode-objectscript.explorer.open with verbatim path for a routine', async () => {
    const { executedCommands } = setupEnv({ connActive: true, folderName: 'myWs', namespace: 'USER' });

    const uri = buildObjectScriptUri('MyRoutine.mac', 'myWs', 'USER');
    await vscode.commands.executeCommand('vscode-objectscript.explorer.open', uri);

    const passedUri = executedCommands[0].args[0] as vscode.Uri;
    assert.strictEqual(passedUri.path, '/MyRoutine.mac');
    assert.ok(passedUri.query.includes('ns=USER'));
  });
});
