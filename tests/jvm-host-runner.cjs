const fs = require('node:fs');
const path = require('node:path');

/** 在独立VS Code宿主中验证真实扩展注册Android配置模板，不操作设备或桌面JVM。 */
exports.run = async function run() {
  const vscode = require('vscode');
  const resultFile = process.env.JVM_HOST_RESULT;
  const checks = [];
  try {
    const extension = vscode.extensions.getExtension('liangjunheng.vscode-android-ide');
    if (!extension) throw new Error('Extension development host did not load Android Tools');
    await extension.activate();
    const debuggerTypes = vscode.extensions.all.flatMap(item => item.packageJSON.contributes?.debuggers ?? []).map(item => item.type);
    if (!debuggerTypes.includes('android-jvm')) throw new Error('android-jvm contribution is absent');
    const launchFile = vscode.Uri.file(path.join(process.env.JVM_HOST_WORKSPACE, '.vscode', 'launch.json'));
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(launchFile.fsPath)));
    const launchText = '{\n  "version": "0.2.0",\n  "configurations": [\n    \n  ]\n}\n';
    await vscode.workspace.fs.writeFile(launchFile, Buffer.from(launchText));
    const launchDocument = await vscode.workspace.openTextDocument(launchFile);
    const launchEditor = await vscode.window.showTextDocument(launchDocument);
    const position = new vscode.Position(3, 4);
    const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', launchFile, position);
    const names = ['Native', 'JVM', 'Dual(Native and JVM)'].flatMap(mode => ['Launch', 'Attach'].map(request => 'Android: ' + mode + ' Debug ' + request));
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
    checks.push('six-configuration-templates');
    fs.writeFileSync(resultFile, JSON.stringify({ success: true, checks }));
  } catch (error) {
    fs.writeFileSync(resultFile, JSON.stringify({ success: false, error: String(error.stack ?? error) }));
    throw error;
  }
};
