-- 多租户定义类资源隔离：Dashboard 绑定 Team；历史 Dashboard 归入默认团队（若存在）。
alter table dashboards add column team_id varchar(32);

update dashboards
set team_id = (select id from teams where slug = 'default' limit 1)
where team_id is null
  and exists (select 1 from teams where slug = 'default');

create index if not exists idx_dashboards_team_updated on dashboards(team_id, updated_at desc);
