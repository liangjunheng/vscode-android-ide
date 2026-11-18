const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const NOTICE_NAME = /^(?:LICENSE|LICENCE|NOTICE|COPYING)(?:[.-][A-Za-z0-9_-]+)?$/i;
const README_NAME = /^README(?:[.-].+)?$/i;

/** 从根 README 截取明确的 Markdown License 章节。输入：README 完整文本和 package.json SPDX 标识；输出：包含 SPDX 标识的完整章节文本，或 null；条件：只接受 License 标题及其章节正文，拒绝 URL-only/普通说明；回归：bundled-notices.test.js 覆盖 README 内嵌 MIT 与 URL-only 失败。 */
function embeddedLicenseSection(text, license) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const heading = /^(#{1,6})\s+license\s*#?\s*$/i;
  const start = lines.findIndex(line => heading.test(line));
  if (start < 0) return null;
  const level = lines[start].match(heading)[1].length;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const next = lines[index].match(/^(#{1,6})\s+/);
    if (next && next[1].length <= level) {
      end = index;
      break;
    }
  }
  const section = lines.slice(start, end).join('\n').trim();
  if (!section || /^https?:\/\/\S+$/i.test(section)) return null;
  const token = String(license).trim();
  if (token !== 'MIT' || !section.includes('(MIT)') || !/copyright/i.test(section)) return null;
  const grant = section.slice(section.indexOf('Permission is hereby granted')).replace(/\s+/g, ' ').trim();
  const completeMit = 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.';
  if (grant !== completeMit) return null;
  return section + '\n';
}
/** 比较两个稳定排序键。输入：两个字符串；输出：供 Array.sort 使用的三态整数；回归：bundled-notices.test.js 断言包与通知顺序。 */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
/** 判断子路径是否位于父路径内。输入：已解析的 child 与 parent；输出：布尔值；条件：调用方先完成 realpath；回归：bundled-notices.test.js 覆盖路径越界失败。 */
function within(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
/** 解析并校验文件系统路径。输入：候选路径、允许的父目录和错误标签；输出：安全 realpath；条件：目标必须存在且位于 node_modules realpath 内，否则抛错；回归：bundled-notices.test.js 覆盖路径逃逸。 */
function realpathInside(candidate, parent, label) {
  const resolved = fs.realpathSync(candidate);
  if (!within(resolved, parent)) {
    throw new Error(label + ' escapes the allowed project node_modules directory: ' + candidate);
  }
  return resolved;
}
/** 从 esbuild 输入路径识别最后一个 node_modules 下的包段。输入：metafile.inputs 键；输出：普通或作用域包的路径段，无法识别时为 null；条件：支持 Windows 分隔符和嵌套依赖；回归：bundled-notices.test.js 覆盖 scoped/nested 输入。 */
function packageNameFromInput(input) {
  const segments = input.replaceAll('\\', '/').split('/');
  let nodeModulesIndex = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].toLowerCase() === 'node_modules') {
      nodeModulesIndex = index;
      break;
    }
  }
  if (nodeModulesIndex < 0 || !segments[nodeModulesIndex + 1]) return null;
  const first = segments[nodeModulesIndex + 1];
  if (first.startsWith('@')) {
    return segments[nodeModulesIndex + 2] ? { packageSegments: [first, segments[nodeModulesIndex + 2]] } : null;
  }
  return { packageSegments: [first] };
}
/** 提取可审计的许可证标识。输入：package.json 的 license 值；输出：非空且非 URL 字符串，或 null；条件：允许 SPDX 和 {type}，拒绝 URL 猜测；回归：bundled-notices.test.js 覆盖 URL-only metadata。 */
function usableLicense(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    return text && !/^https?:\/\/\S+$/i.test(text) ? text : null;
  }
  if (value && typeof value === 'object' && typeof value.type === 'string') return usableLicense(value.type);
  return null;
}
/** 读取单个包的元数据及根许可证/通知文件。输入：已安全解析的包根；输出：包索引字段和完整正文；条件：metadata 与至少一个非空非 URL 根文件必须有效，否则抛错；回归：bundled-notices.test.js 覆盖完整文本、哈希和失败闭包。 */
function readPackage(packageRoot) {
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const metadata = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const name = metadata && typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name.trim() : null;
  const version = metadata && typeof metadata.version === 'string' && metadata.version.trim() ? metadata.version.trim() : null;
  const license = metadata && usableLicense(metadata.license);
  if (!name || !version || !license) {
    throw new Error('Package has no usable name, version, or license metadata: ' + packageJsonPath);
  }
  const notices = [];
  for (const entry of fs.readdirSync(packageRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !NOTICE_NAME.test(entry.name)) continue;
    const filePath = path.join(packageRoot, entry.name);
    const bytes = fs.readFileSync(filePath);
    const text = bytes.toString('utf8');
    if (!text.trim() || /^https?:\/\/\S+$/i.test(text.trim())) continue;
    notices.push({
      file: entry.name.replaceAll('\\', '/'),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      text
    });
  }
  if (!notices.length) {
    const readmeEntry = fs.readdirSync(packageRoot, { withFileTypes: true }).find(entry => entry.isFile() && README_NAME.test(entry.name));
    if (readmeEntry) {
      const readmePath = path.join(packageRoot, readmeEntry.name);
      const readmeBytes = fs.readFileSync(readmePath);
      const section = embeddedLicenseSection(readmeBytes.toString('utf8'), license);
      if (section) {
        const sectionBytes = Buffer.from(section, 'utf8');
        notices.push({
          file: readmeEntry.name + '#License',
          sha256: crypto.createHash('sha256').update(sectionBytes).digest('hex'),
          sourceSha256: crypto.createHash('sha256').update(readmeBytes).digest('hex'),
          text: section
        });
      }
    }
  }
  if (!notices.length) {
    throw new Error('Package has no usable license or notice text: ' + packageJsonPath);
  }
  notices.sort((a, b) => compare(a.file, b.file));
  return {
    name,
    version,
    license,
    notices: notices.map(({ file, sha256, sourceSha256 }) => sourceSha256 ? { file, sha256, sourceSha256 } : { file, sha256 }),
    body: notices.map(notice => '### ' + notice.file + '\n\n' + notice.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '')).join('\n\n')
  };
}
/** 汇总一个或多个 esbuild metafile 的输入键。输入：单个 metafile 或数组；输出：所有 inputs 键数组；条件：每项必须有对象 inputs，缺失即抛错，不读取顶层依赖列表；回归：bundled-notices.test.js 通过多入口重复键验证闭包收集。 */
function collectInputs(metafiles) {
  const list = Array.isArray(metafiles) ? metafiles : [metafiles];
  const inputs = [];
  for (const metafile of list) {
    if (!metafile || typeof metafile !== 'object' || !metafile.inputs || typeof metafile.inputs !== 'object') {
      throw new TypeError('Each metafile must contain an inputs object');
    }
    inputs.push(...Object.keys(metafile.inputs));
  }
  return inputs;
}
/** 职责：从 esbuild metafile.inputs 实际输入闭包生成通知清单和依赖索引。输入：绝对项目根 root 与一个或多个含 inputs 的 metafile，不读取环境变量或顶层依赖列表。输出：按包名/版本和文件稳定排序的 text 与 packages，文件保留完整文本并计算 SHA-256。条件：输入包须在 root/node_modules 的 realpath 内，package.json 须有可用元数据及非 URL 的完整文本，失败即抛错。回归：node --test tests/bundled-notices.test.js 覆盖作用域/嵌套、去重排序、闭包排除、哈希和安全错误。 */
function buildBundledNotices(root, metafiles) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('root must be an absolute project path');
  const projectRoot = fs.realpathSync(root);
  const nodeModules = realpathInside(path.join(projectRoot, 'node_modules'), projectRoot, 'node_modules');
  const packages = new Map();
  for (const input of collectInputs(metafiles)) { if (/^(?:node:|vscode(?:$|\/)|\x00)/i.test(input)) continue;
  const parsed = packageNameFromInput(input); if (!parsed) continue;
  const lexical = path.isAbsolute(input) ? input : path.resolve(projectRoot, input);
  const inputPath = realpathInside(lexical, nodeModules, 'metafile input');
  const normalized = inputPath.split(path.sep).join('/');
  const marker = '/node_modules/';
  const markerIndex = normalized.toLowerCase().lastIndexOf(marker); if (markerIndex < 0) throw new Error('Metafile input is outside node_modules: ' + input);
  const base = inputPath.slice(0, markerIndex + marker.length);
  const packageRoot = realpathInside(path.join(base, ...parsed.packageSegments), nodeModules, 'package root'); if (!packages.has(packageRoot)) packages.set(packageRoot, readPackage(packageRoot)); }
  const entries = [...packages.values()].sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version));
  const text = entries.map(e => '## ' + e.name + ' ' + e.version + '\n\nLicense: ' + e.license + '\n\n' + e.body).join('\n\n');
  return { text: text ? text + '\n' : '', packages: entries.map(({ name, version, license, notices }) => ({ name, version, license, notices })) };
}
module.exports = { buildBundledNotices };