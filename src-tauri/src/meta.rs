//! Schema browser metadata, implemented as per-dialect catalog queries.

use crate::drivers::{lit, CollectSink, Dialect, Session};
use crate::model::{Cell, ColumnInfo, DbObject};
use anyhow::{bail, Result};

async fn rows(s: &dyn Session, sql: &str) -> Result<Vec<Vec<Cell>>> {
    let mut sink = CollectSink::new(0);
    s.run(sql, &mut sink).await?;
    Ok(sink.rows)
}

fn text(c: Option<&Cell>) -> String {
    c.map(Cell::to_text).unwrap_or_default()
}

fn truthy(c: Option<&Cell>) -> bool {
    match c {
        Some(Cell::Bool(b)) => *b,
        Some(Cell::Int(i)) => *i != 0,
        Some(Cell::Text(t)) | Some(Cell::Dec(t)) => matches!(t.as_str(), "1" | "t" | "true" | "YES" | "Y"),
        _ => false,
    }
}

pub async fn list_schemas(s: &dyn Session) -> Result<Vec<String>> {
    if let Some(v) = s.native_schemas().await? {
        return Ok(v);
    }
    let sql = match s.dialect() {
        Dialect::Clickhouse => "select name from system.databases order by name",
        d @ (Dialect::Redis | Dialect::Mongo | Dialect::Neo4j | Dialect::Janus | Dialect::Elastic) => bail!("{d:?}: schemas not supported"),
        Dialect::Postgres => "select schema_name from information_schema.schemata where schema_name not like 'pg\\_toast%' and schema_name not like 'pg\\_temp%' order by 1",
        Dialect::Mysql => "select schema_name from information_schema.schemata order by 1",
        Dialect::Sqlite => "select name from pragma_database_list order by seq",
        Dialect::Mssql => "select name from sys.schemas order by name",
        Dialect::Oracle => "select username from all_users order by username",
    };
    Ok(rows(s, sql).await?.iter().map(|r| text(r.first())).collect())
}

/// Default schema to expand first in the explorer.
pub async fn current_schema(s: &dyn Session) -> Result<String> {
    if let Some(v) = s.native_current_schema().await? {
        return Ok(v);
    }
    let sql = match s.dialect() {
        Dialect::Clickhouse => "select currentDatabase()",
        Dialect::Redis | Dialect::Mongo | Dialect::Neo4j | Dialect::Janus | Dialect::Elastic => return Ok(String::new()),
        Dialect::Postgres => "select current_schema()",
        Dialect::Mysql => "select database()",
        Dialect::Sqlite => return Ok("main".into()),
        Dialect::Mssql => "select schema_name()",
        Dialect::Oracle => "select sys_context('USERENV','CURRENT_SCHEMA') from dual",
    };
    Ok(rows(s, sql).await?.first().map(|r| text(r.first())).unwrap_or_default())
}

/// Makes `schema` the session's default for unqualified names; returns the resulting schema.
pub async fn set_current_schema(s: &dyn Session, schema: &str) -> Result<String> {
    let d = s.dialect();
    let q = quote_ident(d, schema);
    let sql = match d {
        Dialect::Oracle => format!("alter session set current_schema = {q}"),
        Dialect::Postgres if schema == "public" => "set search_path to public".to_string(),
        Dialect::Postgres => format!("set search_path to {q}, public"),
        Dialect::Mysql => format!("use {q}"),
        _ => anyhow::bail!("Switching the current schema is not supported for this database"),
    };
    s.exec(&sql).await?;
    current_schema(s).await
}

