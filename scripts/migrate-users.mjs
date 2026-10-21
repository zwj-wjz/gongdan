#!/usr/bin/env node
/**
 * 把 app_users 里的老账号（明文密码）迁移进 Supabase Auth。
 *
 * 为什么需要这一步：
 *   前端改成 Supabase Auth 之后，登录校验由 Auth 服务负责，
 *   app_users 里的旧密码就"接不上"了。这个脚本会用 Admin API
 *   把每个老账号创建成 Auth 用户，密码沿用原来的明文密码，
 *   Supabase 内部会自己换成 bcrypt 哈希存起来。
 *
 * 用法（在项目根目录执行）：
 *   node scripts/migrate-users.mjs --dry      # 先看一遍会发生什么
 *   SUPABASE_SERVICE_ROLE_KEY=xxx node scripts/migrate-users.mjs
 *
 * service_role key 在 Supabase → Project Settings → API → service_role 里，
 * 它等于数据库的万能钥匙，只在本机临时用，别写进代码、别提交。
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://umatcwaodotqpttbuwew.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USER_DOMAIN = '@gongdan.local';
const DRY_RUN = process.argv.includes('--dry');

const headers = {
    apikey: SERVICE_KEY,
    Authorization: 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json'
};

const toEmail = (username) => String(username).trim().toLowerCase() + USER_DOMAIN;

async function api(path, options = {}) {
    const resp = await fetch(SUPABASE_URL + path, { headers, ...options });
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON 响应 */ }
    return { ok: resp.ok, status: resp.status, data, text };
}

async function loadLegacyUsers() {
    const { ok, data, text } = await api('/rest/v1/app_users?select=username,password_hash&order=username.asc');
    if (!ok) {
        throw new Error('读取 app_users 失败（' + text.slice(0, 200) + '）\n' +
            '请确认 SERVICE_KEY 是 service_role 而不是 anon，并且表名是 app_users。');
    }
    return Array.isArray(data) ? data : [];
}

async function loadAuthUsers() {
    const map = new Map();
    let page = 1;
    while (true) {
        const { ok, data } = await api(`/auth/v1/admin/users?page=${page}&per_page=1000`);
        if (!ok) throw new Error('列出 Auth 用户失败，请检查 service_role key');
        const users = (data && data.users) || [];
        users.forEach(u => map.set(String(u.email || '').toLowerCase(), u.id));
        if (users.length < 1000) break;
        page += 1;
    }
    return map;
}

async function main() {
    if (!SERVICE_KEY) {
        console.error('缺少 SUPABASE_SERVICE_ROLE_KEY 环境变量。');
        console.error('示例：SUPABASE_SERVICE_ROLE_KEY=eyJhbGci... node scripts/migrate-users.mjs');
        process.exit(1);
    }

    console.log(DRY_RUN ? '=== 预演模式，不会写入任何数据 ===' : '=== 开始迁移 ===');

    const legacy = await loadLegacyUsers();
    const authUsers = await loadAuthUsers();

    console.log(`app_users 共 ${legacy.length} 个账号，Auth 中已有 ${authUsers.size} 个用户\n`);

    let created = 0, updated = 0, skipped = 0, failed = 0;

    for (const row of legacy) {
        const username = String(row.username || '').trim();
        const password = String(row.password_hash || '');

        if (!/^[A-Za-z0-9_-]{2,20}$/.test(username)) {
            console.log(`  跳过  ${username || '(空)'}  —— 账号含不支持的字符（只允许字母/数字/下划线，2-20 位）`);
            skipped++;
            continue;
        }
        if (password.length < 6) {
            console.log(`  跳过  ${username}  —— 原密码不足 6 位，需要本人重新注册`);
            skipped++;
            continue;
        }

        const email = toEmail(username);
        const existingId = authUsers.get(email);

        if (DRY_RUN) {
            console.log(`  ${existingId ? '会更新' : '会创建'}  ${username}  ->  ${email}`);
            existingId ? updated++ : created++;
            continue;
        }

        const body = JSON.stringify({
            email,
            password,
            email_confirm: true,
            user_metadata: { username }
        });

        const res = existingId
            ? await api(`/auth/v1/admin/users/${existingId}`, { method: 'PUT', body })
            : await api('/auth/v1/admin/users', { method: 'POST', body });

        if (res.ok) {
            existingId ? updated++ : created++;
            console.log(`  ${existingId ? '更新' : '创建'}  ${username}  ->  ${email}`);
            if (!existingId && res.data && res.data.id) authUsers.set(email, res.data.id);
        } else {
            failed++;
            console.log(`  失败  ${username}  —— ${res.status} ${res.text.slice(0, 160)}`);
        }
    }

    console.log(`\n完成：新建 ${created}，更新 ${updated}，跳过 ${skipped}，失败 ${failed}`);
    if (!DRY_RUN) {
        console.log('\n下一步：回到 Supabase SQL Editor，重跑 supabase/migration.sql 的第 4 段，');
        console.log('把老订单的 user_id 归属到新账号上。');
    }
}

main().catch(e => {
    console.error('\n出错了：' + e.message);
    process.exit(1);
});
