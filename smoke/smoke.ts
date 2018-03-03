import * as yaml from 'js-yaml';
import * as path from 'path';
import * as vscode from 'vscode';

import {CMakeTools} from '../src/cmake-tools';
import {fs} from '../src/pr';

interface RunSetKit {
  type: 'setKit';
  kit?: string;
}

interface RunConfigure {
  type: 'configure';
  ok: boolean;
}

interface RunBuild {
  type: 'build';
        ok: boolean;
}

type TestRunSpecItem = (RunConfigure|RunSetKit|RunBuild);

interface TestSpec {
  run: TestRunSpecItem[];
}

async function getCMakeTools(): Promise<CMakeTools> {
  const ext = vscode.extensions.getExtension<CMakeTools>('vector-of-bool.cmake-tools');
  console.assert(ext, 'Extension not present??');
  return ext!.activate();
}

class CMakeToolsSmokeTestRunner {
  run(_testRunDir: string, cb: (val: Error|null) => void) {
    const testDirectory = process.env['CMT_SMOKE_DIR']!;
    console.log('Tests ran in', testDirectory, yaml);
    this.asyncRun(testDirectory)
        .then(() => {
          console.log('<<CTEST-PASS-COOKIE d0a0da84-3463-4a9a-9d06-185043365aaa>>');
          cb(null);
        })
        .catch((e: Error) => {
          console.log('<<CTEST-FAIL-COOKIE c2ec4143-1c63-43ea-80e8-29c1abb2956b>>');
          console.error('Test failed', e);
          cb(e);
        });
  }

  async readTestSpec(testDir: string): Promise<TestSpec> {
    const test_spec_content = await fs.readFile(path.join(testDir, 'cmt-smoke.yaml'));
    return yaml.load(test_spec_content.toString()) as TestSpec;
  }

  async asyncRun(testDir: string): Promise<void> {
    const spec = await this.readTestSpec(testDir);
    const cmt = await getCMakeTools();
    for (const run of spec.run) {
      await this.runOne(cmt, run);
    }
  }

  async runOne(cmt: CMakeTools, run: TestRunSpecItem): Promise<void> {
    switch (run.type) {
    case 'setKit':
      return this.doSetKit(cmt, run);
    case 'configure':
      return this.doConfigure(cmt, run);
    case 'build': return this.doBuild(cmt, run);
    default:
      throw new Error(`Invalid run type in test specification "${(run as any).type}"`);
    }
  }

  async doSetKit(cmt: CMakeTools, run: RunSetKit): Promise<void> {
    await cmt.privSetKit(run.kit);
  }

  async doConfigure(cmt: CMakeTools, conf: RunConfigure) {
    const res = await cmt.configure();
    if (conf.ok && res != 0) {
      throw new Error(`Expected CMake configure to succeed, but it failed.`);
    } else if (!conf.ok && res == 0) {
      throw new Error(`Expected CMake configure to fail, but it did succeeded`);
    }
    // All good
  }

  async doBuild(cmt: CMakeTools, build: RunBuild) {
      const res = await cmt.build();
      if (build.ok && res != 0) {
          throw new Error(`Expected CMake buidl to succeed, but it failed.`);
      } else if (!build.ok && res == 0) {

      throw new Error(`Expected CMake build to fail, but it did succeeded`);
      }
  }
};

const runner = new CMakeToolsSmokeTestRunner();

module.exports = runner;
