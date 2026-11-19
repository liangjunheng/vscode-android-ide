const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/android-debugger/native-debugger/projectLibraries.ts'), 'utf8');
const moduleObject = { exports: {} };
vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
  module: moduleObject,
  exports: moduleObject.exports,
  require,
  Buffer,
  process,
  console,
});
const { discoverProjectLibraries } = moduleObject.exports;

function writeNumber(buffer, offset, value, size, little) {
  if (size === 2) return little ? buffer.writeUInt16LE(value, offset) : buffer.writeUInt16BE(value, offset);
  if (size === 4) return little ? buffer.writeUInt32LE(value, offset) : buffer.writeUInt32BE(value, offset);
  throw new Error('unsupported integer size');
}

/** 写入包含真实 section header/string table 的 ELF ET_DYN，覆盖 ELF32/64、大小端、机器和 DWARF section 识别。 */
function elf({ bits = 64, little = true, machine = 183, section = '.debug_info' } = {}) {
  const headerSize = bits === 32 ? 52 : 64;
  const sectionSize = bits === 32 ? 40 : 64;
  const strings = Buffer.from(`\0.shstrtab\0${section}\0`, 'ascii');
  const shstrtabName = 1;
  const debugName = 11;
  const sectionTableOffset = headerSize;
  const stringsOffset = sectionTableOffset + sectionSize * 3;
  const total = stringsOffset + strings.length + (section === '.debug_info' || section === '.zdebug_info' ? 1 : 0);
  const output = Buffer.alloc(total);
  output.set(Buffer.from([0x7f, 0x45, 0x4c, 0x46, bits === 32 ? 1 : 2, little ? 1 : 2, 1]), 0);
  writeNumber(output, 16, 3, 2, little);
  writeNumber(output, 18, machine, 2, little);
  if (bits === 32) {
    writeNumber(output, 32, sectionTableOffset, 4, little);
    writeNumber(output, 46, sectionSize, 2, little);
    writeNumber(output, 48, 3, 2, little);
    writeNumber(output, 50, 1, 2, little);
  } else {
    little ? output.writeBigUInt64LE(BigInt(sectionTableOffset), 40) : output.writeBigUInt64BE(BigInt(sectionTableOffset), 40);
    writeNumber(output, 58, sectionSize, 2, little);
    writeNumber(output, 60, 3, 2, little);
    writeNumber(output, 62, 1, 2, little);
  }
  const writeSection = (index, name, offset, size) => {
    const base = sectionTableOffset + index * sectionSize;
    writeNumber(output, base, name, 4, little);
    writeNumber(output, base + 4, 3, 4, little);
    if (bits === 32) {
      writeNumber(output, base + 16, offset, 4, little);
      writeNumber(output, base + 20, size, 4, little);
    } else {
      little ? output.writeBigUInt64LE(BigInt(offset), base + 24) : output.writeBigUInt64BE(BigInt(offset), base + 24);
      little ? output.writeBigUInt64LE(BigInt(size), base + 32) : output.writeBigUInt64BE(BigInt(size), base + 32);
    }
  };
  writeSection(1, shstrtabName, stringsOffset, strings.length);
  writeSection(2, debugName, stringsOffset + strings.length, 1);
  strings.copy(output, stringsOffset);
  output[total - 1] = 0x01;
  return output;
}

function makeTarget({ artifact, sourcePath, sourceRoot, imported = false, generated = false }) {
  return {
    name: path.basename(artifact, '.so'),
    type: 'SHARED_LIBRARY',
    ...(imported ? { isImported: true } : {}),
    compileGroups: [{}],
    sources: [{ path: sourcePath, compileGroupIndex: 0, ...(generated ? { generated: true } : {}) }],
    artifacts: [{ path: artifact }],
    sourceRoot,
  };
}

async function writeJson(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.writeFile(filename, JSON.stringify(value));
}

async function createFixture(t) {
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-libraries-'));
  t.after(() => fsp.rm(project, { recursive: true, force: true }));
  const app = path.join(project, 'app');
  const buildRoot = path.join(app, '.cxx', 'Debug', 'hash', 'arm64-v8a');
  const reply = path.join(buildRoot, '.cmake', 'api', 'v1', 'reply');
  const sourceFile = path.join(app, 'src', 'main', 'cpp', 'good.cpp');
  const generatedFile = path.join(buildRoot, 'generated.cpp');
  await fsp.mkdir(path.dirname(sourceFile), { recursive: true });
  await fsp.mkdir(path.dirname(generatedFile), { recursive: true });
  await fsp.writeFile(sourceFile, 'void good() {}');
  await fsp.writeFile(generatedFile, 'void generated() {}');
  return { project, app, buildRoot, reply, sourceFile, generatedFile };
}

