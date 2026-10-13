//! Oracle stored-source integration test (package spec/body, status, compile errors).
//! Run with:  DBFORGE_IT=1 DBFORGE_IT_ORACLE=1 cargo test it3 -- --nocapture

use crate::drivers::{connect, CollectSink};
use crate::meta;
use crate::model::ConnectionProfile;

#[tokio::test(flavor = "multi_thread")]
async fn it_oracle_package_source() {
    if std::env::var("DBFORGE_IT").is_err() || std::env::var("DBFORGE_IT_ORACLE").is_err() {
        return;
    }
    let p: ConnectionProfile = serde_json::from_value(serde_json::json!({"id":"it","engine":"oracle","host":"127.0.0.1","port":51521,
        "username":"test","oracle":{"method":"direct","service":"FREEPDB1"}}))
    .unwrap();
    let s = connect(&p, "Passw0rd!", "").await.unwrap().session;
    s.exec("CREATE OR REPLACE PACKAGE it_pk AS\n  FUNCTION add1 (p NUMBER) RETURN NUMBER;\n  PROCEDURE noop;\nEND it_pk;").await.unwrap();
    s.exec("CREATE OR REPLACE PACKAGE BODY it_pk AS\n  FUNCTION add1 (p NUMBER) RETURN NUMBER IS\n  BEGIN\n    RETURN p + 1;\n  END;\n  PROCEDURE noop IS BEGIN NULL; END;\nEND it_pk;")
        .await
        .unwrap();
    let src = meta::source(s.as_ref(), "TEST", "IT_PK", "package").await.unwrap();
    assert_eq!(src.parts.len(), 2);
    assert_eq!(src.parts[0].label, "Spec");
    assert!(src.parts[0].text.starts_with("CREATE OR REPLACE PACKAGE it_pk AS"), "{}", src.parts[0].text);
    assert!(src.parts[1].text.starts_with("CREATE OR REPLACE PACKAGE BODY it_pk AS"));
    assert_eq!(src.parts[1].status, "VALID");
    assert!(src.parts[0].created.contains('/'), "{}", src.parts[0].created);
    assert!(src.errors.is_empty());

    // Re-running the fetched text must compile (round trip).
    s.exec(&src.parts[1].text).await.unwrap();

    // A broken body: report how the driver surfaces it, then errors must be listed.
    let broken = "CREATE OR REPLACE PACKAGE BODY it_pk AS\n  FUNCTION add1 (p NUMBER) RETURN NUMBER IS\n  BEGIN\n    RETURN p + nope;\n  END;\n  PROCEDURE noop IS BEGIN NULL; END;\nEND it_pk;";
    let r = s.run(broken, &mut CollectSink::new(0)).await;
    eprintln!("compile-with-errors result: {:?}", r.as_ref().map(|_| "Ok").map_err(|e| format!("{e:#}")));
    let src = meta::source(s.as_ref(), "TEST", "IT_PK", "package").await.unwrap();
    assert_eq!(src.parts[1].status, "INVALID");
    let e = src.errors.first().expect("error listed");
    assert_eq!((e.object_type.as_str(), e.line), ("PACKAGE BODY", 4));
    assert!(e.text.contains("NOPE"), "{}", e.text);
    s.exec("DROP PACKAGE it_pk").await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn it_explain_plans() {
    if std::env::var("DBFORGE_IT").is_err() || std::env::var("DBFORGE_IT_ORACLE").is_err() {
        return;
    }
    let ora: ConnectionProfile = serde_json::from_value(serde_json::json!({"id":"it","engine":"oracle","host":"127.0.0.1","port":51521,
        "username":"test","oracle":{"method":"direct","service":"FREEPDB1"}}))
    .unwrap();
    let s = connect(&ora, "Passw0rd!", "").await.unwrap().session;
    let _ = s.exec("DROP TABLE it_plan PURGE").await;
    s.exec("CREATE TABLE it_plan (id NUMBER PRIMARY KEY, name VARCHAR2(30))").await.unwrap();
    let p = crate::explain::explain(s.as_ref(), "SELECT * FROM it_plan WHERE name = :n;").await.unwrap();
    eprintln!("{}", p.text);
    assert_eq!(p.nodes[0].operation, "SELECT STATEMENT");
    assert_eq!(p.nodes[0].parent_id, None);
    let full = p.nodes.iter().find(|n| n.operation == "TABLE ACCESS").expect("table access");
    assert_eq!((full.options.as_str(), full.object.as_str(), full.parent_id), ("FULL", "TABLE TEST.IT_PLAN", Some(0)));
    assert!(full.filter_predicates.contains("NAME"), "{:?}", full.filter_predicates);
    let p = crate::explain::explain(s.as_ref(), "SELECT * FROM it_plan WHERE id = 5").await.unwrap();
    assert!(p.nodes.iter().any(|n| n.operation == "INDEX" && n.options == "UNIQUE SCAN"), "{:?}", p.nodes);
    s.exec("DROP TABLE it_plan PURGE").await.unwrap();

    let pg: ConnectionProfile = serde_json::from_value(serde_json::json!({"id":"it","engine":"postgres","host":"127.0.0.1","port":55432,
        "database":"test","username":"postgres"}))
    .unwrap();
    let s = connect(&pg, "Passw0rd!", "").await.unwrap().session;
    let p = crate::explain::explain(s.as_ref(), "select * from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relname = 'x'").await.unwrap();
    assert_eq!(p.nodes[0].operation, "SELECT STATEMENT");
    assert!(p.nodes.len() >= 3 && p.nodes.iter().skip(1).all(|n| n.parent_id.is_some()));
    assert!(p.nodes.iter().any(|n| n.object.contains("pg_class")), "{:?}", p.nodes);
    eprintln!("pg nodes: {}", p.nodes.iter().map(|n| format!("{}#{:?} {} {}", n.id, n.parent_id, n.operation, n.object)).collect::<Vec<_>>().join(" | "));
}

#[tokio::test(flavor = "multi_thread")]
async fn it_oracle_reconnect_after_kill() {
    if std::env::var("DBFORGE_IT").is_err() || std::env::var("DBFORGE_IT_ORACLE").is_err() {
        return;
    }
    use crate::commands::{AppState, ReconnectInfo};
    let dir = std::env::temp_dir().join(format!("dbf-rc-{}", uuid::Uuid::new_v4()));
    let state = AppState::new(crate::store::ProfileStore::new(dir.clone()).unwrap());
    let prof = |user: &str| -> ConnectionProfile {
        serde_json::from_value(serde_json::json!({"id":"it","engine":"oracle","host":"127.0.0.1","port":51521,
            "username":user,"oracle":{"method":"direct","service":"FREEPDB1"}}))
        .unwrap()
    };
    let p = prof("test");
    let s = connect(&p, "Passw0rd!", "").await.unwrap().session;
    state.sessions.insert("S".into(), s);
    state.reconnect_info.insert(
        "S".into(),
        ReconnectInfo { profile: p, password: "Passw0rd!".into(), ssh_secret: String::new(), autocommit: true, server_output: false, schema: None },
    );
    let admin = connect(&prof("system"), "Passw0rd!", "").await.unwrap().session;
    let kill = || async {
        let mut sink = CollectSink::new(0);
        admin.run("select sid, serial# from v$session where username = 'TEST'", &mut sink).await.unwrap();
        for r in sink.rows {
            let res = admin.exec(&format!("alter system kill session '{},{}' immediate", r[0].to_text(), r[1].to_text())).await;
            eprintln!("kill {},{} -> {:?}", r[0].to_text(), r[1].to_text(), res.map_err(|e| format!("{e:#}")));
        }
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    };

    assert!(state.execute_sql("S", "select 1 from dual", None).await.unwrap().notice.is_none());
    kill().await;
    let r = state.execute_sql("S", "/* hdr */ SELECT 42 FROM dual", None).await.expect("read-only query re-run after reconnect");
    eprintln!("notice: {:?}", r.notice);
    assert!(r.notice.unwrap().contains("re-established"));
    assert_eq!(r.rows[0][0], crate::model::Cell::Int(42));

    kill().await;
    let r2 = state.execute_sql("S", "begin null; end;", None).await;
    eprintln!("dml result: {:?}", r2.as_ref().map(|r| r.notice.clone()));
    let e = r2.expect_err("DML must not be re-run");
    eprintln!("error: {e}");
    assert!(e.contains("NOT executed"));
    // the session is alive again afterwards
    assert!(state.execute_sql("S", "select 1 from dual", None).await.unwrap().notice.is_none());
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn it_oracle_fast_ddl() {
    if std::env::var("DBFORGE_IT").is_err() || std::env::var("DBFORGE_IT_ORACLE").is_err() {
        return;
    }
    let p: ConnectionProfile = serde_json::from_value(serde_json::json!({"id":"it","engine":"oracle","host":"127.0.0.1","port":51521,
        "username":"test","oracle":{"method":"direct","service":"FREEPDB1"}}))
    .unwrap();
    let s = connect(&p, "Passw0rd!", "").await.unwrap().session;
    for t in ["IT_DDL_CHILD", "IT_DDL_PARENT"] {
        let _ = s.exec(&format!("DROP TABLE {t} PURGE")).await;
    }
    s.exec("CREATE TABLE it_ddl_parent (id NUMBER(10) PRIMARY KEY, code VARCHAR2(30 CHAR) NOT NULL UNIQUE)").await.unwrap();
    s.exec("CREATE TABLE it_ddl_child (id NUMBER(10) CONSTRAINT it_ddl_child_pk PRIMARY KEY, parent_id NUMBER(10), amount NUMBER(18,2) DEFAULT 0 NOT NULL, \
            note VARCHAR2(200 BYTE), created DATE DEFAULT SYSDATE, \
            CONSTRAINT it_ddl_child_fk FOREIGN KEY (parent_id) REFERENCES it_ddl_parent (id) ON DELETE CASCADE, \
            CONSTRAINT it_ddl_amount_ck CHECK (amount >= 0))")
        .await
        .unwrap();
    s.exec("CREATE INDEX it_ddl_child_ix ON it_ddl_child (parent_id, created DESC)").await.unwrap();
    s.exec("COMMENT ON TABLE it_ddl_child IS 'Child rows'").await.unwrap();
    s.exec("COMMENT ON COLUMN it_ddl_child.amount IS 'Amount in MNT'").await.unwrap();

    let t0 = std::time::Instant::now();
    let fast = meta::ddl(s.as_ref(), "TEST", "IT_DDL_CHILD", "table").await.unwrap();
    let fast_ms = t0.elapsed().as_millis();
    let t1 = std::time::Instant::now();
    let full = meta::oracle_metadata_ddl(s.as_ref(), "TEST", "IT_DDL_CHILD", "table").await.unwrap();
    let full_ms = t1.elapsed().as_millis();
    eprintln!("fast {fast_ms} ms vs DBMS_METADATA {full_ms} ms\n----\n{fast}\n----");
    for needle in [
        "CREATE TABLE TEST.IT_DDL_CHILD",
        "NUMBER(18,2)",
        "DEFAULT 0 NOT NULL",
        "VARCHAR2(200 BYTE)",
        "CONSTRAINT IT_DDL_CHILD_PK PRIMARY KEY (ID)",
        "REFERENCES TEST.IT_DDL_PARENT (ID)",
        "ON DELETE CASCADE",
        "CHECK (amount >= 0)",
        "CREATE INDEX TEST.IT_DDL_CHILD_IX ON TEST.IT_DDL_CHILD",
        "COMMENT ON COLUMN TEST.IT_DDL_CHILD.AMOUNT IS 'Amount in MNT'",
    ] {
        assert!(fast.contains(needle), "missing {needle}");
    }
    assert!(full.contains("CREATE TABLE"));

    // Round trip: the generated script recreates the table.
    s.exec("DROP TABLE it_ddl_child PURGE").await.unwrap();
    for stmt in crate::it3::split_script(&fast) {
        s.exec(&stmt).await.unwrap_or_else(|e| panic!("{stmt}\n{e:#}"));
    }
    let again = meta::ddl(s.as_ref(), "TEST", "IT_DDL_CHILD", "table").await.unwrap();
    assert_eq!(again, fast, "regenerated DDL differs");
    for t in ["IT_DDL_CHILD", "IT_DDL_PARENT"] {
        s.exec(&format!("DROP TABLE {t} PURGE")).await.unwrap();
    }
}

/// Splits a generated script on statement-ending semicolons (no PL/SQL here).
pub fn split_script(text: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut in_str = false;
    for ch in text.chars() {
        if ch == '\'' {
            in_str = !in_str;
        }
        if ch == ';' && !in_str {
            let st = cur.lines().filter(|l| !l.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n");
            if !st.trim().is_empty() {
                out.push(st.trim().to_string());
            }
            cur.clear();
        } else {
            cur.push(ch);
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn it_oracle_ddl_timing() {
    if std::env::var("DBFORGE_IT").is_err() || std::env::var("DBFORGE_IT_ORACLE").is_err() {
        return;
    }
    let p: ConnectionProfile = serde_json::from_value(serde_json::json!({"id":"it","engine":"oracle","host":"127.0.0.1","port":51521,
        "username":"test","oracle":{"method":"direct","service":"FREEPDB1"}}))
    .unwrap();
    let s = connect(&p, "Passw0rd!", "").await.unwrap().session;
    let _ = s.exec("CREATE TABLE it_tm (id NUMBER PRIMARY KEY, v VARCHAR2(10))").await;
    let qs = [
        ("cols", "select column_name, data_type, data_length, data_precision, data_scale, char_length, char_used, nullable, data_default from all_tab_columns where owner = 'TEST' and table_name = 'IT_TM' order by column_id"),
        ("tables", "select tablespace_name, partitioned, temporary, duration, iot_type, logging from all_tables where owner = 'TEST' and table_name = 'IT_TM'"),
        ("cons-join", "select c.constraint_name, (select listagg(cc.column_name, ', ') within group (order by cc.position) from all_cons_columns cc where cc.owner = c.owner and cc.constraint_name = c.constraint_name), r.table_name from all_constraints c left join all_constraints r on r.owner = c.r_owner and r.constraint_name = c.r_constraint_name where c.owner = 'TEST' and c.table_name = 'IT_TM' and c.constraint_type in ('P','U','R','C')"),
        ("cons-plain", "select constraint_name, constraint_type, search_condition_vc, r_owner, r_constraint_name, delete_rule, generated, status, index_name from all_constraints where owner = 'TEST' and table_name = 'IT_TM'"),
        ("cons-cols", "select constraint_name, column_name, position from all_cons_columns where owner = 'TEST' and table_name = 'IT_TM'"),
        ("idx", "select i.owner, i.index_name, i.uniqueness from all_indexes i where i.table_owner = 'TEST' and i.table_name = 'IT_TM'"),
        ("ind-cols", "select index_owner, index_name, column_name, column_position, descend from all_ind_columns where table_owner = 'TEST' and table_name = 'IT_TM'"),
        ("tab-cmt", "select comments from all_tab_comments where owner = 'TEST' and table_name = 'IT_TM'"),
        ("col-cmt", "select column_name, comments from all_col_comments where owner = 'TEST' and table_name = 'IT_TM' and comments is not null"),
    ];
    for round in 0..2 {
        for (name, q) in qs {
            let t = std::time::Instant::now();
            let mut sink = CollectSink::new(0);
            s.run(q, &mut sink).await.unwrap();
            eprintln!("round {round} {name:<10} {:>5} ms", t.elapsed().as_millis());
        }
    }
    for i in 0..3 {
        let t = std::time::Instant::now();
        let _ = meta::ddl(s.as_ref(), "TEST", "IT_TM", "table").await.unwrap();
        let fast = t.elapsed().as_millis();
        let t = std::time::Instant::now();
        let _ = meta::oracle_metadata_ddl(s.as_ref(), "TEST", "IT_TM", "table").await.unwrap();
        eprintln!("run {i}: fast generator {fast} ms | DBMS_METADATA {} ms", t.elapsed().as_millis());
    }
    let _ = s.exec("DROP TABLE it_tm PURGE").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn it_oracle_session_browser() {
    if std::env::var("DBFORGE_IT").is_err() || std::env::var("DBFORGE_IT_ORACLE").is_err() {
        return;
    }
    use crate::commands::{AppState, ReconnectInfo};
    let prof = |user: &str| -> ConnectionProfile {
        serde_json::from_value(serde_json::json!({"id":"it","engine":"oracle","host":"127.0.0.1","port":51521,
            "username":user,"oracle":{"method":"direct","service":"FREEPDB1"}}))
        .unwrap()
    };
    // Unprivileged user gets a clear message.
    let test_sess = connect(&prof("test"), "Passw0rd!", "").await.unwrap().session;
    let e = crate::sessions::list(test_sess.as_ref()).await.expect_err("TEST has no V$SESSION access");
    eprintln!("unprivileged: {}", format!("{e:#}").lines().next().unwrap());
    assert!(format!("{e:#}").contains("SELECT_CATALOG_ROLE"));

    let _ = test_sess.exec("DROP TABLE it_lock PURGE").await;
    test_sess.exec("CREATE TABLE it_lock (id NUMBER PRIMARY KEY, v NUMBER)").await.unwrap();
    test_sess.exec("INSERT INTO it_lock VALUES (1, 0)").await.unwrap();
    test_sess.commit().await.unwrap();

    // A holds a row lock (no commit); B blocks on it in the background.
    let a = connect(&prof("test"), "Passw0rd!", "").await.unwrap().session;
    a.set_autocommit(false).await.unwrap();
    a.exec("UPDATE it_lock SET v = 1 WHERE id = 1").await.unwrap();
    let b = connect(&prof("test"), "Passw0rd!", "").await.unwrap().session;
    let blocked = tokio::spawn(async move { b.exec("UPDATE it_lock SET v = 2 WHERE id = 1").await.map_err(|e| format!("{e:#}")) });
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    let dir = std::env::temp_dir().join(format!("dbf-sb-{}", uuid::Uuid::new_v4()));
    let state = AppState::new(crate::store::ProfileStore::new(dir.clone()).unwrap());
    let sys = prof("system");
    state.sessions.insert("S".into(), connect(&sys, "Passw0rd!", "").await.unwrap().session);
    state.reconnect_info.insert("S".into(), ReconnectInfo { profile: sys, password: "Passw0rd!".into(), ssh_secret: String::new(), autocommit: true, server_output: false, schema: None });

    let list = state.session_list_for_test("S").await;
    let mine: Vec<_> = list.iter().filter(|s| s.user == "TEST").collect();
    eprintln!("TEST sessions: {}", mine.iter().map(|s| format!("{} {} blocked_by={} wait={} sql={}", s.id, s.status, s.blocked_by, s.wait, s.sql_text.chars().take(40).collect::<String>())).collect::<Vec<_>>().join(" | "));
    assert!(list.iter().any(|s| s.is_self && s.user == "SYSTEM"), "editor session marked as self");
    let victim = mine.iter().find(|s| !s.blocked_by.is_empty()).expect("a blocked session");
    assert!(victim.sql_text.contains("UPDATE it_lock"), "{}", victim.sql_text);
    let blocker = mine.iter().find(|s| s.sid == victim.blocked_by).expect("blocker listed");

    let d = state.session_detail_for_test("S", &blocker.id, &blocker.sql_id).await;
    eprintln!("blocker locks: {:?}", d.locks.rows);
    assert!(d.locks.rows.iter().any(|r| r[0].contains("IT_LOCK")), "lock on IT_LOCK listed");

    state.session_kill_for_test("S", &blocker.id, false).await;
    let r = tokio::time::timeout(std::time::Duration::from_secs(10), blocked).await.expect("B unblocked").unwrap();
    eprintln!("blocked statement finished: {r:?}");
    assert!(r.is_ok());
    let list = state.session_list_for_test("S").await;
    assert!(!list.iter().any(|s| s.id == blocker.id && s.status != "KILLED"), "blocker gone");
    let _ = test_sess.exec("DROP TABLE it_lock PURGE").await;
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn it_oracle_dbms_output() {
    if std::env::var("DBFORGE_IT").is_err() || std::env::var("DBFORGE_IT_ORACLE").is_err() {
        return;
    }
    use crate::commands::{AppState, ReconnectInfo};
    let p: ConnectionProfile = serde_json::from_value(serde_json::json!({"id":"it","engine":"oracle","host":"127.0.0.1","port":51521,
        "username":"test","oracle":{"method":"direct","service":"FREEPDB1"}}))
    .unwrap();
    let dir = std::env::temp_dir().join(format!("dbf-out-{}", uuid::Uuid::new_v4()));
    let state = AppState::new(crate::store::ProfileStore::new(dir.clone()).unwrap());
    let s = connect(&p, "Passw0rd!", "").await.unwrap().session;
    assert!(s.set_server_output(true).await.unwrap(), "oracle supports server output");
    state.sessions.insert("S".into(), s.clone());
    state.reconnect_info.insert("S".into(), ReconnectInfo { profile: p, password: "Passw0rd!".into(), ssh_secret: String::new(), autocommit: true, server_output: true, schema: None });

    let r = state
        .execute_sql("S", "BEGIN FOR i IN 1 .. 3 LOOP DBMS_OUTPUT.PUT_LINE('row ' || i); END LOOP; DBMS_OUTPUT.PUT_LINE(''); DBMS_OUTPUT.PUT_LINE('Сайн уу'); END;", None)
        .await
        .unwrap();
    eprintln!("output: {:?}", r.output);
    assert_eq!(r.output, vec!["row 1", "row 2", "row 3", "", "Сайн уу"]);

    // Plain SQL produces no output; buffer was drained by the previous call.
    assert!(state.execute_sql("S", "select 1 from dual", None).await.unwrap().output.is_empty());

    // Lines printed before a failure stay in the buffer for take_server_output.
    let e = state.execute_sql("S", "BEGIN DBMS_OUTPUT.PUT_LINE('before error'); RAISE_APPLICATION_ERROR(-20001, 'boom'); END;", None).await;
    assert!(e.unwrap_err().contains("ORA-20001"));
    assert_eq!(s.take_server_output().await.unwrap(), vec!["before error"]);

    // Disabled → nothing captured.
    s.set_server_output(false).await.unwrap();
    let r = state.execute_sql("S", "BEGIN DBMS_OUTPUT.PUT_LINE('hidden'); END;", None).await.unwrap();
    assert!(r.output.is_empty());
    std::fs::remove_dir_all(dir).ok();
}
