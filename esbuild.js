const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { buildBundledNotices } = require('./scripts/build-notices.cjs');
const completedMetafiles = new Map();

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  metafile: true,
};

// 内置 debugger 暂时为空实现；保留调试源文件以便恢复，不将其后端加入默认扩展构建。
const builds = [options];
// 汇总当前扩展入口的输入闭包，输出离线许可全文与索引；失败会阻止构建和发布。
function noticesPlugin(entry) {
  return {
    name: 'offline-runtime-notices',
    // 将产物完成回调绑定当前入口；只有全部入口成功后才生成通知，失败使构建/发布失败。
    setup(build) {
      build.onEnd(result => {
        if (result.errors.length) return;
        if (!result.metafile) throw new Error('Missing runtime dependency build metadata: ' + entry);
        completedMetafiles.set(entry, result.metafile);
        if (completedMetafiles.size !== builds.length) return;
        const notices = buildBundledNotices(process.cwd(), [...completedMetafiles.values()]);
        fs.writeFileSync(path.join('dist', 'THIRD_PARTY_NOTICES.txt'), notices.text);
        fs.writeFileSync(path.join('dist', 'runtime-js-dependencies.json'), JSON.stringify({ schemaVersion: 1, packages: notices.packages }, null, 2));
      });
    },
  };
}
// 扩展入口拥有独立构建上下文；compile/watch覆盖扩展及许可文本，任何失败使发布失败。
Promise.all(builds.map(build => {
  const complete = { ...build, plugins: [noticesPlugin(build.outfile)] };
  return watch ? esbuild.context(complete).then(context => context.watch()) : esbuild.build(complete);
})).catch(error => { console.error(error); process.exit(1); });
