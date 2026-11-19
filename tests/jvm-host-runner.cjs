const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** 隔离VS Code宿主中执行真实JVM attach/断点/变量/求值/单步；jvm-vscode-host.test.js设置前置并断言结果。 */
exports.run = async function run() {
  const vscode = require('vscode');
  const resultFile = process.env.JVM_HOST_RESULT;
  const source = path.join(process.env.JVM_HOST_WORKSPACE, 'DebugMain.java');
  const events = [], waiters = [], registrations = [];
  let session, child, tracker, startListener;
  const take = predicate => {
    const index = events.findIndex(predicate);
    if (index >= 0) return Promise.resolve(events.splice(index, 1)[0]);
    return new Promise(resolve => waiters.push({ predicate, resolve }));
  };
  try {
    const extension = vscode.extensions.getExtension('liangjunheng.vscode-android-ide');
    if (!extension) throw new Error('Extension development host did not load Android Tools');
    await extension.activate();
    const settings = vscode.workspace.getConfiguration('android-ide.jvmDebugger');
    if (settings.get('adapterJvmArgs')?.[0] !== '-Xmx512m') throw new Error('JVM extension-owned settings were not registered');
    const debuggerTypes = vscode.extensions.all.flatMap(item => item.packageJSON.contributes?.debuggers ?? []).map(item => item.type);
    if (!debuggerTypes.includes('kotlin-jvm')) throw new Error('kotlin-jvm contribution is absent');
    const launchFile = vscode.Uri.file(path.join(process.env.JVM_HOST_WORKSPACE, '.vscode', 'launch.json'));
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(launchFile.fsPath)));
    const launchText = '{\n  "version": "0.2.0",\n  "configurations": [\n    \n  ]\n}\n';
    await vscode.workspace.fs.writeFile(launchFile, Buffer.from(launchText));
    const launchDocument = await vscode.workspace.openTextDocument(launchFile);
    const launchEditor = await vscode.window.showTextDocument(launchDocument);
    const position = new vscode.Position(3, 4);
    const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', launchFile, position);
    const names = ['Native', 'JVM', 'Dual(Native and JVM)'].flatMap(mode => ['Launch', 'Attach'].map(request => 'Android: Android ' + mode + ' Debug ' + request));
    for (const name of names) {
      const completion = completions.items.find(item => (typeof item.label === 'string' ? item.label : item.label.label) === name);
      if (!completion || !(completion.insertText instanceof vscode.SnippetString)) throw new Error('Android Add Configuration template is absent: ' + name);
      fs.appendFileSync(resultFile + '.templates.jsonl', JSON.stringify({ name, snippet: completion.insertText.value }) + '\n');
      await launchEditor.edit(edit => edit.replace(new vscode.Range(0, 0, launchDocument.lineCount, 0), launchText));
      await launchEditor.insertSnippet(completion.insertText, position);
      const inserted = JSON.parse(launchDocument.getText()).configurations[0];
      if (inserted.type !== 'android-debug' || inserted.request !== (name.endsWith('Attach') ? 'attach' : 'launch')) throw new Error('Android template inserts an invalid request: ' + name);
      for (const value of [inserted.apkPath, ...(inserted.native?.symbolSearchPaths ?? []), ...(inserted.java?.sourcePaths ?? [])].filter(Boolean)) {
        if (value.includes('^"') || value.includes('\\${') || !value.startsWith('${workspaceFolder}/app/')) throw new Error('Android template corrupts launch.json variable: ' + value);
      }
      if (inserted.request === 'attach' && inserted.processId !== '${command:android-tools.pickAndroidProcess}') throw new Error('Android template corrupts the process picker variable: ' + inserted.processId);
      if (inserted.request === 'launch' && inserted.apkPath !== '${workspaceFolder}/app/build/outputs/apk/debug/app-debug.apk') throw new Error('Android template corrupts the APK path');
      if (inserted.native && inserted.native.symbolSearchPaths[0] !== '${workspaceFolder}/app/build/intermediates/merged_native_libs/debug/mergeDebugNativeLibs/out/lib/${command:abi}/') throw new Error('Android template corrupts the Native ABI variable');
      if (inserted.java && inserted.java.sourcePaths[0] !== '${workspaceFolder}/app/src/main/java') throw new Error('Android template corrupts the JVM source path');
      fs.appendFileSync(resultFile + '.inserted.jsonl', JSON.stringify({ name, configuration: inserted }) + '\n');
    }
    registrations.push('six-configuration-templates');
    const java = process.env.JVM_HOST_JAVA;
    child = spawn(java, ['-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0', '-cp', path.dirname(source), 'DebugMain'], { windowsHide: true });
    const port = await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = /Listening for transport dt_socket at address: (\d+)/.exec(output);
        if (match) resolve(Number(match[1]));
      });
      child.once('error', reject);
      child.once('exit', code => reject(new Error('debuggee exited before JDWP ready: ' + code)));
    });
    tracker = vscode.debug.registerDebugAdapterTrackerFactory('kotlin-jvm', {
      createDebugAdapterTracker(candidate) {
        if (candidate.name !== 'JVM migration host') return;
        session = candidate;
        return { onDidSendMessage(message) {
          fs.appendFileSync(resultFile + '.dap.jsonl', JSON.stringify(message) + '\n');
          if (message.type !== 'event') return;
          const waiter = waiters.find(value => value.predicate(message));
          if (waiter) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
          else events.push(message);
        } };
      }
    });
    const document = await vscode.workspace.openTextDocument(source);
    await vscode.window.showTextDocument(document);
    await vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(source), new vscode.Position(3, 0)))]);
    await vscode.commands.executeCommand('workbench.view.debug');
    const started = new Promise(resolve => {
      startListener = vscode.debug.onDidStartDebugSession(candidate => {
        if (candidate.name === 'JVM migration host') { session = candidate; resolve(); }
      });
    });
    if (!await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
      type: 'kotlin-jvm', request: 'attach', name: 'JVM migration host', hostName: '127.0.0.1', port,
      projectRoot: path.dirname(source), sourcePaths: [path.dirname(source)], timeout: 5000,
    })) throw new Error('startDebugging returned false');
    await started;
    const stopped = await take(message => message.event === 'stopped');
    if (stopped.body.reason !== 'breakpoint') throw new Error('Expected breakpoint stop, got ' + stopped.body.reason);
    const threadId = stopped.body.threadId;
    const stack = await session.customRequest('stackTrace', { threadId });
    const frame = stack.stackFrames[0];
    if (frame.line !== 4 || path.resolve(frame.source.path).toLowerCase() !== path.resolve(source).toLowerCase()) throw new Error('Source frame mismatch: ' + JSON.stringify(frame));
    const scopes = await session.customRequest('scopes', { frameId: frame.id });
    const variables = (await Promise.all(scopes.scopes.map(scope => session.customRequest('variables', { variablesReference: scope.variablesReference })))).flatMap(value => value.variables);
    if (variables.find(value => value.name === 'value')?.value !== '41') throw new Error('Expected value=41: ' + JSON.stringify(variables));
    const evaluated = await session.customRequest('evaluate', { frameId: frame.id, expression: 'value + 1', context: 'watch' });
    if (evaluated.result !== '42') throw new Error('Expression result mismatch: ' + JSON.stringify(evaluated));
    await session.customRequest('next', { threadId });
    await take(message => message.event === 'stopped' && message.body.reason === 'step');
    registrations.push('kotlin-jvm', 'source-breakpoint', 'stack', 'variables=41', 'evaluate=42', 'step');
    await vscode.debug.stopDebugging(session);
    fs.writeFileSync(resultFile, JSON.stringify({ success: true, checks: registrations }));
  } catch (error) {
    fs.writeFileSync(resultFile, JSON.stringify({ success: false, error: String(error.stack ?? error) }));
    throw error;
  } finally {
    tracker?.dispose(); startListener?.dispose();
    if (session) await vscode.debug.stopDebugging(session);
    if (child) child.kill();
  }
};
