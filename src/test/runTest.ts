import { runTests } from '@vscode/test-electron';
import * as path from 'path';

async function main(): Promise<void> {
  try {
    // Folder containing the extension's package.json
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');

    // Entry point for the Mocha test runner inside the Extension Host
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    await runTests({ extensionDevelopmentPath, extensionTestsPath });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

main();
