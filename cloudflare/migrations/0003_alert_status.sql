alter table alerts add column status text default 'pending';
alter table alerts add column resolved_at integer;
alter table alerts add column threshold real;
alter table alerts add column trace_id text;
alter table alerts add column url text;
alter table alerts add column release_name text;
alter table alerts add column user_id text;
alter table alerts add column device_id text;
alter table alerts add column session_id text;
alter table alerts add column path text;
alter table alerts add column context_json text;

create index if not exists idx_alerts_status on alerts(status, created_at);
create index if not exists idx_alerts_trace on alerts(trace_id);
