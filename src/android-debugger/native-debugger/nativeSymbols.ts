import * as fs from "node:fs";
import * as path from "node:path";
export type NativeSymbolAbi = "arm64-v8a" | "armeabi-v7a" | "x86" | "x86_64";
export interface NativeSymbolRequest {
  projectRoot: string;
  moduleRoot: string;
  variant: string;
  abi: NativeSymbolAbi;
  sourceMapping?: Array<{ from: string; to: string }>;
}
export interface NativeSymbolResult {
  symbolFiles: string[];
  symbolDirs: string[];
  compileCommands?: string;
  sourceMap?: Record<string, string>;
}
const MACHINES: Record<NativeSymbolAbi, [number, number]> = {
  "arm64-v8a": [2, 183],
  "armeabi-v7a": [1, 40],
  x86: [1, 3],
  x86_64: [2, 62],
};
/** 校验选定项目根、变体、ABI及显式映射；无效输入立即抛错。回归：node --test tests/android-native-symbols.test.js 的 invalid selection 用例断言拒绝无效元组。 */
function validate(r: NativeSymbolRequest): void {
  if (!r || typeof r !== "object")
    throw new Error("Native symbol request is required");
  for (const k of ["projectRoot", "moduleRoot"] as const) {
    if (!path.isAbsolute(r[k]) || !fs.statSync(r[k]).isDirectory())
      throw new Error("Invalid " + k);
  }
  const p = fs.realpathSync(r.projectRoot),
    m = fs.realpathSync(r.moduleRoot);
  if (m !== p && !m.startsWith(p + path.sep))
    throw new Error("moduleRoot is outside projectRoot");
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(r.variant))
    throw new Error("Invalid selected variant");
  if (!Object.hasOwn(MACHINES, r.abi)) throw new Error("Invalid process ABI");
  for (const x of r.sourceMapping || [])
    if (
      !x ||
      !path.isAbsolute(x.from) ||
      !path.isAbsolute(x.to) ||
      /[\x00-\x1f\x7f]/.test(x.from + x.to)
    )
      throw new Error("Invalid source mapping");
}
/** 读取对象形状 JSON；损坏数据及读取异常保留诊断。回归：node --test tests/android-native-symbols.test.js 的 malformed JSON 和 IO errors 用例断言明确失败。 */
function json(f: string): any {
  let v: unknown;
  try {
    v = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    throw new Error("Invalid JSON metadata " + f + ": " + String(e));
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid JSON metadata object: " + f);
  return v;
}
/** 对元数据路径先显式重定位，再检查词法及真实项目归属，返回规范路径。回归：node --test tests/android-native-symbols.test.js 的 ownership/explicit relocation 用例拒绝外部、缺失外部、链接逃逸并接受真实重定位。 */
function owned(
  value: string,
  root: string,
  maps: Array<{ from: string; to: string }>,
): string {
  let c = path.resolve(value);
  for (const x of maps) {
    const f = path.resolve(x.from);
    if (c === f || c.startsWith(f + path.sep)) {
      c = path.resolve(x.to, path.relative(f, c));
      break;
    }
  }
  const rr = fs.realpathSync(root);
  if (c !== rr && !c.startsWith(rr + path.sep))
    throw new Error("Metadata path is outside selected project: " + value);
  if (!fs.existsSync(c)) return c;
  const real = fs.realpathSync(c);
  if (real !== rr && !real.startsWith(rr + path.sep))
    throw new Error("Metadata path is outside selected project: " + value);
  return real;
}
/** 枚举模块各变体目录的指定 ABI 模型；身份由调用方按元数据筛选。回归：node --test tests/android-native-symbols.test.js 的 selected variant 用例使用不匹配目录名并断言多模型歧义。 */
function models(
  moduleRoot: string,
  variant: string,
  abi: NativeSymbolAbi,
): string[] {
  const base = path.join(moduleRoot, "build", "intermediates", "cxx");
  if (!fs.existsSync(base)) return [];
  const out: string[] = [];
  for (const vd of fs.readdirSync(base)) {
    const vp = path.join(base, vd);
    if (!fs.statSync(vp).isDirectory()) continue;
    for (const h of fs.readdirSync(vp)) {
      const f = path.join(vp, h, "logs", abi, "build_model.json");
      if (fs.existsSync(f)) out.push(f);
    }
  }
  return out;
}
/** 为AGP发现和适配器显式目录共同校验指定ABI的完整ELF32/64头、节表、名称及调试节；无返回值，损坏或剥离时抛错，NOBITS不要求文件字节。adapter.test.js显式目录回归及回归：node --test tests/android-native-symbols.test.js 的 ELF32、NOBITS、truncated headers 用例经公共入口断言接受有效库并拒绝损坏/剥离库。 */
export function validateNativeSymbolFile(file: string, abi: NativeSymbolAbi): void {
  const b = fs.readFileSync(file),
    e = MACHINES[abi];
  if (
    b.length < (e[0] === 2 ? 64 : 52) ||
    b.readUInt32BE(0) !== 0x7f454c46 ||
    b[5] !== 1 ||
    b[4] !== e[0] ||
    b.readUInt16LE(18) !== e[1]
  )
    throw new Error("Invalid or mismatched ELF symbol file: " + file);
  const is64 = b[4] === 2,
    min = is64 ? 64 : 40,
    read = (o: number) =>
      is64 ? Number(b.readBigUInt64LE(o)) : b.readUInt32LE(o),
    shoff = read(is64 ? 40 : 32),
    ents = b.readUInt16LE(is64 ? 58 : 46),
    num = b.readUInt16LE(is64 ? 60 : 48),
    stridx = b.readUInt16LE(is64 ? 62 : 50);
  if (
    !Number.isSafeInteger(shoff) ||
    ents < min ||
    !num ||
    stridx >= num ||
    shoff + ents * num > b.length
  )
    throw new Error("Invalid ELF section table: " + file);
  const ss: any[] = [];
  for (let i = 0; i < num; i++) {
    const o = shoff + i * ents,
      n = b.readUInt32LE(o),
      type = b.readUInt32LE(o + 4),
      off = read(o + (is64 ? 24 : 16)),
      size = read(o + (is64 ? 32 : 20));
    if (
      !Number.isSafeInteger(off) ||
      !Number.isSafeInteger(size) ||
      (type !== 8 && off + size > b.length)
    )
      throw new Error("Invalid ELF section bounds: " + file);
    ss.push({ n, type, off, size });
  }
  const st = ss[stridx],
    names = b.subarray(st.off, Math.min(b.length, st.off + st.size));
  if (st.type !== 3) throw new Error("Invalid ELF section names: " + file);
  const found = new Set<string>();
  for (const s of ss) {
    if (s.n >= names.length)
      throw new Error("Invalid ELF section name index: " + file);
    const end = names.indexOf(0, s.n);
    if (end < 0)
      throw new Error("Invalid ELF section name termination: " + file);
    found.add(names.subarray(s.n, end).toString());
  }
  if (
    ![...found].some((x) =>
      /^\.(?:zdebug_|debug_)(?:info|line|abbrev|str)/.test(x),
    )
  )
    throw new Error("Stripped ELF has no DWARF debug sections: " + file);
}
/** 按选定项目/变体/ABI读取 AGP 运行时产物，返回已验证符号与映射；静态 .a 是链接输入，其 DWARF 属于最终共享库，不独立作为进程模块加载。歧义、越界和无有效运行时产物仍抛错。回归：node --test tests/android-native-symbols.test.js，static archive inputs 及全部公共入口断言身份、输出与错误。 */
export function discoverNativeSymbols(
  r: NativeSymbolRequest,
): NativeSymbolResult {
  validate(r);
  const root = fs.realpathSync(r.projectRoot),
    module = fs.realpathSync(r.moduleRoot),
    maps = r.sourceMapping || [],
    selected: any[] = [], staleErrors: Error[] = [];
  for (const mf of models(module, r.variant, r.abi)) {
    const m = json(mf),
      v = m.variant,
      mod = v?.module;
    if (m.info?.name !== r.abi ||
      String(v?.variantName || "").toLowerCase() !== r.variant.toLowerCase() ||
      mod?.buildSystem !== "CMAKE")
      continue;
    let mr: string;
    try {
      mr = owned(mod?.moduleRootFolder || "", root, maps);
    } catch (error) {
      // AGP 保留的旧 CXX 模型可能来自已迁移的项目根；暂存冲突，只有发现当前候选时才忽略。
      if (maps.length === 0 && String(error instanceof Error ? error.message : error).startsWith("Metadata path is outside selected project:")) {
        staleErrors.push(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      throw error;
    }
    if (
      String(v?.variantName || "").toLowerCase() !== r.variant.toLowerCase() ||
      mr !== module ||
      mod?.buildSystem !== "CMAKE"
    )
      continue;
    selected.push({ m, mf });
  }
  if (selected.length !== 1) {
    if (!selected.length && staleErrors.length) throw staleErrors[0];
    throw new Error(
      selected.length
        ? "Ambiguous native build metadata for selected module/variant/ABI"
        : "Selected native build metadata is unavailable for module/variant/ABI",
    );
  }
  const model = selected[0].m,
    build = owned(model.cxxBuildFolder || "", root, maps),
    gradle = path.join(build, "android_gradle_build.json");
  const md = json(gradle),
    libs = md.libraries;
  if (!libs || typeof libs !== "object")
    throw new Error("Selected native metadata has no libraries");
  const outs: string[] = [];
  for (const [id, l] of Object.entries(libs) as any) {
    if (!l || typeof l !== "object" || typeof l.abi !== "string")
      throw new Error("Malformed native library metadata: " + id);
    // AGP metadata can contain header-only/interface artifacts with artifactName but no output.
    if (l.output === undefined && typeof l.artifactName === "string") continue;
    if (typeof l.output !== "string")
      throw new Error("Malformed native library metadata: " + id);
    if (l.abi === r.abi) {
      const output = owned(l.output, root, maps);
      if (path.extname(output) !== ".a") outs.push(output);
    }
  }
  const unique = [...new Set(outs)];
  if (!unique.length)
    throw new Error(
      "Selected native metadata has no ABI-matching library output",
    );
  for (const f of unique) {
    if (!fs.existsSync(f) || !fs.statSync(f).isFile())
      throw new Error("Native symbol file is unavailable: " + f);
    validateNativeSymbolFile(f, r.abi);
  }
  const db = path.join(build, "compile_commands.json"),
    res: NativeSymbolResult = {
      symbolFiles: unique,
      symbolDirs: [...new Set(unique.map(path.dirname))],
    };
  if (fs.existsSync(db)) res.compileCommands = db;
  if (maps.length)
    res.sourceMap = Object.fromEntries(
      maps.map((x) => [path.resolve(x.from), path.resolve(x.to)]),
    );
  return res;
}