pub async fn list_objects(s: &dyn Session, schema: &str) -> Result<Vec<DbObject>> {
    if let Some(v) = s.native_objects(schema).await? {
        return Ok(v);
    }
    let q = lit(schema);
    let sql = match s.dialect() {
        Dialect::Clickhouse => format!(
            "select name, multiIf(engine = 'MaterializedView', 'materialized view', engine like '%View', 'view', engine = 'Dictionary', 'dictionary', 'table')
             from system.tables where database = {q} order by 2, 1"
        ),
        d @ (Dialect::Redis | Dialect::Mongo | Dialect::Neo4j | Dialect::Janus | Dialect::Elastic) => bail!("{d:?}: objects not supported"),
        Dialect::Postgres => format!(
            "select table_name, case table_type when 'VIEW' then 'view' else 'table' end from information_schema.tables where table_schema={q}
             union all select table_name, 'materialized view' from (select matviewname as table_name from pg_matviews where schemaname={q}) m
             union all select distinct routine_name, lower(coalesce(routine_type,'function')) from information_schema.routines where routine_schema={q}
             union all select sequence_name, 'sequence' from information_schema.sequences where sequence_schema={q}
             union all select distinct trigger_name, 'trigger' from information_schema.triggers where trigger_schema={q}
             order by 2, 1"
        ),
        Dialect::Mysql => format!(
            "select table_name, case table_type when 'VIEW' then 'view' else 'table' end from information_schema.tables where table_schema={q}
             union all select routine_name, lower(routine_type) from information_schema.routines where routine_schema={q}
             union all select trigger_name, 'trigger' from information_schema.triggers where trigger_schema={q}
             order by 2, 1"
        ),
        Dialect::Sqlite => format!(
            "select name, type from \"{}\".sqlite_master where type in ('table','view','trigger','index') and name not like 'sqlite\\_%' escape '\\' order by type, name",
            schema.replace('"', "\"\"")
        ),
        Dialect::Mssql => format!(
            "select o.name, case when o.type = 'U' then 'table' when o.type = 'V' then 'view' when o.type = 'P' then 'procedure'
                 when o.type in ('FN','IF','TF') then 'function' when o.type = 'TR' then 'trigger' else 'sequence' end
             from sys.objects o join sys.schemas s on s.schema_id = o.schema_id
             where s.name = {q} and o.type in ('U','V','P','FN','IF','TF','TR','SO') order by 2, 1"
        ),
        Dialect::Oracle => format!(
            "select object_name, lower(object_type) from all_objects where owner = {q}
             and object_type in ('TABLE','VIEW','MATERIALIZED VIEW','PROCEDURE','FUNCTION','PACKAGE','SEQUENCE','TRIGGER','SYNONYM','TYPE')
             and object_name not like 'BIN$%' order by object_type, object_name"
        ),
    };
    Ok(rows(s, &sql)
        .await?
        .iter()
        .map(|r| DbObject { schema: schema.to_string(), name: text(r.first()), kind: text(r.get(1)) })
        .collect())
}

