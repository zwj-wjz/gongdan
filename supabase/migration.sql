-- ============================================================================
-- 施工单系统 · 安全加固迁移脚本
--
-- 用法：Supabase Dashboard → SQL Editor → 整段粘贴执行（可以重复执行，幂等）
-- 执行前建议先做一次备份：Dashboard → Database → Backups
--
-- 这个脚本做四件事：
--   1. 补齐 work_orders 缺的列（car_plate / car_model / user_id / cover_photo）
--   2. 清掉历史遗留的宽松策略，开启 RLS，只允许本人读写自己的单据
--   3. 把 app_users 表彻底锁死（前端已不再使用它，密码改由 Supabase Auth 管理）
--   4. 把老数据的 user_id / cover_photo 回填好
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 0. 扩展（Supabase 默认已装好 pgcrypto，这行重复执行也不会报错）
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;


-- ---------------------------------------------------------------------------
-- 1. work_orders 补列
-- ---------------------------------------------------------------------------
alter table public.work_orders add column if not exists user_id uuid references auth.users (id) on delete cascade;
alter table public.work_orders add column if not exists car_plate text;
alter table public.work_orders add column if not exists car_model text;
alter table public.work_orders add column if not exists cover_photo text;

-- 插入时若前端没传 user_id，默认取当前登录用户
alter table public.work_orders alter column user_id set default auth.uid();

create index if not exists work_orders_user_created_idx
    on public.work_orders (user_id, created_at desc);


-- ---------------------------------------------------------------------------
-- 2. 清空 work_orders 上所有历史策略，重新按"仅本人"配置
-- ---------------------------------------------------------------------------
alter table public.work_orders enable row level security;
alter table public.work_orders force row level security;

do $$
declare
    p record;
begin
    for p in
        select policyname
        from pg_policies
        where schemaname = 'public' and tablename = 'work_orders'
    loop
        execute format('drop policy %I on public.work_orders', p.policyname);
    end loop;
end $$;

create policy "work_orders_select_own"
    on public.work_orders for select to authenticated
    using (user_id = auth.uid());

create policy "work_orders_insert_own"
    on public.work_orders for insert to authenticated
    with check (user_id = auth.uid());

create policy "work_orders_update_own"
    on public.work_orders for update to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

create policy "work_orders_delete_own"
    on public.work_orders for delete to authenticated
    using (user_id = auth.uid());

-- 匿名角色连表都不给碰，双保险
revoke all on table public.work_orders from anon;
grant select, insert, update, delete on table public.work_orders to authenticated;


-- ---------------------------------------------------------------------------
-- 3. 锁死 app_users（里面是明文密码，不能再被任何前端角色读到）
-- ---------------------------------------------------------------------------
alter table public.app_users enable row level security;
alter table public.app_users force row level security;

do $$
declare
    p record;
begin
    for p in
        select policyname
        from pg_policies
        where schemaname = 'public' and tablename = 'app_users'
    loop
        execute format('drop policy %I on public.app_users', p.policyname);
    end loop;
end $$;

revoke all on table public.app_users from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. 回填老数据
--    先跑 scripts/migrate-users.mjs 把老账号建进 Supabase Auth，
--    再执行这一段，老订单才能归属到新账号下。
--    如果有人事后才重新注册，把这一段单独重跑一次即可认领旧数据。
-- ---------------------------------------------------------------------------
update public.work_orders o
set user_id = u.id
from auth.users u
where o.user_id is null
  and coalesce(o.username, '') <> ''
  and u.email = lower(trim(o.username)) || '@gongdan.local';

update public.work_orders
set cover_photo = photos ->> 0
where cover_photo is null
  and photos is not null
  and jsonb_typeof(photos) = 'array'
  and coalesce(photos ->> 0, '') <> '';


-- ---------------------------------------------------------------------------
-- 5. 自检
-- ---------------------------------------------------------------------------
-- 5.1 还有多少条订单没归属（应为 0；不为 0 说明对应账号还没迁移进 Auth）
select count(*) as 未归属订单 from public.work_orders where user_id is null;

-- 5.2 策略是否只剩这 4 条（都应带 authenticated）
select policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'work_orders'
order by cmd;


-- ---------------------------------------------------------------------------
-- 6. 确认一切正常之后（建议观察几天），可以彻底删掉明文密码表
-- ---------------------------------------------------------------------------
-- drop table public.app_users;
