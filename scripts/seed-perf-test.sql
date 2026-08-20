-- 本地性能验证种子数据
insert into applications (app_id,name,enabled,sample_rate,replay_sample_rate,created_at,updated_at) values ('perf-test','Perf Test',1,1,1,1787000000000,1787000000000);
insert into releases (app_id,release_name,status,created_at) values ('perf-test','1.0.0','active',1787000000000);
insert into releases (app_id,release_name,status,created_at) values ('perf-test','1.1.0','beta',1787000001000);
insert into releases (app_id,release_name,status,created_at) values ('other-app','2.0.0','active',1787000000000);

-- 会话 s1: 路径 /a,/a(重复),/b -> 去重后 '/a → /b'
insert into events (id,ts,type,app_id,session_id,user_id,user_name,path,name) values ('e1',1787001000000,'behavior','perf-test','s1','u1','User1','/a','pv');
insert into events (id,ts,type,app_id,session_id,user_id,user_name,path,name) values ('e2',1787001001000,'behavior','perf-test','s1','u1','User1','/a','pv');
insert into events (id,ts,type,app_id,session_id,user_id,user_name,path,name) values ('e3',1787001002000,'behavior','perf-test','s1','u1','User1','/b','pv');
-- 会话 s2: /c,/d -> '/c → /d'
insert into events (id,ts,type,app_id,session_id,user_id,user_name,path,name) values ('e4',1787001003000,'behavior','perf-test','s2','u2','User2','/c','pv');
insert into events (id,ts,type,app_id,session_id,user_id,user_name,path,name) values ('e5',1787001004000,'behavior','perf-test','s2','u2','User2','/d','pv');

-- perf lcp: 10 个值 [100..1000] -> n=10, index=6.75, p75 = 700 + 100*0.75 = 775
insert into events (id,ts,type,app_id,metric,value) values ('p1',1787002000000,'perf','perf-test','lcp',100);
insert into events (id,ts,type,app_id,metric,value) values ('p2',1787002001000,'perf','perf-test','lcp',200);
insert into events (id,ts,type,app_id,metric,value) values ('p3',1787002002000,'perf','perf-test','lcp',300);
insert into events (id,ts,type,app_id,metric,value) values ('p4',1787002003000,'perf','perf-test','lcp',400);
insert into events (id,ts,type,app_id,metric,value) values ('p5',1787002004000,'perf','perf-test','lcp',500);
insert into events (id,ts,type,app_id,metric,value) values ('p6',1787002005000,'perf','perf-test','lcp',600);
insert into events (id,ts,type,app_id,metric,value) values ('p7',1787002006000,'perf','perf-test','lcp',700);
insert into events (id,ts,type,app_id,metric,value) values ('p8',1787002007000,'perf','perf-test','lcp',800);
insert into events (id,ts,type,app_id,metric,value) values ('p9',1787002008000,'perf','perf-test','lcp',900);
insert into events (id,ts,type,app_id,metric,value) values ('p10',1787002009000,'perf','perf-test','lcp',1000);
-- perf cls: [0.1,0.2,0.3,0.4] -> n=4, index=2.25, p75 = 0.3 + 0.1*0.25 = 0.325
insert into events (id,ts,type,app_id,metric,value) values ('c1',1787002010000,'perf','perf-test','cls',0.1);
insert into events (id,ts,type,app_id,metric,value) values ('c2',1787002011000,'perf','perf-test','cls',0.2);
insert into events (id,ts,type,app_id,metric,value) values ('c3',1787002012000,'perf','perf-test','cls',0.3);
insert into events (id,ts,type,app_id,metric,value) values ('c4',1787002013000,'perf','perf-test','cls',0.4);
-- perf blank_screen_rate: [0.1,0.2,0.3] -> avg = 0.2 -> toFixed(0) = 0
insert into events (id,ts,type,app_id,metric,value) values ('b1',1787002020000,'perf','perf-test','blank_screen_rate',0.1);
insert into events (id,ts,type,app_id,metric,value) values ('b2',1787002021000,'perf','perf-test','blank_screen_rate',0.2);
insert into events (id,ts,type,app_id,metric,value) values ('b3',1787002022000,'perf','perf-test','blank_screen_rate',0.3);
-- perf page_load: [1000,2000] -> p75 = 1750; 加一个 <=0 的（应排除）和一个 NULL（应排除）
insert into events (id,ts,type,app_id,metric,value) values ('pl1',1787002030000,'perf','perf-test','page_load',1000);
insert into events (id,ts,type,app_id,metric,value) values ('pl2',1787002031000,'perf','perf-test','page_load',2000);
insert into events (id,ts,type,app_id,metric,value) values ('pl3',1787002032000,'perf','perf-test','page_load',0);
insert into events (id,ts,type,app_id,metric,value) values ('pl4',1787002033000,'perf','perf-test','page_load',null);
-- perf fetch: 2 条带 props.url，用于 api 聚合
insert into events (id,ts,type,app_id,metric,value,name,props_json) values ('f1',1787002040000,'perf','perf-test','fetch',120,'GET /api/users','{"url":"/api/users"}');
insert into events (id,ts,type,app_id,metric,value,name,props_json) values ('f2',1787002041000,'perf','perf-test','fetch',340,'GET /api/users','{"url":"/api/users"}');
-- perf resource: 1 条带 props.name
insert into events (id,ts,type,app_id,metric,value,name,props_json) values ('r1',1787002050000,'perf','perf-test','resource',50,'main.js','{"name":"main.js"}');
-- perf 非数值 value（应被 typeof guard 排除）
insert into events (id,ts,type,app_id,metric,value) values ('bad1',1787002060000,'perf','perf-test','lcp','not-a-number');
