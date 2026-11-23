/**
 * 功能点：移除 Coordinator 后的构建与许可发布边界。
 * 受影响对象：build-jvm-debugger 的导出、命令入口及 JVM/Gradle 许可复制。
 * 复现路径：Node>=22，读取并加载构建模块，不调用构建入口，不读取历史服务资源。
 * 测试范围：已删除服务不构建、不收集许可、不导出死代码；保留两个现役产物的许可发布。
 * 执行入口：node --test tests/coordinator-license.test.js；也由 npm test 发现。
 * 预期结果：模块无 Coordinator 依赖，保留上游 LICENSE 与 Gradle 原文许可。
 * 判据：所有断言通过；出现服务引用、死代码导出或丢失现役许可复制均失败。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const buildPath = path.resolve(__dirname, '../scripts/build-jvm-debugger.cjs');

// 仅加载导出，不触发 Maven、Java、网络或资源修改。
test('build no longer depends on the deleted coordinator or its legal collectors', () => {
  const source = fs.readFileSync(buildPath, 'utf8');
  assert.doesNotMatch(source, /coordinator/i);
  assert.doesNotMatch(source, /legalKind|readJarLegalFiles|readPublishedLegalFile|collectCoordinatorLegalFiles|writeCoordinatorLegalFiles/);
  assert.doesNotMatch(source, /copy-dependencies|includeScope=runtime|mdep\.useRepositoryLayout/);
  assert.deepEqual(Object.keys(require(buildPath)).sort(), ['build', 'findMaven', 'findJavaHome', 'MAVEN_VERSION', 'MAVEN_SHA512', 'OUTPUT'].sort());
});

// 两个现役产物的许可仍必须随构建发布，原文不得被服务许可替代。
test('build retains adapter and Gradle tooling license publication', () => {
  const source = fs.readFileSync(buildPath, 'utf8');
  assert.match(source, /copyFile\(path\.join\(UPSTREAM, 'LICENSE'\), path\.join\(path\.dirname\(OUTPUT\), 'LICENSE'\)\)/);
  assert.match(source, /Tooling API SLF4J license missing/);
  assert.match(source, /'resources', 'licenses', 'Apache-2\.0', 'legalcode\.txt'/);
  assert.match(source, /'resources', 'gradle-tooling-LICENSE\.txt'/);
  assert.match(source, /\(await slf4jLicense\.buffer\(\)\)\.toString\('utf8'\)/);
});
