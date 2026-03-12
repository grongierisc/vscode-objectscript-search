import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 10_000,
  });

  const testsRoot = path.resolve(__dirname, '.');

  function addFiles(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        addFiles(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.test.js')) {
        mocha.addFile(path.join(dir, entry.name));
      }
    }
  }

  return new Promise((resolve, reject) => {
    try {
      addFiles(testsRoot);
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
