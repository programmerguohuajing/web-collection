alter table alerts add column fingerprint text;
alter table alerts add column notify_error text;
alter table alerts add column context_json text;

create table if not exists alert_channels (
  id integer primary key autoincrement,
  name text not null,
  type text not null,
  enabled integer not null default 1,
  config_json text not null default '{}',
  secret_ciphertext text,
  app_ids_json text not null default '[]',
  levels_json text not null default '[]',
  metrics_json text not null default '[]',
  last_test_status text,
  last_test_error text,
  last_test_at integer,
  created_at integer not null,
  updated_at integer not null
);

create table if not exists alert_deliveries (
  id integer primary key autoincrement,
  alert_id integer not null references alerts(id) on delete cascade,
  channel_id integer references alert_channels(id) on delete set null,
  channel_name text not null,
  channel_type text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  queue_message_id text,
  provider_message_id text,
  last_error text,
  sent_at integer,
  created_at integer not null,
  updated_at integer not null
);

create index if not exists idx_alert_deliveries_alert on alert_deliveries(alert_id, created_at);
create index if not exists idx_alert_deliveries_pending on alert_deliveries(status, updated_at);