pub async fn columns(s: &dyn Session, schema: &str, table: &str) -> Result<Vec<ColumnInfo>> {
    if let Some(v) = s.native_columns(schema, table).await? {
        return Ok(v);
    }
    let (qs, qt) = (lit(schema), lit(table));
    let sql = match s.dialect() {
        Dialect::Clickhouse => format!(
            "select name, type, type like 'Nullable(%', nullIf(default_expression, ''), is_in_primary_key, nullIf(comment, '')
             from system.columns where database = {qs} and table = {qt} order by position"
        ),
        d @ (Dialect::Redis | Dialect::Mongo | Dialect::Neo4j | Dialect::Janus | Dialect::Elastic) => bail!("{d:?}: columns not supported"),
        Dialect::Postgres => format!(
            "select c.column_name,
                    case when c.data_type in ('USER-DEFINED','ARRAY') then c.udt_name else c.data_type end
                      || coalesce('(' || c.character_maximum_length || ')', ''),
                    c.is_nullable = 'YES', c.column_default,
                    exists(select 1 from information_schema.table_constraints tc
                           join information_schema.key_column_usage k on k.constraint_name = tc.constraint_name
                             and k.table_schema = tc.table_schema and k.table_name = tc.table_name
                           where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = c.table_schema
                             and tc.table_name = c.table_name and k.column_name = c.column_name),
                    col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position::int)
             from information_schema.columns c where c.table_schema = {qs} and c.table_name = {qt} order by c.ordinal_position"
        ),
        Dialect::Mysql => format!(
            "select column_name, column_type, is_nullable = 'YES', column_default, column_key = 'PRI', nullif(column_comment, '')
             from information_schema.columns where table_schema = {qs} and table_name = {qt} order by ordinal_position"
        ),
        Dialect::Sqlite => format!(
            "select name, type, \"notnull\" = 0, dflt_value, pk > 0 from pragma_table_info({qt}, {qs}) order by cid"
        ),
        Dialect::Mssql => format!(
            "select c.name,
                    t.name + case when t.name in ('varchar','nvarchar','char','nchar','varbinary','binary')
                                  then '(' + case when c.max_length = -1 then 'max'
                                                  else cast(case when t.name like 'n%' then c.max_length / 2 else c.max_length end as varchar(10)) end + ')'
                                  when t.name in ('decimal','numeric') then '(' + cast(c.precision as varchar(5)) + ',' + cast(c.scale as varchar(5)) + ')'
                                  else '' end,
                    c.is_nullable, object_definition(c.default_object_id),
                    case when exists(select 1 from sys.index_columns ic join sys.indexes i on i.object_id = ic.object_id and i.index_id = ic.index_id
                                     where i.is_primary_key = 1 and ic.object_id = c.object_id and ic.column_id = c.column_id) then 1 else 0 end
             from sys.columns c join sys.types t on t.user_type_id = c.user_type_id
             where c.object_id = object_id(quotename({qs}) + '.' + quotename({qt})) order by c.column_id"
        ),
        Dialect::Oracle => return oracle_columns(s, schema, table).await,
    };
    Ok(rows(s, &sql)
        .await?
        .iter()
        .map(|r| ColumnInfo {
            name: text(r.first()),
            data_type: text(r.get(1)),
            nullable: truthy(r.get(2)),
            default_value: r.get(3).filter(|c| !c.is_null()).map(|c| c.to_text().trim().to_string()),
            primary_key: truthy(r.get(4)),
            comment: r.get(5).filter(|c| !c.is_null()).map(|c| c.to_text()),
        })
        .collect())
}

/// Oracle columns from plain dictionary queries (a correlated ALL_CONSTRAINTS join per column
/// is seconds on big schemas; these are milliseconds).
async fn oracle_columns(s: &dyn Session, schema: &str, table: &str) -> Result<Vec<ColumnInfo>> {
    let (qs, qt) = (lit(schema), lit(table));
    let cols = rows(
        s,
        &format!(
            "select column_name, data_type, data_length, data_precision, data_scale, char_length, char_used, nullable, data_default
             from all_tab_columns where owner = {qs} and table_name = {qt} order by column_id"
        ),
    )
    .await?;
    let pk_name = rows(s, &format!("select constraint_name from all_constraints where owner = {qs} and table_name = {qt} and constraint_type = 'P'"))
        .await?
        .first()
        .map(|r| text(r.first()));
    let pk: std::collections::HashSet<String> = match pk_name {
        Some(c) => rows(s, &format!("select column_name from all_cons_columns where owner = {qs} and constraint_name = {}", lit(&c)))
            .await?
            .iter()
            .map(|r| text(r.first()))
            .collect(),
        None => Default::default(),
    };
    let comments: std::collections::HashMap<String, String> = rows(
        s,
        &format!("select column_name, comments from all_col_comments where owner = {qs} and table_name = {qt} and comments is not null"),
    )
    .await?
    .iter()
    .map(|r| (text(r.first()), text(r.get(1))))
    .collect();
    let num = |c: Option<&Cell>| c.filter(|c| !c.is_null()).and_then(|c| c.to_text().parse::<i64>().ok());
    Ok(cols
        .iter()
        .map(|r| {
            let name = text(r.first());
            ColumnInfo {
                data_type: crate::oracle_ddl::column_type(&text(r.get(1)), num(r.get(2)), num(r.get(3)), num(r.get(4)), num(r.get(5)), &text(r.get(6))),
                nullable: text(r.get(7)) == "Y",
                default_value: r.get(8).filter(|c| !c.is_null()).map(|c| c.to_text().trim().to_string()).filter(|d| !d.is_empty()),
                primary_key: pk.contains(&name),
                comment: comments.get(&name).cloned(),
                name,
            }
        })
        .collect())
}

