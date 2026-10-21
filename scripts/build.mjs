/**
 * 构建脚本：把需要公开发布的静态文件拷进 dist/
 *
 * 用 Node 而不是 shell 的 mkdir/cp，原因是 netlify.toml 里的 build.command
 * 在 Windows 本地会被 cmd.exe 执行，Unix 语法会直接报错；
 * 放到 Node 里两端（本地 Windows / Netlify Linux）行为一致。
 *
 * 不拷贝的东西（防止外泄）：api/、scripts/、supabase/、netlify/、*.bak、.env*
 */

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

// 白名单：只有这里列出的才会进发布包
const FILES = ['index.html', 'manifest.json', 'icon.svg'];
const DIRS = ['vendor'];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const name of FILES) {
    const src = path.join(root, name);
    if (!existsSync(src)) {
        console.error(`[build] 缺少文件: ${name}`);
        process.exit(1);
    }
    await cp(src, path.join(dist, name));
    console.log(`[build] file  ${name}`);
}

for (const name of DIRS) {
    const src = path.join(root, name);
    if (!existsSync(src)) {
        console.error(`[build] 缺少目录: ${name}`);
        process.exit(1);
    }
    await cp(src, path.join(dist, name), { recursive: true });
    const entries = await readdir(src);
    console.log(`[build] dir   ${name}/ (${entries.length} 个文件)`);
}

// 兜底检查：发布包里绝不能出现这些名字
const BANNED = [/\.bak$/i, /^\.env/i, /^api$/i, /^supabase$/i, /^scripts$/i];
const leaked = (await readdir(dist)).filter((n) => BANNED.some((re) => re.test(n)));
if (leaked.length) {
    console.error(`[build] 检测到不该发布的文件: ${leaked.join(', ')}`);
    process.exit(1);
}

const total = (await readdir(dist, { recursive: true })).length;
console.log(`[build] 完成，dist/ 共 ${total} 项`);
