const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const NOTICE_NAME = /^(?:UNLICENSE|LICENSE|LICENCE|NOTICE|COPYING)(?:[.-][A-Za-z0-9_-]+)?$/i;
const README_NAME = /^README(?:[.-].+)?$/i;
const CC0_DECLARATION = '[Creative Commons Zero v1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/deed)';
const CC0_SOURCE_URL = 'https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt';
const CC_BY_DECLARATION = 'Copyright \u00a9 2010-2015 Linux Foundation and its Contributors. Licensed under the Creative Commons Attribution License 3.0 Unported. All other rights are expressly reserved.';
const SUPPLEMENTAL_SOURCE_URLS = {
  'CC0-1.0': CC0_SOURCE_URL,
  'CC-BY-3.0': 'https://creativecommons.org/licenses/by/3.0/legalcode.txt',
  'WTFPL': 'https://www.wtfpl.net/txt/copying/'
};
const SUPPLEMENTAL_MANIFEST_KEYS = { 'WTFPL': 'WTFPL-2.0' };

/** 从根 README 截取明确的 Markdown License 章节。输入：README 完整文本和 package.json SPDX 标识；输出：与 SPDX 标识精确匹配的完整章节文本，或 null；条件：只接受完整 MIT 正文或精确 CC0 deed 声明，拒绝 URL-only/普通说明；回归：bundled-notices.test.js 覆盖 MIT、CC0 和 URL-only 失败。 */
function embeddedLicenseSection(text, license) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const token = String(license).trim();
  if (token === 'CC-BY-3.0') {
    const normalized = lines.join('\n').replace(/^>\s?/gm, '').replace(/\s+/g, ' ').trim();
    return normalized.includes(CC_BY_DECLARATION) ? '### License\n\n' + CC_BY_DECLARATION + '\n' : null;
  }
  const heading = /^(#{1,6})\s+license\s*#?\s*$/i;
  let start = lines.findIndex(line => heading.test(line));
  let level = start >= 0 ? lines[start].match(heading)[1].length : 0;
  let bodyStart = start >= 0 ? start + 1 : -1;
  if (start < 0) {
    for (let index = 0; index + 1 < lines.length; index += 1) {
      if (/^license\s*$/i.test(lines[index].trim()) && /^(?:=+|-+)\s*$/.test(lines[index + 1])) {
        start = index;
        level = lines[index + 1].trim()[0] === '=' ? 1 : 2;
        bodyStart = index + 2;
        break;
      }
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let index = bodyStart; index < lines.length; index += 1) {
    const next = lines[index].match(/^(#{1,6})\s+/);
    if (next && next[1].length <= level) {
      end = index;
      break;
    }
    if (index + 1 < lines.length && /^.{1,80}$/.test(lines[index]) && /^(?:=+|-+)\s*$/.test(lines[index + 1])) {
      const nextLevel = lines[index + 1].trim()[0] === '=' ? 1 : 2;
      if (nextLevel <= level) {
        end = index;
        break;
      }
    }
  }
  const sectionLines = [lines[start], ...lines.slice(bodyStart, end)];
  // 删除章节末尾的空行和 Markdown 引用定义，避免文档链接尾部污染许可证正文比较。
  while (sectionLines.length > 1) {
    const last = sectionLines.at(-1);
    if (!last.trim() || /^\s*\[[^\]]+\]:\s+\S+\s*$/.test(last)) {
      sectionLines.pop();
      continue;
    }
    break;
  }
  const section = sectionLines.join('\n').trim();
  if (!section || /^https?:\/\/\S+$/i.test(section)) return null;
  const declaration = section.slice(section.indexOf('\n') + 1).trim();
  if (token === 'CC0-1.0' && declaration === CC0_DECLARATION) return section + '\n';
  if (token !== 'MIT' || (!/\((?:MIT|The MIT License)\)/.test(section) && !/\bThe MIT License\b/i.test(section)) || !/copyright/i.test(section)) return null;
  const grant = section.slice(section.indexOf('Permission is hereby granted')).replace(/\s+/g, ' ').trim();
  const completeMit = 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.';
  const normalizedGrant = grant.replaceAll(String.fromCharCode(34), "'");
  const normalizedMit = completeMit.replaceAll(String.fromCharCode(34), "'");
  if (normalizedGrant !== normalizedMit) return null;
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
/** 读取工作区中与 SPDX 标识绑定的补充许可证正文。输入：项目根、包根和 metadata 许可标识；输出：正文、文件哈希、来源 URL/哈希及可选 package-specific 提交证据；条件：清单、canonical URL、正文哈希及 package JSON 身份必须一致，否则抛错；回归：Node>=22执行node --test tests/bundled-notices.test.js；CC0/CC-BY用例及WTFPL package provenance两项断言全文、包身份/输出来源证据，以及metadata哈希、commit/URL、来源SHA拒绝矩阵。 */
function readSupplementalLicense(projectRoot, packageRoot, name, version, license) {
  const sourceUrl = SUPPLEMENTAL_SOURCE_URLS[license];
  if (!sourceUrl) return null;
  const resourcesPath = path.join(projectRoot, 'resources', 'licenses');
  if (!fs.existsSync(resourcesPath)) return null;
  const resourcesRoot = realpathInside(resourcesPath, projectRoot, 'license resources');
  const manifestPath = path.join(resourcesRoot, 'index.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const manifestKey = SUPPLEMENTAL_MANIFEST_KEYS[license] || license;
  const declaration = manifest && manifest[manifestKey];
  if (!declaration || declaration.sourceUrl !== sourceUrl || typeof declaration.file !== 'string' || !/^[a-f0-9]{64}$/.test(declaration.sourceSha256 || '')) {
    throw new Error('Invalid supplemental license declaration: ' + manifestPath);
  }
  const packageDeclaration = declaration.package;
  let packageEvidence = {};
  if (packageDeclaration) {
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageBytes = fs.readFileSync(packageJsonPath);
    const packageSha256 = crypto.createHash('sha256').update(packageBytes).digest('hex');
    if (packageDeclaration.name !== name || packageDeclaration.version !== version || packageDeclaration.license !== license || packageDeclaration.packageJsonSha256 !== packageSha256 || typeof packageDeclaration.sourceCommit !== 'string' || typeof packageDeclaration.packageJsonSourceUrl !== 'string' || packageDeclaration.packageJsonSourceUrl.includes(packageDeclaration.sourceCommit) !== true || !/^[a-f0-9]{64}$/.test(packageDeclaration.packageJsonSourceSha256 || '')) {
      throw new Error('Supplemental package declaration does not match installed metadata: ' + packageJsonPath);
    }
    packageEvidence = { metadataSourceUrl: packageDeclaration.packageJsonSourceUrl, metadataSourceSha256: packageDeclaration.packageJsonSourceSha256, sourceCommit: packageDeclaration.sourceCommit };
  }
  const resourcePath = realpathInside(path.join(resourcesRoot, declaration.file), resourcesRoot, 'license resource');
  const bytes = fs.readFileSync(resourcePath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== declaration.sourceSha256) {
    throw new Error('Supplemental license hash does not match source: ' + resourcePath);
  }
  return {
    file: path.relative(projectRoot, resourcePath).replaceAll('\\', '/'),
    sha256,
    sourceUrl: declaration.sourceUrl,
    sourceSha256: declaration.sourceSha256,
    ...packageEvidence,
    text: bytes.toString('utf8')
  };
}
/** 读取单个包的元数据及根许可证/通知文件。输入：已安全解析的包根和项目根；输出：包索引字段和完整正文；条件：metadata 与至少一个非空非 URL 根文件必须有效，明确 CC0/CC-BY README 声明还必须有哈希绑定补充正文，否则抛错；回归：bundled-notices.test.js 覆盖完整文本、CC0/CC-BY、哈希和失败闭包。 */
function readPackage(packageRoot, projectRoot) {
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const metadata = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const name = metadata && typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name.trim() : null;
  const version = metadata && typeof metadata.version === 'string' && metadata.version.trim() ? metadata.version.trim() : null;
  // 兼容 npm 早期的单项 licenses 数组；多项声明必须显式失败，避免静默丢弃许可证。
  let license = null;
  if (metadata && metadata.license !== undefined) {
    license = usableLicense(metadata.license);
  } else if (metadata && Array.isArray(metadata.licenses)) {
    if (metadata.licenses.length !== 1) {
      throw new Error('Package has multiple license entries; refusing to select one silently: ' + packageJsonPath);
    }
    license = usableLicense(metadata.licenses[0]);
  }
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
        const supplemental = readSupplementalLicense(projectRoot, packageRoot, name, version, license);
        notices.push(supplemental || {
          file: readmeEntry.name + '#License',
          sha256: crypto.createHash('sha256').update(sectionBytes).digest('hex'),
          sourceSha256: crypto.createHash('sha256').update(readmeBytes).digest('hex'),
          text: section
        });
      }
    }
  }
  if (!notices.length) {
    const supplemental = readSupplementalLicense(projectRoot, packageRoot, name, version, license);
    if (supplemental) notices.push(supplemental);
  }
  if (!notices.length) {
    throw new Error('Package has no usable license or notice text: ' + packageJsonPath);
  }
  notices.sort((a, b) => compare(a.file, b.file));
  return {
    name,
    version,
    license,
    notices: notices.map(notice => {
      const entry = { file: notice.file, sha256: notice.sha256 };
      if (notice.sourceSha256) entry.sourceSha256 = notice.sourceSha256;
      if (notice.sourceUrl) entry.sourceUrl = notice.sourceUrl;
      if (notice.metadataSourceUrl) entry.metadataSourceUrl = notice.metadataSourceUrl;
      if (notice.metadataSourceSha256) entry.metadataSourceSha256 = notice.metadataSourceSha256;
      if (notice.sourceCommit) entry.sourceCommit = notice.sourceCommit;
      return entry;
    }),
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
  const packageRoot = realpathInside(path.join(base, ...parsed.packageSegments), nodeModules, 'package root'); if (!packages.has(packageRoot)) packages.set(packageRoot, readPackage(packageRoot, projectRoot)); }
  const entries = [...packages.values()].sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version));
  const text = entries.map(e => '## ' + e.name + ' ' + e.version + '\n\nLicense: ' + e.license + '\n\n' + e.body).join('\n\n');
  return { text: text ? text + '\n' : '', packages: entries.map(({ name, version, license, notices }) => ({ name, version, license, notices })) };
}
module.exports = { buildBundledNotices };