fn quote_ident(d: Dialect, s: &str) -> String {
    match d {
        Dialect::Mysql | Dialect::Clickhouse => format!("`{}`", s.replace('`', "``")),
        Dialect::Mssql => format!("[{}]", s.replace(']', "]]")),
        _ => format!("\"{}\"", s.replace('"', "\"\"")),
    }
}

async fn generated_table_ddl(s: &dyn Session, schema: &str, table: &str) -> Result<String> {
    let d = s.dialect();
    let cols = columns(s, schema, table).await?;
    let mut lines: Vec<String> = cols
        .iter()
        .map(|c| {
            let mut l = format!("  {} {}", quote_ident(d, &c.name), c.data_type);
            if let Some(def) = &c.default_value {
                l.push_str(&format!(" DEFAULT {def}"));
            }
            if !c.nullable {
                l.push_str(" NOT NULL");
            }
            l
        })
        .collect();
    let pk: Vec<String> = cols.iter().filter(|c| c.primary_key).map(|c| quote_ident(d, &c.name)).collect();
    if !pk.is_empty() {
        lines.push(format!("  PRIMARY KEY ({})", pk.join(", ")));
    }
    Ok(format!(
        "CREATE TABLE {}.{} (\n{}\n);",
        quote_ident(d, schema),
        quote_ident(d, table),
        lines.join(",\n")
    ))
}