async function addCmake(fixture, targets, { latest = true } = {}) {
  const targetFiles = [];
  for (let index = 0; index < targets.length; index++) {
    const filename = `target-${index}.json`;
    targetFiles.push(filename);
    await writeJson(path.join(fixture.reply, filename), targets[index]);
  }
  const model = path.join(fixture.reply, 'codemodel-v2.json');
  await writeJson(model, {
    paths: { source: fixture.app, build: fixture.buildRoot },
    configurations: [{ targets: targetFiles.map(jsonFile => ({ jsonFile })) }],
  });
  const oldIndex = path.join(fixture.reply, 'index-old.json');
  await writeJson(oldIndex, { objects: [{ kind: 'codemodel', version: { major: 2 }, jsonFile: 'codemodel-old.json' }] });
  await writeJson(path.join(fixture.reply, 'codemodel-old.json'), { paths: { source: fixture.app, build: fixture.buildRoot }, configurations: [] });
  const newest = path.join(fixture.reply, 'index-new.json');
  await writeJson(newest, { objects: [{ kind: 'codemodel', version: { major: 2 }, jsonFile: 'codemodel-v2.json' }] });
  const now = Date.now() / 1000;
  await fsp.utimes(oldIndex, now - 10, now - 10);
  await fsp.utimes(newest, now + (latest ? 10 : -10), now + (latest ? 10 : -10));
}

async function writeSo(filename, options) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.writeFile(filename, elf(options));
}

test('discovers only CMake/ndkBuild project outputs with real DWARF and exact ABI', async t => {
  const fixture = await createFixture(t);
  const good64 = path.join(fixture.buildRoot, 'libgood64.so');
  const good32 = path.join(fixture.buildRoot, 'libgood32.so');
  const goodBe = path.join(fixture.buildRoot, 'libgoodbe.so');
  const wrongAbi = path.join(fixture.buildRoot, 'libwrongabi.so');
  const stripped = path.join(fixture.buildRoot, 'libstripped.so');
  const fakeDebug = path.join(fixture.buildRoot, 'libfake.so');
  const badHeader = path.join(fixture.buildRoot, 'libbad.so');
  const imported = path.join(fixture.buildRoot, 'libimported.so');
  const sourceOutside = path.join(fixture.buildRoot, 'liboutside-source.so');
  const outputOutside = path.join(fixture.project, 'outside.so');
  await writeSo(good64, { bits: 64, little: true, machine: 183 });
  await writeSo(good32, { bits: 32, little: true, machine: 40 });
  await writeSo(goodBe, { bits: 64, little: false, machine: 62 });
  await writeSo(wrongAbi, { bits: 64, little: true, machine: 62 });
  await writeSo(stripped, { section: '.text' });
  await writeSo(fakeDebug, { section: '.text' });
  await fsp.writeFile(badHeader, Buffer.from('ELF .debug_info but no section table'));
  await writeSo(imported, {});
  await writeSo(sourceOutside, {});
  await writeSo(outputOutside, {});
  const targets = [
    makeTarget({ artifact: 'libgood64.so', sourcePath: 'src/main/cpp/good.cpp', sourceRoot: fixture.app }),
    makeTarget({ artifact: 'libgood32.so', sourcePath: 'src/main/cpp/good.cpp', sourceRoot: fixture.app }),
    makeTarget({ artifact: 'libgoodbe.so', sourcePath: 'generated.cpp', sourceRoot: fixture.app, generated: true }),
    makeTarget({ artifact: 'libwrongabi.so', sourcePath: 'src/main/cpp/good.cpp', sourceRoot: fixture.app }),
    makeTarget({ artifact: 'libstripped.so', sourcePath: 'src/main/cpp/good.cpp', sourceRoot: fixture.app }),
    makeTarget({ artifact: 'libfake.so', sourcePath: 'src/main/cpp/good.cpp', sourceRoot: fixture.app }),
    makeTarget({ artifact: 'libbad.so', sourcePath: 'src/main/cpp/good.cpp', sourceRoot: fixture.app }),
    makeTarget({ artifact: 'libimported.so', sourcePath: 'src/main/cpp/good.cpp', sourceRoot: fixture.app, imported: true }),
    makeTarget({ artifact: 'liboutside-source.so', sourcePath: path.join(os.tmpdir(), 'not-project.cpp'), sourceRoot: fixture.app }),
    makeTarget({ artifact: outputOutside, sourcePath: 'src/main/cpp/good.cpp', sourceRoot: fixture.app }),
  ];
  await addCmake(fixture, targets);
  await writeSo(path.join(fixture.app, 'src', 'main', 'jniLibs', 'arm64-v8a', 'libprebuilt.so'), { });
  await writeSo(path.join(fixture.app, 'build', 'outputs', 'apk', 'debug', 'libpackaged.so'), { });
  await writeSo(path.join(fixture.app, '.test-artifacts', 'libignored.so'), { });

  assert.deepEqual(Array.from(await discoverProjectLibraries(fixture.project, 'arm64-v8a')), [await fsp.realpath(good64), await fsp.realpath(imported), await fsp.realpath(sourceOutside)]);
  assert.deepEqual(Array.from(await discoverProjectLibraries(fixture.project)), [await fsp.realpath(good32), await fsp.realpath(good64), await fsp.realpath(goodBe), await fsp.realpath(imported), await fsp.realpath(sourceOutside), await fsp.realpath(wrongAbi)]);
});

