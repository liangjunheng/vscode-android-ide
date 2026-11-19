const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

/** 使用独立用户目录及本地fixture启动真实VS Code，不安装插件、不操作设备；JVM_VSCODE_HOST_TEST=1显式执行。 */
test('real VS Code host attaches bundled JVM debugger and verifies Java breakpoint variables evaluate and step', {
  skip: process.env.JVM_VSCODE_HOST_TEST !== '1' && 'Set JVM_VSCODE_HOST_TEST=1 for an isolated desktop host', timeout: 120000,
}, async t => {
  const root = path.resolve(__dirname, '..');
  const artifacts = path.join(root, '.test-artifacts', 'jvm-host');
  fs.mkdirSync(artifacts, { recursive: true });
  const run = fs.mkdtempSync(path.join(artifacts, 'run-'));
  t.diagnostic('Host evidence: ' + run);
  const workspace = path.join(run, 'workspace'), userData = path.join(run, 'user-data');
  fs.mkdirSync(workspace); fs.mkdirSync(userData);
  const javaHome = process.env.JVM_DEBUGGER_JAVA_HOME ?? process.env.JAVA_HOME;
  assert.ok(javaHome, 'JAVA_HOME is required');
  const java = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const javac = path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
  const source = path.join(workspace, 'DebugMain.java');
  fs.writeFileSync(source, 'public class DebugMain {\n  public static void main(String[] args) {\n    int value = 41;\n    value++;\n    System.out.println(value);\n  }\n}\n');
  execFileSync(javac, ['-g', source], { windowsHide: true });
  const code = process.env.VSCODE_PATH ?? path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
  assert.ok(fs.existsSync(code), 'VS Code executable is required');
  const resultFile = path.join(run, 'result.json');
  const env = { ...process.env, JVM_HOST_RESULT: resultFile, JVM_HOST_WORKSPACE: workspace, JVM_HOST_JAVA: java };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_PID', 'VSCODE_CWD']) delete env[key];
  const child = spawn(code, [
    '--user-data-dir', userData, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--disable-extension', 'kparth01.kotlin-debugger', '--disable-extension', 'nisargjhaveri.android-debug',
    '--extensionDevelopmentPath', root, '--extensionTestsPath', path.join(root, 'tests/jvm-host-runner.cjs'), workspace,
  ], { env, windowsHide: false });
  const stderr = []; child.stderr.on('data', chunk => stderr.push(String(chunk)));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  assert.ok(fs.existsSync(resultFile), 'Host produced no result: ' + JSON.stringify(exit) + '\n' + stderr.join(''));
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.success, true, result.error);
  assert.deepEqual(result.checks, ['six-configuration-templates', 'kotlin-jvm', 'source-breakpoint', 'stack', 'variables=41', 'evaluate=42', 'step']);
  assert.equal(exit.code, 0, stderr.join(''));
});