pub async fn ddl(s: &dyn Session, schema: &str, name: &str, kind: &str) -> Result<String> {
    if let Some(v) = s.native_ddl(schema, name, kind).await? {
        return Ok(v);
    }
    let (qs, qn) = (lit(schema), lit(name));
    let first = |r: Vec<Vec<Cell>>, col: usize| {
        r.iter().map(|row| text(row.get(col))).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n\n")
    };
    match s.dialect() {
        Dialect::Clickhouse => {
            let obj = format!("{}.{}", quote_ident(Dialect::Clickhouse, schema), quote_ident(Dialect::Clickhouse, name));
            Ok(first(rows(s, &format!("SHOW CREATE TABLE {obj}")).await?, 0))
        }
        d @ (Dialect::Redis | Dialect::Mongo | Dialect::Neo4j | Dialect::Janus | Dialect::Elastic) => bail!("{d:?}: DDL not supported"),
        Dialect::Oracle => match kind {
            // Built from the dictionary in milliseconds (DBMS_METADATA takes seconds).
            "table" => crate::oracle_ddl::table(s, schema, name).await,
            "view" => crate::oracle_ddl::view(s, schema, name).await,
            "sequence" => crate::oracle_ddl::sequence(s, schema, name).await,
            "synonym" => crate::oracle_ddl::synonym(s, schema, name).await,
            _ => oracle_metadata_ddl(s, schema, name, kind).await,
        },
        Dialect::Mysql => {
            let obj = format!("{}.{}", quote_ident(Dialect::Mysql, schema), quote_ident(Dialect::Mysql, name));
            let (stmt, col) = match kind {
                "view" => ("VIEW", 1),
                "procedure" => ("PROCEDURE", 2),
                "function" => ("FUNCTION", 2),
                "trigger" => ("TRIGGER", 2),
                _ => ("TABLE", 1),
            };
            Ok(first(rows(s, &format!("SHOW CREATE {stmt} {obj}")).await?, col))
        }
        Dialect::Sqlite => {
            let sql = format!(
                "select sql from \"{}\".sqlite_master where name = {qn}",
                schema.replace('"', "\"\"")
            );
            Ok(first(rows(s, &sql).await?, 0))
        }
        Dialect::Mssql => match kind {
            "table" => generated_table_ddl(s, schema, name).await,
            _ => {
                let sql = format!("select object_definition(object_id(quotename({qs}) + '.' + quotename({qn})))");
                Ok(first(rows(s, &sql).await?, 0))
            }
        },
        Dialect::Postgres => match kind {
            "view" | "materialized view" => {
                let sql = format!(
                    "select pg_get_viewdef(c.oid, true) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = {qs} and c.relname = {qn}"
                );
                let body = first(rows(s, &sql).await?, 0);
                let mat = if kind == "view" { "" } else { "MATERIALIZED " };
                Ok(format!(
                    "CREATE OR REPLACE {mat}VIEW {}.{} AS\n{body}",
                    quote_ident(Dialect::Postgres, schema),
                    quote_ident(Dialect::Postgres, name)
                ))
            }
            "function" | "procedure" => {
                let sql = format!(
                    "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = {qs} and p.proname = {qn}"
                );
                Ok(first(rows(s, &sql).await?, 0))
            }
            "trigger" => {
                let sql = format!(
                    "select pg_get_triggerdef(t.oid, true) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = {qs} and t.tgname = {qn}"
                );
                Ok(first(rows(s, &sql).await?, 0))
            }
            "sequence" => Ok(format!(
                "CREATE SEQUENCE {}.{};",
                quote_ident(Dialect::Postgres, schema),
                quote_ident(Dialect::Postgres, name)
            )),
            _ => generated_table_ddl(s, schema, name).await,
        },
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub name: String,
    pub table: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

/// Foreign keys declared by tables in `schema` (one entry per constraint).
pub async fn foreign_keys(s: &dyn Session, schema: &str) -> Result<Vec<ForeignKey>> {
    let q = lit(schema);
    // Every query yields (constraint, table, column, ref_schema, ref_table, ref_column) ordered by constraint + position.
    let sql = match s.dialect() {
        Dialect::Postgres => format!(
            "select c.conname, cl.relname, a.attname, rn.nspname, rc.relname, ra.attname
             from pg_constraint c
             join pg_class cl on cl.oid = c.conrelid join pg_namespace n on n.oid = cl.relnamespace
             join pg_class rc on rc.oid = c.confrelid join pg_namespace rn on rn.oid = rc.relnamespace
             cross join lateral unnest(c.conkey, c.confkey) with ordinality as k(col, rcol, ord)
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.col
             join pg_attribute ra on ra.attrelid = c.confrelid and ra.attnum = k.rcol
             where c.contype = 'f' and n.nspname = {q} order by c.conname, cl.relname, k.ord"
        ),
        Dialect::Mysql => format!(
            "select constraint_name, table_name, column_name, referenced_table_schema, referenced_table_name, referenced_column_name
             from information_schema.key_column_usage where table_schema = {q} and referenced_table_name is not null
             order by constraint_name, table_name, ordinal_position"
        ),
        Dialect::Sqlite => format!(
            "select m.name || '_fk' || p.id, m.name, p.\"from\", {q}, p.\"table\", coalesce(p.\"to\", '')
             from \"{}\".sqlite_master m join pragma_foreign_key_list(m.name, {q}) p where m.type = 'table' order by m.name, p.id, p.seq",
            schema.replace('"', "\"\"")
        ),
        Dialect::Mssql => format!(
            "select fk.name, t.name, c.name, rs.name, rt.name, rc.name
             from sys.foreign_keys fk
             join sys.foreign_key_columns fkc on fkc.constraint_object_id = fk.object_id
             join sys.tables t on t.object_id = fk.parent_object_id join sys.schemas s on s.schema_id = t.schema_id
             join sys.columns c on c.object_id = fkc.parent_object_id and c.column_id = fkc.parent_column_id
             join sys.tables rt on rt.object_id = fk.referenced_object_id join sys.schemas rs on rs.schema_id = rt.schema_id
             join sys.columns rc on rc.object_id = fkc.referenced_object_id and rc.column_id = fkc.referenced_column_id
             where s.name = {q} order by fk.name, fkc.constraint_column_id"
        ),
        Dialect::Oracle => format!(
            "select c.constraint_name, c.table_name, cc.column_name, r.owner, r.table_name, rc.column_name
             from all_constraints c
             join all_cons_columns cc on cc.owner = c.owner and cc.constraint_name = c.constraint_name
             join all_constraints r on r.owner = c.r_owner and r.constraint_name = c.r_constraint_name
             join all_cons_columns rc on rc.owner = r.owner and rc.constraint_name = r.constraint_name and rc.position = cc.position
             where c.constraint_type = 'R' and c.owner = {q} order by c.constraint_name, cc.position"
        ),
        _ => return Ok(vec![]),
    };
    let mut out: Vec<ForeignKey> = vec![];
    for r in rows(s, &sql).await? {
        let (name, table) = (text(r.first()), text(r.get(1)));
        match out.last_mut() {
            Some(fk) if fk.name == name && fk.table == table => {
                fk.columns.push(text(r.get(2)));
                fk.ref_columns.push(text(r.get(5)));
            }
            _ => out.push(ForeignKey {
                name,
                table,
                columns: vec![text(r.get(2))],
                ref_schema: text(r.get(3)),
                ref_table: text(r.get(4)),
                ref_columns: vec![text(r.get(5))],
            }),
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePart {
    /// "Spec" | "Body" | "Source"
    pub label: String,
    /// Oracle object type of this part (PACKAGE, PACKAGE BODY, …); empty for other engines.
    pub object_type: String,
    pub text: String,
    pub created: String,
    pub last_ddl: String,
    pub status: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceError {
    pub object_type: String,
    pub line: i64,
    pub position: i64,
    pub text: String,
    pub attribute: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectSource {
    pub parts: Vec<SourcePart>,
    pub errors: Vec<SourceError>,
}

fn oracle_types(kind: &str) -> Vec<(&'static str, &'static str)> {
    match kind {
        "package" | "package body" => vec![("Spec", "PACKAGE"), ("Body", "PACKAGE BODY")],
        "type" | "type body" => vec![("Spec", "TYPE"), ("Body", "TYPE BODY")],
        "procedure" => vec![("Source", "PROCEDURE")],
        "function" => vec![("Source", "FUNCTION")],
        "trigger" => vec![("Source", "TRIGGER")],
        _ => vec![],
    }
}

/// Stored program source split into parts (Oracle: spec + body from ALL_SOURCE, with status and
/// compile errors). Other engines return their DDL as a single part.
pub async fn source(s: &dyn Session, schema: &str, name: &str, kind: &str) -> Result<ObjectSource> {
    let types = oracle_types(kind);
    if s.dialect() != Dialect::Oracle || types.is_empty() {
        let text = ddl(s, schema, name, kind).await?;
        return Ok(ObjectSource {
            parts: vec![SourcePart {
                label: "Source".into(),
                object_type: String::new(),
                text,
                created: String::new(),
                last_ddl: String::new(),
                status: String::new(),
            }],
            errors: vec![],
        });
    }
    let (qs, qn) = (lit(schema), lit(name));
    let mut parts = vec![];
    for (label, ty) in &types {
        let t = lit(ty);
        let lines = rows(s, &format!("select text from all_source where owner = {qs} and name = {qn} and type = {t} order by line")).await?;
        if lines.is_empty() {
            continue;
        }
        let mut src: String = lines.iter().map(|r| text(r.first())).collect();
        // ALL_SOURCE starts at "PACKAGE X AS"; make it a runnable statement.
        let trimmed = src.trim_start();
        if !trimmed.to_ascii_uppercase().starts_with("CREATE") {
            src = format!("CREATE OR REPLACE {trimmed}");
        }
        let info = rows(
            s,
            &format!(
                "select to_char(created, 'MM/DD/YYYY HH:MI:SS AM'), to_char(last_ddl_time, 'MM/DD/YYYY HH:MI:SS AM'), status
                 from all_objects where owner = {qs} and object_name = {qn} and object_type = {t}"
            ),
        )
        .await?;
        let r = info.first();
        parts.push(SourcePart {
            label: label.to_string(),
            object_type: ty.to_string(),
            text: src.trim_end().to_string(),
            created: r.map(|r| text(r.first())).unwrap_or_default(),
            last_ddl: r.map(|r| text(r.get(1))).unwrap_or_default(),
            status: r.map(|r| text(r.get(2))).unwrap_or_default(),
        });
    }
    let type_list = types.iter().map(|(_, t)| lit(t)).collect::<Vec<_>>().join(", ");
    let errors = rows(
        s,
        &format!(
            "select type, line, position, text, attribute from all_errors
             where owner = {qs} and name = {qn} and type in ({type_list}) order by type, sequence"
        ),
    )
    .await?
    .iter()
    .map(|r| SourceError {
        object_type: text(r.first()),
        line: text(r.get(1)).parse().unwrap_or(0),
        position: text(r.get(2)).parse().unwrap_or(0),
        text: text(r.get(3)).trim().to_string(),
        attribute: text(r.get(4)),
    })
    .collect();
    Ok(ObjectSource { parts, errors })
}

/// Oracle name resolution for "go to object": the object in `schema`, else a private or public
/// synonym pointing at it. Other engines return None (the UI searches its explorer cache).
pub async fn resolve_object(s: &dyn Session, schema: &str, name: &str) -> Result<Option<DbObject>> {
    if s.dialect() != Dialect::Oracle {
        return Ok(None);
    }
    let (qs, qn) = (lit(schema), lit(name));
    let kinds = "'TABLE','VIEW','MATERIALIZED VIEW','PROCEDURE','FUNCTION','PACKAGE','SEQUENCE','TRIGGER','TYPE'";
    let direct = rows(
        s,
        &format!("select owner, object_name, lower(object_type) from all_objects where owner = {qs} and object_name = {qn} and object_type in ({kinds}) order by decode(object_type, 'TABLE', 0, 'VIEW', 1, 2)"),
    )
    .await?;
    if let Some(r) = direct.first() {
        return Ok(Some(DbObject { schema: text(r.first()), name: text(r.get(1)), kind: text(r.get(2)) }));
    }
    let syn = rows(
        s,
        &format!(
            "select o.owner, o.object_name, lower(o.object_type)
             from all_synonyms y join all_objects o on o.owner = y.table_owner and o.object_name = y.table_name
             where y.synonym_name = {qn} and y.owner in ({qs}, 'PUBLIC') and o.object_type in ({kinds})
             order by decode(y.owner, 'PUBLIC', 1, 0), decode(o.object_type, 'TABLE', 0, 'VIEW', 1, 2)"
        ),
    )
    .await?;
    Ok(syn.first().map(|r| DbObject { schema: text(r.first()), name: text(r.get(1)), kind: text(r.get(2)) }))
}

/// Exact DDL via DBMS_METADATA (slow on Oracle, but includes storage and partition clauses).
pub async fn oracle_metadata_ddl(s: &dyn Session, schema: &str, name: &str, kind: &str) -> Result<String> {
    let k = kind.to_ascii_uppercase().replace(' ', "_");
    // Skip storage/segment noise; terminate statements with ';'.
    let _ = s
        .exec("begin dbms_metadata.set_transform_param(dbms_metadata.session_transform, 'SQLTERMINATOR', true); dbms_metadata.set_transform_param(dbms_metadata.session_transform, 'SEGMENT_ATTRIBUTES', false); end;")
        .await;
    let r = rows(s, &format!("select dbms_metadata.get_ddl({}, {}, {}) from dual", lit(&k), lit(name), lit(schema))).await?;
    let mut ddl_text = r.first().map(|x| text(x.first())).unwrap_or_default().trim().to_string();
    if k == "TABLE" {
        // add dependent indexes / comments like Toad's full script
        for (dep, label) in [("INDEX", "indexes"), ("COMMENT", "comments")] {
            let extra = rows(s, &format!("select dbms_metadata.get_dependent_ddl({}, {}, {}) from dual", lit(dep), lit(name), lit(schema))).await;
            if let Ok(e) = extra {
                let e = e.first().map(|x| text(x.first())).unwrap_or_default();
                if !e.trim().is_empty() {
                    ddl_text.push_str(&format!("

-- {label}
{}", e.trim()));
                }
            }
        }
    }
    Ok(ddl_text)
}