test('reads ndkBuild android_gradle_build libraries and never follows output symlinks', async t => {
  const fixture = await createFixture(t);
  const nativeRoot = path.join(fixture.app, 'build', 'intermediates', 'ndkBuild', 'debug', 'arm64-v8a');
  const cmakeRoot = path.join(fixture.app, 'build', 'intermediates', 'cmake', 'debug', 'obj', 'arm64-v8a');
  const cxxRoot = path.join(fixture.app, 'module', 'build', 'intermediates', 'cxx', 'Debug', 'hash', 'obj', 'arm64-v8a');
  const hiddenCxxRoot = path.join(fixture.app, 'module', '.cxx', 'Debug', 'hash', 'arm64-v8a');
  const output = path.join(nativeRoot, 'libndk.so');
  const cmakeOutput = path.join(cmakeRoot, 'libcmake.so');
  const cxxOutput = path.join(cxxRoot, 'libcxx.so');
  const hiddenCxxOutput = path.join(hiddenCxxRoot, 'libhidden-cxx.so');
  await writeSo(output, {}); await writeSo(cmakeOutput, {}); await writeSo(cxxOutput, {}); await writeSo(hiddenCxxOutput, {});
  await writeJson(path.join(nativeRoot, 'android_gradle_build.json'), { libraries: [{ files: [{ src: output }] }], runtimeFiles: [{ src: path.join(nativeRoot, 'runtime.so') }] });
  const external = path.join(fixture.project, 'external.so');
  await writeSo(external, {});
  let symlink;
  try {
    symlink = path.join(nativeRoot, 'libsymlink.so');
    await fsp.symlink(external, symlink);
  } catch (error) {
    symlink = undefined;
  }
  assert.deepEqual(Array.from(await discoverProjectLibraries(fixture.project, 'arm64-v8a')), [await fsp.realpath(cmakeOutput), await fsp.realpath(output), await fsp.realpath(hiddenCxxOutput), await fsp.realpath(cxxOutput)]);
  if (symlink) assert.equal((await discoverProjectLibraries(fixture.project)).includes(await fsp.realpath(symlink)), false);
});

test('uses only the newest CMake index and returns normal missing builds as an empty list', async t => {
  const fixture = await createFixture(t);
  const oldOutput = path.join(fixture.buildRoot, 'libold.so');
  const newOutput = path.join(fixture.buildRoot, 'libnew.so');
  await writeSo(oldOutput, {});
  await writeSo(newOutput, {});
  const oldTarget = makeTarget({ artifact: 'libold.so', sourcePath: 'src/main/cpp/good.cpp', sourceRoot: fixture.app });
  const newTarget = makeTarget({ artifact: 'libnew.so', sourcePath: 'src/main/cpp/good.cpp', sourceRoot: fixture.app });
  await addCmake(fixture, [newTarget]);
  await writeJson(path.join(fixture.reply, 'codemodel-old-only.json'), { paths: { source: fixture.app, build: fixture.buildRoot }, configurations: [{ targets: [{ jsonFile: 'target-old-only.json' }] }] });
  await writeJson(path.join(fixture.reply, 'target-old-only.json'), oldTarget);
  await writeJson(path.join(fixture.reply, 'index-old.json'), { objects: [{ kind: 'codemodel', version: { major: 2 }, jsonFile: 'codemodel-old-only.json' }] });
  const now = Date.now() / 1000;
  await fsp.utimes(path.join(fixture.reply, 'index-old.json'), now - 20, now - 20);
  await fsp.utimes(path.join(fixture.reply, 'index-new.json'), now + 20, now + 20);
  assert.deepEqual(Array.from(await discoverProjectLibraries(fixture.project, 'arm64-v8a')), [await fsp.realpath(newOutput), await fsp.realpath(oldOutput)]);
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-libraries-empty-'));
  t.after(() => fsp.rm(empty, { recursive: true, force: true }));
  assert.deepEqual(Array.from(await discoverProjectLibraries(empty, 'arm64-v8a')), []);
});

test('ignores malformed build metadata and returns only valid ELF DWARF libraries', async t => {
  const fixture = await createFixture(t);
  await fsp.mkdir(fixture.reply, { recursive: true });
  await fsp.writeFile(path.join(fixture.reply, 'index-bad.json'), '{not-json');
  await fsp.utimes(path.join(fixture.reply, 'index-bad.json'), Date.now() / 1000 + 30, Date.now() / 1000 + 30);
  const output = path.join(fixture.buildRoot, 'libvalid.so'); await writeSo(output, {});
  assert.deepEqual(Array.from(await discoverProjectLibraries(fixture.project, 'arm64-v8a')), [await fsp.realpath(output)]);
});
