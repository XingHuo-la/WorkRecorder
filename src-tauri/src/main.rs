#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod notes_fs;

use tauri::Manager;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use chrono::Local;
use rusqlite::Connection;
use rusqlite::types::ValueRef; // 🌟 引入数据库值解析器

fn get_config_path() -> PathBuf { std::env::current_dir().unwrap_or_default().join("path_config.txt") }
fn get_data_file_path() -> String {
    let config_path = get_config_path();
    if let Ok(custom_path) = fs::read_to_string(&config_path) {
        let trimmed = custom_path.trim().to_string();
        if !trimmed.is_empty() { return trimmed; }
    }
    std::env::current_dir().unwrap_or_default().join("my_data.json").to_string_lossy().to_string()
}
fn get_db_file_path() -> String {
    let mut path = PathBuf::from(get_data_file_path());
    path.set_extension("db");
    path.to_string_lossy().to_string()
}

// 全库累计变更行数（含触发器内部产生的变更）。
// 这个 rusqlite 版本没有 Connection::total_changes 方法，走 SQL 内置函数。
// 为什么需要它：changes() 不统计触发器里的改动，而 v10 之后
// logs / todos / sheet_row 的写入全部由 INSTEAD OF 触发器转译到 record ——
// 用 changes() 会得到 0，前端把它当成「保存失败」。
fn total_changes(conn: &Connection) -> i64 {
    conn.query_row("SELECT total_changes()", [], |row| row.get(0))
        .unwrap_or(0)
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table)).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;

    for row in rows {
        if row.map_err(|e| e.to_string())? == column {
            return Ok(true);
        }
    }

    Ok(false)
}

fn add_column_if_missing(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<(), String> {
    if !table_has_column(conn, table, column)? {
        conn.execute(&format!("ALTER TABLE {} ADD COLUMN {}", table, definition), [])
            .map_err(|e| format!("添加字段 {}.{} 失败: {}", table, column, e))?;
    }

    Ok(())
}

// 🛡️ 应用启动时的数据迁移逻辑
fn init_and_migrate_db() -> Result<(), String> {
    init_and_migrate_db_at(&get_db_file_path(), &get_data_file_path())
}

// 参数化的版本：迁移逻辑不读全局路径，测试才能拿数据库副本跑一遍。
// 迁移是不可逆的（改表名、建视图），必须在副本上验证过再让它碰真实数据。
fn init_and_migrate_db_at(db_path: &str, json_path: &str) -> Result<(), String> {
    let mut conn = Connection::open(db_path).map_err(|e| format!("无法打开数据库: {}", e))?;

    conn.execute_batch(
        "BEGIN;
        CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, done BOOLEAN NOT NULL, tag TEXT, sub_tag TEXT, detail TEXT, remark TEXT, deadline TEXT, completed_at TEXT);
        CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, time TEXT NOT NULL, text TEXT NOT NULL, tag TEXT, sub_tag TEXT, detail TEXT, remark TEXT, linked_todo TEXT, deadline TEXT, is_overdue BOOLEAN);
        CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, content TEXT NOT NULL, note_type TEXT, status TEXT, tag TEXT, sub_tag TEXT, source_type TEXT, source_id INTEGER, created_at TEXT, updated_at TEXT);
        CREATE TABLE IF NOT EXISTS tags (name TEXT PRIMARY KEY, is_active BOOLEAN);
        CREATE TABLE IF NOT EXISTS sub_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, main_tag TEXT NOT NULL, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS freecell_games (id INTEGER PRIMARY KEY AUTOINCREMENT, deal_key TEXT NOT NULL, result TEXT NOT NULL, duration_seconds INTEGER NOT NULL, move_count INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL);
        COMMIT;"
    ).map_err(|e| format!("建表失败: {}", e))?;

    let schema_version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);

    if schema_version < 2 {
        add_column_if_missing(&conn, "todos", "parent_id", "parent_id INTEGER")?;
        add_column_if_missing(&conn, "todos", "start_at", "start_at TEXT")?;
        add_column_if_missing(&conn, "todos", "end_at", "end_at TEXT")?;
        add_column_if_missing(&conn, "todos", "sort_order", "sort_order INTEGER DEFAULT 0")?;
        conn.execute_batch("PRAGMA user_version = 2;")
            .map_err(|e| format!("数据库升级到 v2 失败: {}", e))?;
    }

    if schema_version < 3 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT,
                content TEXT NOT NULL,
                note_type TEXT,
                status TEXT,
                tag TEXT,
                sub_tag TEXT,
                source_type TEXT,
                source_id INTEGER,
                created_at TEXT,
                updated_at TEXT
            );
            PRAGMA user_version = 3;"
        ).map_err(|e| format!("数据库升级到 v3 失败: {}", e))?;
    }

    if schema_version < 4 {
        add_column_if_missing(&conn, "logs", "status", "status TEXT DEFAULT 'processed'")?;
        add_column_if_missing(&conn, "logs", "record_type", "record_type TEXT DEFAULT 'log'")?;
        conn.execute_batch("PRAGMA user_version = 4;")
            .map_err(|e| format!("数据库升级到 v4 失败: {}", e))?;
    }

    if schema_version < 5 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS freecell_games (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                deal_key TEXT NOT NULL,
                result TEXT NOT NULL,
                duration_seconds INTEGER NOT NULL,
                move_count INTEGER NOT NULL,
                started_at TEXT NOT NULL,
                ended_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_freecell_games_ended_at ON freecell_games(ended_at DESC);
            PRAGMA user_version = 5;"
        ).map_err(|e| format!("数据库升级到 v5 失败: {}", e))?;
    }

    // v6：笔记改为「文件优先」。正文只存在磁盘 .md 文件里，
    // note_index 仅保存元数据索引与相对路径，便于快速列表与搜索。
    if schema_version < 6 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS note_index (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                rel_path TEXT NOT NULL UNIQUE,
                title TEXT,
                note_type TEXT,
                status TEXT,
                tag TEXT,
                sub_tag TEXT,
                created_at TEXT,
                updated_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_note_index_updated_at ON note_index(updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_note_index_tag ON note_index(tag, sub_tag);
            PRAGMA user_version = 6;"
        ).map_err(|e| format!("数据库升级到 v6 失败: {}", e))?;
    }

    // v7：字段 Schema 化（「表格视图」改造的数据地基）。
    // field_def 描述实体的每个字段（列）：类型 / 选项 / 排序 / 显隐；
    // todos / logs / notes 预留 custom 列，存 JSON 扩展值（附件等）。
    // 纯增量：不动任何现有列与数据，删掉新表新列即可回滚。
    if schema_version < 7 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS field_def (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity TEXT NOT NULL,
                key TEXT NOT NULL,
                label TEXT NOT NULL,
                type TEXT NOT NULL,
                options TEXT,
                sort INTEGER DEFAULT 0,
                visible INTEGER DEFAULT 1,
                builtin INTEGER DEFAULT 0,
                UNIQUE(entity, key)
            );"
        ).map_err(|e| format!("创建 field_def 失败: {}", e))?;
        add_column_if_missing(&conn, "todos", "custom", "custom TEXT")?;
        add_column_if_missing(&conn, "logs", "custom", "custom TEXT")?;
        add_column_if_missing(&conn, "notes", "custom", "custom TEXT")?;

        // 内置字段种子（当前只建 log 实体）。幂等：UNIQUE(entity, key) + INSERT OR IGNORE。
        let seeds: [(&str, &str, &str, &str, Option<&str>, i64, i64); 7] = [
            ("log", "text", "内容", "text", None, 0, 1),
            ("log", "tag", "主分类", "select", Some(r#"{"source":"tags"}"#), 1, 1),
            ("log", "sub_tag", "标签", "multi_select", Some(r#"{"source":"sub_tags"}"#), 2, 1),
            ("log", "date", "时间", "date", None, 3, 1),
            ("log", "attachments", "附件", "attachment", None, 4, 1),
            ("log", "status", "状态", "select", Some(r#"{"source":"custom","options":[{"value":"pending","label":"待开始","tone":"muted"},{"value":"doing","label":"进行中","tone":"doing"},{"value":"done","label":"已完成","tone":"done"},{"value":"unprocessed","label":"待整理","tone":"inbox"}]}"#), 5, 1),
            ("log", "detail", "说明", "text", None, 6, 1),
        ];
        for (entity, key, label, ftype, options, sort, builtin) in seeds {
            conn.execute(
                "INSERT OR IGNORE INTO field_def (entity, key, label, type, options, sort, visible, builtin) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)",
                rusqlite::params![entity, key, label, ftype, options, sort, builtin],
            ).map_err(|e| format!("写入内置字段定义失败: {}", e))?;
        }

        conn.execute_batch("PRAGMA user_version = 7;")
            .map_err(|e| format!("数据库升级到 v7 失败: {}", e))?;
    }

    // v8：多表（sheet）。一个任务下可以有多张表，每张表有自己的字段与记录。
    //
    // 关键决策：行数据整条存 JSON（sheet_row.data），不按字段拆列。
    // 加列 / 改类型 / 换选项都不需要迁移表结构，这是「加一列就卡」的根因解法。
    // 代价是无法用 SQL 直接按字段筛选，但单人本地数据量下，前端过滤足够快。
    if schema_version < 8 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sheet (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                task_id INTEGER,
                created_at TEXT,
                updated_at TEXT,
                sort INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS sheet_field (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sheet_id INTEGER NOT NULL,
                key TEXT NOT NULL,
                label TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'text',
                options TEXT,
                width INTEGER DEFAULT 160,
                sort INTEGER DEFAULT 0,
                visible INTEGER DEFAULT 1,
                UNIQUE(sheet_id, key)
            );
            CREATE TABLE IF NOT EXISTS sheet_row (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sheet_id INTEGER NOT NULL,
                data TEXT NOT NULL DEFAULT '{}',
                sort INTEGER DEFAULT 0,
                created_at TEXT,
                updated_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_sheet_row_sheet ON sheet_row(sheet_id, sort, id);
            PRAGMA user_version = 8;"
        ).map_err(|e| format!("数据库升级到 v8 失败: {}", e))?;
    }

    // v9：行高。NULL / 0 表示「自动」，由内容或用户手动设置决定。
    // 单独一列而不是塞进 data JSON，是因为行高影响渲染顺序与虚拟滚动，
    // 放在 SQL 层能直接参与排序和分页查询。
    if schema_version < 9 {
        add_column_if_missing(&conn, "sheet_row", "height", "height INTEGER")?;
        conn.execute_batch("PRAGMA user_version = 9;")
            .map_err(|e| format!("数据库升级到 v9 失败: {}", e))?;
    }

    // v10：统一记录表（logs / todos / sheet_row → record）。
    //
    // 动机：这三张表是「同一件事的三种身份」。用户录入时必须先判断
    // 「这是流水、待办还是表格行」才能动手，这是设计强加给用户的架构决策。
    // 合并后 kind 只是过滤器，status 是字段：
    //     流水   = kind='log'
    //     待办   = kind='todo' AND status != 'done'
    //     表格行 = kind='sheet_row' AND sheet_id = ?
    //
    // 兼容策略（本迁移的关键）：旧表改名为 *_legacy 做只读备份，同时建立
    // **同名可写视图**，用 INSTEAD OF 触发器把读写转译到 record。这样前端
    // 现有 90 余处 SQL 一行都不用改，风险收敛到「视图列名必须与旧表完全一致」。
    // 验证过两个已知陷阱：代码里没有 last_insert_rowid 依赖，也没有
    // INSERT ... ON CONFLICT（视图不支持 UPSERT）。
    if schema_version < 10 {
        // 重入保护：已经是视图说明上次迁移完成、只是版本号没落盘。
        let logs_is_view: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'view' AND name = 'logs'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        if logs_is_view == 0 {
            // 迁移前整库备份。数据只有几十行，但一旦迁移写坏就是不可逆的，
            // 留一份原样文件比任何回滚代码都可靠。
            let backup_path = format!("{}.before-record-v10", db_path);
            if !Path::new(&backup_path).exists() {
                fs::copy(&db_path, &backup_path)
                    .map_err(|e| format!("备份数据库失败: {}", e))?;
            }

            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS record (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL DEFAULT 'log',
                    title TEXT NOT NULL DEFAULT '',
                    body TEXT DEFAULT '',
                    remark TEXT DEFAULT '',
                    status TEXT DEFAULT 'done',
                    happened_date TEXT DEFAULT '',
                    happened_time TEXT DEFAULT '',
                    deadline TEXT DEFAULT '',
                    tag TEXT DEFAULT '',
                    sub_tag TEXT DEFAULT '',
                    parent_id INTEGER,
                    linked_todo TEXT DEFAULT '',
                    is_overdue INTEGER DEFAULT 0,
                    record_type TEXT DEFAULT '',
                    sheet_id INTEGER,
                    sort REAL DEFAULT 0,
                    height INTEGER,
                    start_at TEXT DEFAULT '',
                    end_at TEXT DEFAULT '',
                    completed_at TEXT DEFAULT '',
                    custom TEXT DEFAULT '{}',
                    legacy_id INTEGER,
                    created_at TEXT DEFAULT '',
                    updated_at TEXT DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_record_kind_date ON record(kind, happened_date DESC, happened_time DESC);
                CREATE INDEX IF NOT EXISTS idx_record_kind_status ON record(kind, status);
                CREATE INDEX IF NOT EXISTS idx_record_sheet ON record(sheet_id, sort, id);
                CREATE INDEX IF NOT EXISTS idx_record_tag ON record(tag, sub_tag);
                CREATE INDEX IF NOT EXISTS idx_record_legacy ON record(kind, legacy_id);"
            ).map_err(|e| format!("创建 record 表失败: {}", e))?;

            // 迁移用纯 SQL 完成：legacy_id 保留原 id，后续靠自连接重映射引用。
            // todos 先插，因为 logs.linked_todo 指向它。
            conn.execute_batch(
                "BEGIN;
                INSERT INTO record (kind, title, body, remark, status, deadline, tag, sub_tag,
                                    parent_id, start_at, end_at, completed_at, sort, custom,
                                    legacy_id, created_at, updated_at)
                SELECT 'todo', COALESCE(task, ''), COALESCE(detail, ''), COALESCE(remark, ''),
                       CASE WHEN done IN (1, '1', 'true', 'TRUE', 'True') THEN 'done' ELSE 'pending' END,
                       COALESCE(deadline, ''), COALESCE(tag, ''), COALESCE(sub_tag, ''),
                       CASE WHEN parent_id IS NULL OR parent_id = '' THEN NULL ELSE CAST(parent_id AS INTEGER) END,
                       COALESCE(start_at, ''), COALESCE(end_at, ''), COALESCE(completed_at, ''),
                       COALESCE(sort_order, 0), COALESCE(custom, '{}'), id, '', ''
                FROM todos ORDER BY id;

                INSERT INTO record (kind, title, body, remark, status, happened_date, happened_time,
                                    deadline, tag, sub_tag, linked_todo, is_overdue, record_type,
                                    custom, legacy_id, created_at, updated_at)
                SELECT 'log', COALESCE(text, ''), COALESCE(detail, ''), COALESCE(remark, ''),
                       CASE WHEN status = 'unprocessed' THEN 'inbox' ELSE 'done' END,
                       COALESCE(date, ''), COALESCE(time, ''), COALESCE(deadline, ''),
                       COALESCE(tag, ''), COALESCE(sub_tag, ''), COALESCE(linked_todo, ''),
                       CASE WHEN is_overdue IN (1, '1', 'true', 'TRUE', 'True') THEN 1 ELSE 0 END,
                       COALESCE(record_type, 'log'), COALESCE(custom, '{}'), id,
                       TRIM(COALESCE(date, '') || ' ' || COALESCE(time, '')),
                       TRIM(COALESCE(date, '') || ' ' || COALESCE(time, ''))
                FROM logs ORDER BY id;

                INSERT INTO record (kind, title, body, sheet_id, sort, height, custom,
                                    legacy_id, created_at, updated_at)
                SELECT 'sheet_row', '', '', sheet_id, COALESCE(sort, 0), height,
                       COALESCE(data, '{}'), id, COALESCE(created_at, ''), COALESCE(updated_at, '')
                FROM sheet_row ORDER BY id;

                -- 引用重映射：旧 id → 新 id。找不到对应记录时置空（原本就是悬空引用）。
                UPDATE record SET parent_id = (
                    SELECT p.id FROM record p WHERE p.kind = 'todo' AND p.legacy_id = record.parent_id
                ) WHERE kind = 'todo' AND parent_id IS NOT NULL;

                UPDATE record SET linked_todo = (
                    SELECT t.id FROM record t
                    WHERE t.kind = 'todo' AND CAST(t.legacy_id AS TEXT) = record.linked_todo
                ) WHERE kind = 'log' AND linked_todo IS NOT NULL AND linked_todo != '';
                COMMIT;"
            ).map_err(|e| format!("迁移数据到 record 失败: {}", e))?;

            // 旧表退位为只读备份，同名视图接管原表名。
            conn.execute_batch(
                "ALTER TABLE logs RENAME TO logs_legacy;
                 ALTER TABLE todos RENAME TO todos_legacy;
                 ALTER TABLE sheet_row RENAME TO sheet_row_legacy;

                 CREATE VIEW logs AS SELECT
                     id,
                     happened_date AS date,
                     happened_time AS time,
                     title AS text,
                     tag, sub_tag,
                     body AS detail,
                     remark,
                     linked_todo,
                     deadline,
                     is_overdue,
                     CASE WHEN status = 'inbox' THEN 'unprocessed' ELSE 'processed' END AS status,
                     record_type,
                     custom
                 FROM record WHERE kind = 'log';

                 CREATE VIEW todos AS SELECT
                     id,
                     title AS task,
                     -- 必须输出字符串 'true'/'false'，不能输出 1/0。
                     -- 原表 done 列一直存的是字符串（前端 params 全部 map(String)），
                     -- 代码里既有 `WHERE done = 'true'` 也有 `done === 'true'` 判断；
                     -- 改成整数会让「清理已完成待办」静默失效（一条都删不掉）。
                     CASE WHEN status = 'done' THEN 'true' ELSE 'false' END AS done,
                     tag, sub_tag,
                     body AS detail,
                     remark, deadline, completed_at,
                     parent_id,
                     start_at, end_at,
                     CAST(sort AS INTEGER) AS sort_order,
                     custom
                 FROM record WHERE kind = 'todo';

                 CREATE VIEW sheet_row AS SELECT
                     id, sheet_id, custom AS data, CAST(sort AS INTEGER) AS sort,
                     created_at, updated_at, height
                 FROM record WHERE kind = 'sheet_row';"
            ).map_err(|e| format!("旧表改建为视图失败: {}", e))?;

            // 写入转译。NEW.* 是「视图整行」——UPDATE 未提及的列取当前值，
            // 所以 `UPDATE logs SET remark=?` 这类单列更新不会把其他列抹掉。
            conn.execute_batch(
                "CREATE TRIGGER logs_insert INSTEAD OF INSERT ON logs BEGIN
                    INSERT INTO record (kind, title, body, remark, status, happened_date,
                                        happened_time, deadline, tag, sub_tag, linked_todo,
                                        is_overdue, record_type, custom, created_at, updated_at)
                    VALUES ('log', COALESCE(NEW.text, ''), COALESCE(NEW.detail, ''),
                            COALESCE(NEW.remark, ''),
                            CASE WHEN NEW.status = 'unprocessed' THEN 'inbox' ELSE 'done' END,
                            COALESCE(NEW.date, ''), COALESCE(NEW.time, ''),
                            COALESCE(NEW.deadline, ''), COALESCE(NEW.tag, ''),
                            COALESCE(NEW.sub_tag, ''), COALESCE(NEW.linked_todo, ''),
                            CASE WHEN NEW.is_overdue IN (1, '1', 'true', 'TRUE', 'True') THEN 1 ELSE 0 END,
                            COALESCE(NEW.record_type, 'log'), COALESCE(NEW.custom, '{}'),
                            TRIM(COALESCE(NEW.date, '') || ' ' || COALESCE(NEW.time, '')),
                            TRIM(COALESCE(NEW.date, '') || ' ' || COALESCE(NEW.time, '')));
                 END;

                 CREATE TRIGGER logs_update INSTEAD OF UPDATE ON logs BEGIN
                    UPDATE record SET
                        title = COALESCE(NEW.text, ''),
                        body = COALESCE(NEW.detail, ''),
                        remark = COALESCE(NEW.remark, ''),
                        status = CASE WHEN NEW.status = 'unprocessed' THEN 'inbox' ELSE 'done' END,
                        happened_date = COALESCE(NEW.date, ''),
                        happened_time = COALESCE(NEW.time, ''),
                        deadline = COALESCE(NEW.deadline, ''),
                        tag = COALESCE(NEW.tag, ''),
                        sub_tag = COALESCE(NEW.sub_tag, ''),
                        linked_todo = COALESCE(NEW.linked_todo, ''),
                        is_overdue = CASE WHEN NEW.is_overdue IN (1, '1', 'true', 'TRUE', 'True') THEN 1 ELSE 0 END,
                        record_type = COALESCE(NEW.record_type, 'log'),
                        custom = COALESCE(NEW.custom, '{}')
                    WHERE id = OLD.id;
                 END;

                 CREATE TRIGGER logs_delete INSTEAD OF DELETE ON logs BEGIN
                    DELETE FROM record WHERE id = OLD.id;
                 END;

                 CREATE TRIGGER todos_insert INSTEAD OF INSERT ON todos BEGIN
                    INSERT INTO record (kind, title, body, remark, status, deadline, tag, sub_tag,
                                        parent_id, start_at, end_at, completed_at, sort, custom,
                                        created_at, updated_at)
                    VALUES ('todo', COALESCE(NEW.task, ''), COALESCE(NEW.detail, ''),
                            COALESCE(NEW.remark, ''),
                            CASE WHEN NEW.done IN (1, '1', 'true', 'TRUE', 'True') THEN 'done' ELSE 'pending' END,
                            COALESCE(NEW.deadline, ''), COALESCE(NEW.tag, ''),
                            COALESCE(NEW.sub_tag, ''),
                            CASE WHEN NEW.parent_id IS NULL OR NEW.parent_id = '' OR CAST(NEW.parent_id AS INTEGER) = 0
                                 THEN NULL ELSE CAST(NEW.parent_id AS INTEGER) END,
                            COALESCE(NEW.start_at, ''), COALESCE(NEW.end_at, ''),
                            COALESCE(NEW.completed_at, ''), COALESCE(NEW.sort_order, 0),
                            COALESCE(NEW.custom, '{}'), '', '');
                 END;

                 CREATE TRIGGER todos_update INSTEAD OF UPDATE ON todos BEGIN
                    UPDATE record SET
                        title = COALESCE(NEW.task, ''),
                        body = COALESCE(NEW.detail, ''),
                        remark = COALESCE(NEW.remark, ''),
                        status = CASE WHEN NEW.done IN (1, '1', 'true', 'TRUE', 'True') THEN 'done' ELSE 'pending' END,
                        deadline = COALESCE(NEW.deadline, ''),
                        tag = COALESCE(NEW.tag, ''),
                        sub_tag = COALESCE(NEW.sub_tag, ''),
                        parent_id = CASE WHEN NEW.parent_id IS NULL OR NEW.parent_id = '' OR CAST(NEW.parent_id AS INTEGER) = 0
                                         THEN NULL ELSE CAST(NEW.parent_id AS INTEGER) END,
                        start_at = COALESCE(NEW.start_at, ''),
                        end_at = COALESCE(NEW.end_at, ''),
                        completed_at = COALESCE(NEW.completed_at, ''),
                        sort = COALESCE(NEW.sort_order, 0),
                        custom = COALESCE(NEW.custom, '{}')
                    WHERE id = OLD.id;
                 END;

                 CREATE TRIGGER todos_delete INSTEAD OF DELETE ON todos BEGIN
                    DELETE FROM record WHERE id = OLD.id;
                 END;

                 CREATE TRIGGER sheet_row_insert INSTEAD OF INSERT ON sheet_row BEGIN
                    INSERT INTO record (kind, title, body, sheet_id, sort, height, custom,
                                        created_at, updated_at)
                    VALUES ('sheet_row', '', '', NEW.sheet_id, COALESCE(NEW.sort, 0), NEW.height,
                            COALESCE(NEW.data, '{}'), COALESCE(NEW.created_at, ''),
                            COALESCE(NEW.updated_at, ''));
                 END;

                 CREATE TRIGGER sheet_row_update INSTEAD OF UPDATE ON sheet_row BEGIN
                    UPDATE record SET
                        sheet_id = NEW.sheet_id,
                        sort = COALESCE(NEW.sort, 0),
                        height = NEW.height,
                        custom = COALESCE(NEW.data, '{}'),
                        updated_at = COALESCE(NEW.updated_at, '')
                    WHERE id = OLD.id;
                 END;

                 CREATE TRIGGER sheet_row_delete INSTEAD OF DELETE ON sheet_row BEGIN
                    DELETE FROM record WHERE id = OLD.id;
                 END;"
            ).map_err(|e| format!("创建写转译触发器失败: {}", e))?;
        }

        conn.execute_batch("PRAGMA user_version = 10;")
            .map_err(|e| format!("数据库升级到 v10 失败: {}", e))?;
    }

    // v11：「以表格为核心」的数据地基。**只加索引与一列，一个字符都不碰视图与触发器。**
    //
    // 为什么不给视图加列：三个 INSTEAD OF UPDATE 触发器都是全列 NEW.* 覆写
    // （见 v10 的 logs_update / todos_update / sheet_row_update），加列就要重建视图
    // 与触发器，漏写一列 → 该列被 COALESCE(NEW.x, '') 静默抹成空，不报错。
    // 新代码一律 FROM record，视图只服务不打算再改的旧代码。
    if schema_version < 11 {
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_record_parent ON record(parent_id);
             CREATE INDEX IF NOT EXISTS idx_record_sheet_only ON record(sheet_id) WHERE sheet_id IS NOT NULL;
             CREATE INDEX IF NOT EXISTS idx_sheet_task_id ON sheet(task_id);",
        )
        .map_err(|e| format!("创建 v11 索引失败: {}", e))?;

        // note_index 只是 .md 文件的元数据缓存，record_id 的真相在文件的 front-matter 里。
        // 走 add_column_if_missing：老库补列，新库建表时已带该列，两条路径都安全。
        add_column_if_missing(&conn, "note_index", "record_id", "record_id INTEGER")?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_note_index_record
                 ON note_index(record_id) WHERE record_id IS NOT NULL;",
        )
        .map_err(|e| format!("创建 note_index.record_id 索引失败: {}", e))?;

        conn.execute_batch("PRAGMA user_version = 11;")
            .map_err(|e| format!("数据库升级到 v11 失败: {}", e))?;
    }

    // v12：笔记 ↔ 记录改为多对多。**只加一张派生表，一个字符都不碰 record / 视图 / 触发器。**
    //
    // 这张表不是真相：真相在 .md 的 front-matter 里（record_ids）。表随时可以
    // DROP TABLE 重建，重建的输入永远是文件（notes_list）。所以要保证的是
    // 「重建得回来」，而不是「写进去不丢」。
    // 视图与触发器一动就漏列：三个 INSTEAD OF UPDATE 触发器是全列 NEW.* 覆写，
    // 漏写一列 → 那列被 COALESCE(NEW.x,'') 静默抹成空（见 v10 的注释）。本轮没有任何理由去动它。
    if schema_version < 12 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS note_record (
                 rel_path  TEXT    NOT NULL,
                 record_id INTEGER NOT NULL,
                 PRIMARY KEY (rel_path, record_id)
             ) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS idx_note_record_record ON note_record(record_id);",
        )
        .map_err(|e| format!("创建 note_record 失败: {}", e))?;

        // 把 v11 的 note_index.record_id 搬成关联行。
        // typeof() 那个条件是必须的：历史上 params.map(String) 把 null 写成了字符串
        // 'null'（notesStore.js 的注释记着这个坑），存成 TEXT 的幽灵值
        // 会让「已关联但查不到」的条目永远清不掉。
        conn.execute_batch(
            "INSERT OR IGNORE INTO note_record (rel_path, record_id)
               SELECT rel_path, record_id FROM note_index
                WHERE record_id IS NOT NULL
                  AND typeof(record_id) = 'integer'
                  AND record_id > 0;",
        )
        .map_err(|e| format!("搬迁 note_index.record_id 失败: {}", e))?;

        conn.execute_batch("PRAGMA user_version = 12;")
            .map_err(|e| format!("数据库升级到 v12 失败: {}", e))?;
    }

    // v13：软删除。**不动视图列，只改三个 DELETE 触发器 + 加一列。**
    //
    // 为什么用 kind 后缀而不是给视图加 `WHERE deleted_at IS NULL`：
    // 视图列被 v10 的冻结测试锁着；重建视图会连带重建 9 个 INSTEAD OF 触发器，
    // 而触发器是「全列 NEW.* 覆写」——漏写一列就把那列静默抹空（见 v10 注释）。
    // 把删除标记写进 kind 之后，视图原有的 `WHERE kind='log'` 自动过滤掉软删除行，
    // 前端 90 余处 `SELECT ... FROM logs/todos/sheet_row` 一行都不用改，也不可能漏路径。
    //
    // 直读 record 的少数路径（recordStore 的 listChildren/search、board、search、sheetStore）
    // 需要各自补 `deleted_at = ''`，这些是显式清单，见前端改动。
    if schema_version < 13 {
        add_column_if_missing(&conn, "record", "deleted_at", "deleted_at TEXT DEFAULT ''")?;

        // 三个 DELETE 触发器原来都是 `DELETE FROM record WHERE id = OLD.id`（真删）。
        // 改成打标记：kind 加 '#deleted' 后缀 → 视图自动过滤；deleted_at 记时间，供回收站排序。
        // `AND kind = 'log'` 这类条件是防二次删除把后缀叠成 'log#deleted#deleted'。
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS logs_delete;
             CREATE TRIGGER logs_delete INSTEAD OF DELETE ON logs BEGIN
                 UPDATE record
                    SET deleted_at = datetime('now','localtime'),
                        kind = 'log#deleted'
                  WHERE id = OLD.id AND kind = 'log';
             END;

             DROP TRIGGER IF EXISTS todos_delete;
             CREATE TRIGGER todos_delete INSTEAD OF DELETE ON todos BEGIN
                 UPDATE record
                    SET deleted_at = datetime('now','localtime'),
                        kind = 'todo#deleted'
                  WHERE id = OLD.id AND kind = 'todo';
             END;

             DROP TRIGGER IF EXISTS sheet_row_delete;
             CREATE TRIGGER sheet_row_delete INSTEAD OF DELETE ON sheet_row BEGIN
                 UPDATE record
                    SET deleted_at = datetime('now','localtime'),
                        kind = 'sheet_row#deleted'
                  WHERE id = OLD.id AND kind = 'sheet_row';
             END;",
        )
        .map_err(|e| format!("改造删除触发器为软删除失败: {}", e))?;

        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_record_deleted
                 ON record(deleted_at) WHERE deleted_at != '';",
        )
        .map_err(|e| format!("创建软删除索引失败: {}", e))?;

        conn.execute_batch("PRAGMA user_version = 13;")
            .map_err(|e| format!("数据库升级到 v13 失败: {}", e))?;
    }

    // v14：基础表列宽可调。
    //
    // field_def.width 从 v7 建表起就是 schema 默认 160，前端一直没读过它
    // （列宽由 tablePage 里的 DEFAULT_WIDTHS 常量决定）。现在要让用户能拖宽、
    // 能双击自适应，就得有个可信的存储位；若继续全是 160，一打开表所有列
    // 会被拉成等宽，把原来调好的比例抹平。
    // 只改「还停在 schema 默认值」的行 —— 用户已经调过的宽度不能被迁移覆盖。
    if schema_version < 14 {
        // field_def 在 v7 建表时没有 width（列宽一直由前端常量决定），这里补上。
        add_column_if_missing(&conn, "field_def", "width", "width INTEGER DEFAULT 160")?;

        let log_widths: [(&str, i64); 7] = [
            ("text", 280),
            ("tag", 120),
            ("sub_tag", 170),
            ("date", 128),
            ("attachments", 96),
            ("status", 108),
            ("detail", 180),
        ];
        for (key, width) in log_widths {
            conn.execute(
                "UPDATE field_def SET width = ?1 WHERE entity = 'log' AND key = ?2 AND width = 160",
                rusqlite::params![width, key],
            )
            .map_err(|e| format!("初始化基础表列宽失败({}): {}", key, e))?;
        }
        conn.execute_batch("PRAGMA user_version = 14;")
            .map_err(|e| format!("数据库升级到 v14 失败: {}", e))?;
    }

    // v15：表 / 视图分层 —— 让「基础表」成为一张普通的预置表。
    //
    // 之前基础表是硬编码的固定项（field_def.entity='log' + kind='log' 的行），
    // 自建表是 sheet 里的行。两套身份带来的直接后果：基础表不能改名、删不掉、
    // 不出现在 sheet 列表里，看板/日历这类「绑一张表来展示」的视图也就无从绑定它。
    //
    // 这一步只加身份，不动数据：
    //   sheet.kind='preset' 的那一行 = 基础表；其余 = 自建表
    //   它的字段仍读 field_def，行仍读 kind='log' 的 record（都不复制、不搬家，
    //   否则立刻多出第二份真相，改一处忘一处就漂移）
    // 纯增量：删掉 view_def 与 kind 列即可回滚，record 一行不动。
    if schema_version < 15 {
        add_column_if_missing(&conn, "sheet", "kind", "kind TEXT NOT NULL DEFAULT 'table'")?;

        // 预置表只建一次。task_id 留空 —— 它不属于任何任务，这是它和自建表的唯一差别。
        let preset_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sheet WHERE kind = 'preset'", [], |row| row.get(0))
            .unwrap_or(0);
        if preset_count == 0 {
            // sort = -1：列表里排最前，但仍然是普通排序位，不靠前端特判。
            conn.execute(
                "INSERT INTO sheet (name, created_at, updated_at, sort, kind)
                 VALUES ('工作记录', datetime('now','localtime'), datetime('now','localtime'), -1, 'preset')",
                [],
            )
            .map_err(|e| format!("创建预置表失败: {}", e))?;
        }

        // 视图：只存配置，不存数据。form = table | board | calendar | gallery
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS view_def (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                table_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                form TEXT NOT NULL DEFAULT 'table',
                config TEXT NOT NULL DEFAULT '{}',
                sort INTEGER DEFAULT 0,
                created_at TEXT,
                updated_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_view_table ON view_def(table_id, sort, id);
            CREATE INDEX IF NOT EXISTS idx_sheet_kind ON sheet(kind, sort, id);",
        )
        .map_err(|e| format!("创建 view_def 失败: {}", e))?;

        // 每张表至少一个「表格」视图。它是默认视图：删不掉，页签上不出现关闭入口。
        conn.execute(
            "INSERT INTO view_def (table_id, name, form, config, sort, created_at, updated_at)
             SELECT s.id, '表格', 'table', '{}', 0,
                    datetime('now','localtime'), datetime('now','localtime')
               FROM sheet s
              WHERE NOT EXISTS (SELECT 1 FROM view_def v WHERE v.table_id = s.id)",
            [],
        )
        .map_err(|e| format!("为已有表补默认视图失败: {}", e))?;

        // 全局捕获（快速记录 / 剪贴板）的落点。删表时靠它兜底，不允许为空。
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value)
             SELECT 'default_table_id', CAST(id AS TEXT) FROM sheet WHERE kind = 'preset' LIMIT 1",
            [],
        )
        .map_err(|e| format!("记录默认表失败: {}", e))?;

        conn.execute_batch("PRAGMA user_version = 15;")
            .map_err(|e| format!("数据库升级到 v15 失败: {}", e))?;
    }

    // v16：预置表「内容」列默认开启自动换行。
    //
    // 之前这一列是单行列，长内容只能压成一行省略号；Sir 要的是「行高容得下就换行、
    // 超出就省略」，与自建表勾了换行的文本列同一套行为（前端 isWrap → .is-wrap）。
    // 行为落点在前端：行高未固定时仍按 styles.css 6.10 压成一行；用户拖高行
    // （row.height > 0）后由 .is-clamped + --clamp 按可用行数截断、末尾省略号。
    //
    // 只补默认值：老库里 options 本来就是 NULL；将来用户在列设置里显式关掉换行
    // （wrap:false）不该被这次迁移覆盖。迁移只跑一次，但仍判存在性，防止
    // 回滚旧版本再升级时重复进入。
    if schema_version < 16 {
        let raw: Option<String> = conn
            .query_row(
                "SELECT options FROM field_def WHERE entity = 'log' AND key = 'text'",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap_or(None);
        let mut options: serde_json::Map<String, Value> = raw
            .as_deref()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        if !options.contains_key("wrap") {
            options.insert("wrap".to_string(), Value::Bool(true));
            conn.execute(
                "UPDATE field_def SET options = ?1 WHERE entity = 'log' AND key = 'text'",
                rusqlite::params![Value::Object(options).to_string()],
            )
            .map_err(|e| format!("为「内容」字段开启自动换行失败: {}", e))?;
        }
        conn.execute_batch("PRAGMA user_version = 16;")
            .map_err(|e| format!("数据库升级到 v16 失败: {}", e))?;
    }

    let json_exists = Path::new(json_path).exists();
    // ✅ 修复了之前的借用检查器报错，一步到位！
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0)).unwrap_or(0);

    if json_exists && count == 0 {
        println!("🚀 发现旧版 JSON 数据且数据库为空，正在后台静默迁移...");
        let file_content = fs::read_to_string(json_path).unwrap_or_default();
        if let Ok(data) = serde_json::from_str::<Value>(&file_content) {
            let tx = conn.transaction().unwrap();

            if let Some(tags) = data.get("tags").and_then(|t| t.as_array()) {
                let mut active_tags = vec![];
                if let Some(active) = data.get("settings").and_then(|s| s.get("active_tags")).and_then(|a| a.as_array()) {
                    active_tags = active.iter().filter_map(|v| v.as_str()).collect();
                }
                for tag in tags {
                    if let Some(tag_str) = tag.as_str() {
                        let is_active = active_tags.contains(&tag_str) || active_tags.is_empty();
                        let _ = tx.execute("INSERT OR IGNORE INTO tags (name, is_active) VALUES (?1, ?2)", rusqlite::params![tag_str, is_active]);
                    }
                }
            }

            if let Some(sub_tags_obj) = data.get("sub_tags").and_then(|s| s.as_object()) {
                for (main_tag, subs) in sub_tags_obj {
                    if let Some(subs_arr) = subs.as_array() {
                        for sub in subs_arr {
                            if let Some(sub_str) = sub.as_str() {
                                let _ = tx.execute("INSERT INTO sub_tags (main_tag, name) VALUES (?1, ?2)", rusqlite::params![main_tag, sub_str]);
                            }
                        }
                    }
                }
            }

            if let Some(settings_obj) = data.get("settings").and_then(|s| s.as_object()) {
                for (key, val) in settings_obj {
                    if key != "active_tags" { 
                        let val_str = if val.is_string() { val.as_str().unwrap().to_string() } else { val.to_string() };
                        let _ = tx.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)", rusqlite::params![key, val_str]);
                    }
                }
            }

            if let Some(todos) = data.get("todos").and_then(|t| t.as_array()) {
                for t in todos {
                    let _ = tx.execute(
                        "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, completed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        rusqlite::params![t.get("task").and_then(|v| v.as_str()).unwrap_or(""), t.get("done").and_then(|v| v.as_bool()).unwrap_or(false), t.get("tag").and_then(|v| v.as_str()).unwrap_or(""), t.get("sub_tag").and_then(|v| v.as_str()).unwrap_or(""), t.get("detail").and_then(|v| v.as_str()).unwrap_or(""), t.get("remark").and_then(|v| v.as_str()).unwrap_or(""), t.get("deadline").and_then(|v| v.as_str()).unwrap_or(""), t.get("completed_at").and_then(|v| v.as_str()).unwrap_or("")]
                    );
                }
            }

            if let Some(logs_obj) = data.get("logs").and_then(|l| l.as_object()) {
                for (date, day_logs) in logs_obj {
                    if let Some(logs_arr) = day_logs.as_array() {
                        for l in logs_arr {
                            let _ = tx.execute(
                                "INSERT INTO logs (date, time, text, tag, sub_tag, detail, remark, linked_todo, deadline, is_overdue) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                                rusqlite::params![date, l.get("time").and_then(|v| v.as_str()).unwrap_or(""), l.get("text").and_then(|v| v.as_str()).unwrap_or(""), l.get("tag").and_then(|v| v.as_str()).unwrap_or(""), l.get("sub_tag").and_then(|v| v.as_str()).unwrap_or(""), l.get("detail").and_then(|v| v.as_str()).unwrap_or(""), l.get("remark").and_then(|v| v.as_str()).unwrap_or(""), l.get("linked_todo").and_then(|v| v.as_str()).unwrap_or(""), l.get("deadline").and_then(|v| v.as_str()).unwrap_or(""), l.get("is_overdue").and_then(|v| v.as_bool()).unwrap_or(false)]
                            );
                        }
                    }
                }
            }
            tx.commit().map_err(|e| format!("迁移事务提交失败: {}", e))?;
            println!("✅ 数据已完美复制到 SQLite 数据库！");
        }
    }
    Ok(())
}

// 🌟 万能桥梁 1：让前端直接查询数据库，并返回标准的 JSON 数组格式
//
// 用 async fn 而非同步 fn：同步命令默认在 Tauri 主线程执行，
// 前端连续高频调用（例如批量写索引）时会把主线程占满，
// 后续 IPC 响应发不回去，前端 await 永远不 resolve。
#[tauri::command]
async fn db_query(query: String, params: Vec<String>) -> Result<String, String> {
    let conn = Connection::open(get_db_file_path()).map_err(|e| e.to_string())?;
    // 每次调用都是一个独立连接。写库（防抖保存 / 批量粘贴）与读并发时，
    // SQLite 默认 busy_timeout=0 会直接抛 database is locked ——
    // 等 3 秒再放弃，比「偶发写入丢失」划算。
    conn.busy_timeout(std::time::Duration::from_millis(3000))
        .map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
    let column_names: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
    let rusqlite_params = rusqlite::params_from_iter(params.iter());

    // 逐行取列值。任何一列取值失败都退化为 NULL，而不是让整个查询 panic。
    let rows = stmt.query_map(rusqlite_params, |row| {
        let mut map = serde_json::Map::new();
        for i in 0..column_names.len() {
            let json_val = match row.get_ref(i) {
                Ok(ValueRef::Null) | Err(_) => Value::Null,
                Ok(ValueRef::Integer(int_val)) => json!(int_val),
                Ok(ValueRef::Real(float_val)) => json!(float_val),
                Ok(ValueRef::Text(text)) => json!(String::from_utf8_lossy(text).to_string()),
                Ok(ValueRef::Blob(_)) => Value::Null,
            };
            map.insert(column_names[i].clone(), json_val);
        }
        Ok(Value::Object(map))
    }).map_err(|e| e.to_string())?;

    // 单行解析失败时收集错误信息，全部失败才向上报，避免个别坏行让整个视图空白。
    let mut result_vec = Vec::new();
    let mut first_error: Option<String> = None;    for row in rows {
        match row {
            Ok(value) => result_vec.push(value),
            Err(e) => {
                if first_error.is_none() {
                    first_error = Some(e.to_string());
                }
            }
        }
    }

    if result_vec.is_empty() {
        if let Some(err) = first_error {
            return Err(format!("查询结果解析失败: {}", err));
        }
    }

    Ok(json!(result_vec).to_string())
}

// 🌟 万能桥梁 2：让前端直接修改/删除/插入数据
//
// 同样必须是 async：批量写入（笔记索引同步就是典型）会连续调用几十次，
// 同步命令占主线程会让后面的调用排队到看起来像是卡死。
#[tauri::command]
async fn db_execute(query: String, params: Vec<String>) -> Result<usize, String> {
    let conn = Connection::open(get_db_file_path()).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_millis(3000))
        .map_err(|e| e.to_string())?;
    let rusqlite_params = rusqlite::params_from_iter(params.iter());

    // 为什么不用 execute() 的返回值：v10 之后 logs / todos / sheet_row 是视图，
    // 写入由 INSTEAD OF 触发器转译到 record 表。SQLite 的 changes() 明确
    // 「不统计触发器内部的变更」，所以视图 INSERT 会返回 0 ——
    // 而 quickCapture 正是拿这个 0 判断「保存失败」，会把成功写成失败提示。
    //
    // total_changes() 包含触发器内的变更，用前后差值才是真实的写入行数。
    let before = total_changes(&conn);
    conn.execute(&query, rusqlite_params).map_err(|e| e.to_string())?;
    Ok((total_changes(&conn) - before).max(0) as usize)
}

// （保留旧的指令，确保我们重写 JS 前，应用绝不崩溃！）
//
// 这些同样必须是 async：同步命令在主线程执行，前端启动阶段会密集调用
// get_current_path（设置数据路径 provider、迁移笔记、加载笔记列表各一次），
// 一旦主线程排队，后续 IPC 就会卡住不返回。
#[tauri::command] async fn get_current_path() -> String { get_data_file_path() }
#[tauri::command] async fn get_current_db_path() -> String { get_db_file_path() }

#[tauri::command]
async fn open_db_folder() -> Result<String, String> {
    let db_path = PathBuf::from(get_db_file_path());
    let folder = db_path
        .parent()
        .ok_or_else(|| "无法识别数据库所在目录".to_string())?;

    if !folder.exists() {
        return Err(format!("数据库所在目录不存在: {}", folder.to_string_lossy()));
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("explorer");
        cmd.arg(folder);
        cmd
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(folder);
        cmd
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(folder);
        cmd
    };

    command
        .spawn()
        .map_err(|e| format!("打开数据库所在文件夹失败: {}", e))?;

    Ok(folder.to_string_lossy().to_string())
}

#[tauri::command]
async fn backup_database() -> Result<String, String> {
    let db_path = PathBuf::from(get_db_file_path());
    if !db_path.exists() {
        return Err(format!("数据库文件不存在: {}", db_path.to_string_lossy()));
    }
    if !db_path.is_file() {
        return Err(format!("数据库路径不是文件: {}", db_path.to_string_lossy()));
    }

    let db_dir = db_path
        .parent()
        .ok_or_else(|| "无法识别数据库所在目录".to_string())?;
    if !db_dir.exists() {
        return Err(format!("数据库所在目录不存在: {}", db_dir.to_string_lossy()));
    }

    let backup_dir = db_dir.join("backups");
    fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("创建备份目录失败: {}", e))?;

    let file_name = format!("workrecorder_backup_{}.db", Local::now().format("%Y%m%d_%H%M%S"));
    let backup_path = backup_dir.join(file_name);

    fs::copy(&db_path, &backup_path)
        .map_err(|e| format!("备份数据库失败: {}", e))?;

    Ok(backup_path.to_string_lossy().to_string())
}
#[tauri::command] async fn check_path(target: String) -> String { json!({"final_path": target, "exists": false, "is_empty": true}).to_string() }
#[tauri::command] async fn apply_new_path(_new_path: String, _mode: String) -> Result<String, String> { Ok("".to_string()) }

/// 读取随应用一起打包的静态资源（如 themes.json）。
///
/// 不要在前端用 fetch('./xxx.json') 读这些文件：Tauri 2 在自定义协议下
/// 对相对路径的 fetch 行为不可靠，实测会永久挂起且不抛错，
/// 直接把应用初始化卡死。改由后端读取后回传。
#[tauri::command]
async fn read_asset_text(app: tauri::AppHandle, name: String) -> Result<String, String> {
    // 只允许读前端目录下的普通文件名，避免被拿去读任意路径
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("非法的资源名: {}", name));
    }

    let resolver = app.asset_resolver();
    let asset = resolver
        .get(format!("/{}", name))
        .ok_or_else(|| format!("找不到内嵌资源: {}", name))?;

    String::from_utf8(asset.bytes).map_err(|e| format!("资源不是合法 UTF-8: {}", e))
}

/// 把前端日志追加写到数据目录下的 work_recorder_frontend.log。
///
/// GUI 应用没有控制台，出问题时前端错误看不到。
/// 这个命令给前端一个把异常落盘的自证通道，排查线上问题很有用。
#[tauri::command]
async fn log_frontend(level: String, message: String) -> Result<(), String> {
    let mut log_path = PathBuf::from(get_data_file_path());
    log_path.set_file_name("work_recorder_frontend.log");

    let line = format!(
        "[{}] [{}] {}\n",
        Local::now().format("%Y-%m-%d %H:%M:%S"),
        level,
        message.replace('\n', " | ")
    );

    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

// 手写 base64 解码：只服务于「把粘贴的截图落盘」这一件事。
// 为它引入 base64 crate 会让 Cargo 多解析一层依赖，风险大于收益。
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut table = [255u8; 256];
    for (i, ch) in alphabet.iter().enumerate() {
        table[*ch as usize] = i as u8;
    }

    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits: u8 = 0;
    for &byte in input.as_bytes() {
        if byte == b'=' || byte == b'\n' || byte == b'\r' || byte == b' ' {
            continue;
        }
        let value = table[byte as usize];
        if value == 255 {
            return Err(format!("非法的 base64 字符: {}", byte as char));
        }
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Ok(out)
}

/// 图片资源目录：<数据目录>/assets/sheets/YYYYMM
///
/// 三条写图的命令（base64 / 本地文件 / 网络下载）共用这一处，
/// 否则「按月分目录」这条规则迟早有一边改一边忘。
fn sheet_asset_dir() -> Result<PathBuf, String> {
    let db_path = PathBuf::from(get_db_file_path());
    let base_dir = db_path
        .parent()
        .ok_or_else(|| "无法识别数据目录".to_string())?
        .to_path_buf();
    let dir = base_dir
        .join("assets")
        .join("sheets")
        .join(Local::now().format("%Y%m").to_string());
    fs::create_dir_all(&dir).map_err(|e| format!("创建图片目录失败: {}", e))?;
    Ok(dir)
}

/// 把前端粘贴/选择的图片写进数据目录，返回绝对路径。
///
/// 图片不进数据库：单元格只存路径，DB 体积不会随截图膨胀，
/// 备份数据库时也不会把几十 MB 图片塞进 .db 里。
#[tauri::command]
async fn save_sheet_asset(data: String, ext: String) -> Result<String, String> {
    const MAX_BYTES: usize = 12 * 1024 * 1024;

    // 允许直接传 data:image/png;base64,xxxx 形式的整串
    let payload = data.split_once(',').map(|(_, rest)| rest).unwrap_or(data.as_str());
    let bytes = base64_decode(payload)?;
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }
    if bytes.len() > MAX_BYTES {
        return Err(format!("图片过大（{} MB），上限 12 MB", bytes.len() / 1024 / 1024));
    }

    let safe_ext = match ext.to_ascii_lowercase().as_str() {
        "png" => "png",
        "jpg" | "jpeg" => "jpg",
        "webp" => "webp",
        "gif" => "gif",
        _ => "png",
    };

    let dir = sheet_asset_dir()?;

    let file_name = format!(
        "{}-{}.{}",
        Local::now().format("%Y%m%d%H%M%S%3f"),
        std::process::id(),
        safe_ext
    );
    let path = dir.join(file_name);
    fs::write(&path, &bytes).map_err(|e| format!("写入图片失败: {}", e))?;

    Ok(path.to_string_lossy().to_string())
}

/// 用户从系统对话框选了图片：按路径把图片复制进资源目录（用于「自动识别」的图片分支）。
/// 非图片格式一律拒绝——调用方会把它当链接文件处理。
#[tauri::command]
async fn save_sheet_asset_from_path(source: String) -> Result<serde_json::Value, String> {
    const MAX_BYTES: u64 = 12 * 1024 * 1024;
    let src = PathBuf::from(&source);
    if !src.is_file() {
        return Err(format!("文件不存在: {}", source));
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let safe_ext = match ext.as_str() {
        "png" => "png",
        "jpg" | "jpeg" => "jpg",
        "webp" => "webp",
        "gif" => "gif",
        "bmp" => "bmp",
        _ => return Err("不是图片格式".to_string()),
    };
    let meta = fs::metadata(&src).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BYTES {
        return Err(format!("图片过大（{} MB），上限 12 MB", meta.len() / 1024 / 1024));
    }

    let dir = sheet_asset_dir()?;

    let file_name = format!(
        "{}-{}.{}",
        Local::now().format("%Y%m%d%H%M%S%3f"),
        std::process::id(),
        safe_ext
    );
    let dest = dir.join(file_name);
    fs::copy(&src, &dest).map_err(|e| format!("复制图片失败: {}", e))?;

    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("图片")
        .to_string();
    Ok(json!({
        "path": dest.to_string_lossy(),
        "name": name,
        "size": meta.len(),
    }))
}

/// 下载剪贴板里的「云图」，写进资源目录，返回本地绝对路径。
///
/// 为什么要下载而不是直接存链接：WPS 智能表格复制出来的图挂在
/// `http://www.kdocs.cn/api/v3/office/copy/...` 这类**有时效**的地址上，
/// 直接把 URL 写进单元格，过几天就是一片空白 —— 那不叫「完整粘贴」。
///
/// 失败时如实返回错误：前端会丢掉这一张、把失败数统计进导入结果
/// （「N 张图片没能保存」），而不是静默变成空白格 —— 让人以为存上了才最糟。
#[tauri::command]
async fn download_sheet_asset(url: String) -> Result<serde_json::Value, String> {
    use std::sync::OnceLock;
    use std::time::Duration;

    const MAX_BYTES: usize = 12 * 1024 * 1024;
    let link = url.trim().to_string();
    if !(link.starts_with("http://") || link.starts_with("https://")) {
        return Err("不是 http(s) 链接".to_string());
    }

    // 一次导入常有几十张图：连接复用能把 TLS 握手从 58 次降到 1 次。
    // provider 必须在这里装：updater 只在「检查更新」时才装它，
    // 用户直接粘贴时那条路径根本没跑过，https 源会报
    // 「no process-level CryptoProvider available」。
    static CRYPTO: OnceLock<()> = OnceLock::new();
    CRYPTO.get_or_init(|| {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
    });
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(8))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });

    let resp = client
        .get(&link)
        .send()
        .await
        .map_err(|e| format!("下载失败: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("下载失败: HTTP {}", status.as_u16()));
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let ext = if mime.contains("jpeg") || mime.contains("jpg") {
        "jpg"
    } else if mime.contains("webp") {
        "webp"
    } else if mime.contains("gif") {
        "gif"
    } else if mime.contains("bmp") {
        "bmp"
    } else {
        "png"
    };

    let bytes = resp.bytes().await.map_err(|e| format!("读取图片失败: {}", e))?;
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }
    if bytes.len() > MAX_BYTES {
        return Err(format!("图片过大（{} MB），上限 12 MB", bytes.len() / 1024 / 1024));
    }

    let dir = sheet_asset_dir()?;
    let file_name = format!(
        "{}-{}.{}",
        Local::now().format("%Y%m%d%H%M%S%3f"),
        std::process::id(),
        ext
    );
    let path = dir.join(file_name);
    fs::write(&path, &bytes).map_err(|e| format!("写入图片失败: {}", e))?;

    Ok(json!({
        "path": path.to_string_lossy(),
        "size": bytes.len(),
        "mime": mime,
    }))
}

/// 在资源管理器里定位文件（选中该文件，而不是只打开目录）
#[tauri::command]
async fn reveal_path(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| format!("定位文件失败: {}", e))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("定位文件失败: {}", e))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::process::Command;
        let dir = target.parent().map(|p| p.to_path_buf()).unwrap_or(target.clone());
        Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("定位文件失败: {}", e))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("当前系统不支持定位文件".to_string())
}

/// 「打开方式」：弹出 Windows 的程序选择框（本质是 ShellExecute 的 openas）
#[tauri::command]
async fn open_path_with_dialog(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("rundll32")
            .args(["shell32.dll,OpenAs_RunDLL", &path])
            .spawn()
            .map_err(|e| format!("打开方式失败: {}", e))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .args(["-a", "Finder", &path])
            .spawn()
            .map_err(|e| format!("打开方式失败: {}", e))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("当前系统不支持「打开方式」".to_string())
}

#[tauri::command]
async fn load_data() -> String { 
    fs::read_to_string(&get_data_file_path()).unwrap_or_else(|_| json!({ "todos": [], "logs": {}, "tags": [], "settings": {} }).to_string()) 
}
#[tauri::command] async fn save_data(data: String) -> Result<(), String> { 
    fs::write(&get_data_file_path(), &data).map_err(|e| e.to_string()) 
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        // 👇 核心修复 6：拦截双开，自动把已打开的窗口弹到最前面
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|_app| {
            if let Err(e) = init_and_migrate_db() {
                eprintln!("⚠️ 数据库初始化出错: {}", e);
            }
            Ok(())
        })        .invoke_handler(tauri::generate_handler![
            load_data, save_data, get_current_path, get_current_db_path, open_db_folder, backup_database, check_path, apply_new_path, db_query, db_execute,
            read_asset_text,
            save_sheet_asset,
            save_sheet_asset_from_path,
            download_sheet_asset,
            reveal_path,
            open_path_with_dialog,
            notes_fs::notes_ensure_root,
            notes_fs::notes_root_path,
            notes_fs::notes_list,
            notes_fs::notes_read,
            notes_fs::notes_write,
            notes_fs::notes_update_meta,
            notes_fs::notes_set_record,
            notes_fs::notes_add_record,
            notes_fs::notes_remove_record,
            notes_fs::notes_set_records,
            notes_fs::notes_delete,
            notes_fs::notes_ensure_tag_dir,
            notes_fs::notes_open_root,
            notes_fs::notes_migrate_legacy,
            notes_fs::paths_exist,
            notes_fs::open_path_with_app,
            log_frontend
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    // v13 起「删除」不再是 DELETE，而是给 kind 打 '#deleted' 后缀 + 写 deleted_at。
    // 三个 delete 触发器因此必然与 v10 的定义不同 —— 冻结校验只锁
    // 「视图 + insert/update 触发器」：这三类一旦被改，就会有列被静默抹空。
    fn frozen_snapshot(c: &Connection) -> Vec<(String, String)> {
        let mut stmt = c
            .prepare(
                "SELECT name, sql FROM sqlite_master \
                 WHERE type IN ('view','trigger') AND sql IS NOT NULL \
                   AND name NOT IN ('logs_delete','todos_delete','sheet_row_delete') \
                 ORDER BY name",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .filter_map(|x| x.ok())
            .collect();
        rows
    }

    // 三个 delete 触发器必须真的改成软删除，否则「删了就没了」，Ctrl+Z 无从恢复。
    fn assert_soft_delete_triggers(c: &Connection) {
        for name in ["logs_delete", "todos_delete", "sheet_row_delete"] {
            let sql: String = c
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1",
                    [name],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| panic!("缺少触发器 {}", name));
            assert!(
                sql.contains("deleted_at"),
                "{} 不是软删除（缺 deleted_at）：{}",
                name,
                sql
            );
            assert!(
                !sql.contains("DELETE FROM record"),
                "{} 仍在真删：{}",
                name,
                sql
            );
        }
    }

    // v10 迁移必须在副本上验证：它会改表名、建视图、建触发器，任何一步出错
    // 都是用户数据层面的灾难。断言五件事：
    // ①行数守恒 ②视图列名与旧表逐一对应 ③视图可写 ④二次迁移幂等 ⑤引用无悬空。
    #[test]
    fn v10_migration_is_lossless_and_views_are_writable() {
        let src = Path::new("D:/MyDesktopApp/work_data/my_data.db");
        if !src.exists() {
            eprintln!("跳过：真实数据库不存在，无法验证迁移");
            return;
        }

        let tmp = std::env::temp_dir().join("wr-v10-migration-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("创建临时目录失败");
        let db = tmp.join("t.db");
        fs::copy(src, &db).expect("复制数据库失败（应用是否正在运行并占用？）");
        let json = tmp.join("t.json");

        let before = {
            let conn = Connection::open(&db).unwrap();
            let logs: i64 = conn.query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0)).unwrap();
            let todos: i64 = conn.query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0)).unwrap();
            let rows: i64 = conn.query_row("SELECT COUNT(*) FROM sheet_row", [], |r| r.get(0)).unwrap();
            (logs, todos, rows)
        };

        let db_str = db.to_string_lossy().to_string();
        let json_str = json.to_string_lossy().to_string();
        init_and_migrate_db_at(&db_str, &json_str).expect("迁移失败");

        let conn = Connection::open(&db).unwrap();

        // ① 行数守恒
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM record", [], |r| r.get(0)).unwrap();
        assert_eq!(n, before.0 + before.1 + before.2, "record 行数应等于三表之和");

        // ② 视图列名必须与旧表完全一致：前端 90 余处 SQL 全靠列名取值
        let expect_logs = vec![
            "id", "date", "time", "text", "tag", "sub_tag", "detail", "remark",
            "linked_todo", "deadline", "is_overdue", "status", "record_type", "custom",
        ];
        let stmt = conn.prepare("SELECT * FROM logs LIMIT 1").unwrap();
        let cols: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
        drop(stmt);
        assert_eq!(cols, expect_logs, "logs 视图列名与旧表不一致");

        let expect_todos = vec![
            "id", "task", "done", "tag", "sub_tag", "detail", "remark", "deadline",
            "completed_at", "parent_id", "start_at", "end_at", "sort_order", "custom",
        ];
        let stmt = conn.prepare("SELECT * FROM todos LIMIT 1").unwrap();
        let cols: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
        drop(stmt);
        assert_eq!(cols, expect_todos, "todos 视图列名与旧表不一致");

        let expect_rows = vec!["id", "sheet_id", "data", "sort", "created_at", "updated_at", "height"];
        let stmt = conn.prepare("SELECT * FROM sheet_row LIMIT 1").unwrap();
        let cols: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
        drop(stmt);
        assert_eq!(cols, expect_rows, "sheet_row 视图列名与旧表不一致");

        let logs_n: i64 = conn.query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0)).unwrap();
        assert_eq!(logs_n, before.0);
        let todos_n: i64 = conn.query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0)).unwrap();
        assert_eq!(todos_n, before.1);

        // ③ 视图可写：INSERT / 单列 UPDATE / DELETE 都经触发器落到 record
        conn.execute(
            "INSERT INTO logs (date, time, text, tag, sub_tag, detail, remark, linked_todo, deadline, is_overdue, status, record_type) \
             VALUES ('2026-01-01', '10:00', '迁移写入测试', '测试', '', '', '', '', '', 'false', 'unprocessed', 'log')",
            [],
        ).expect("视图 INSERT 失败");

        let new_id: i64 = conn
            .query_row("SELECT id FROM record WHERE title = '迁移写入测试'", [], |r| r.get(0))
            .expect("INSERT 未落到 record");

        let status: String = conn
            .query_row("SELECT status FROM record WHERE id = ?1", [new_id], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "inbox", "unprocessed 应映射为 inbox");

        conn.execute("UPDATE logs SET remark = '追加' WHERE id = ?1", [new_id])
            .expect("视图 UPDATE 失败");
        let title: String = conn
            .query_row("SELECT title FROM record WHERE id = ?1", [new_id], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "迁移写入测试", "单列 UPDATE 不应抹掉其他列");

        // v13 起视图 DELETE = 软删除：行还留在 record 里（Ctrl+Z 要能恢复），视图查不到。
        conn.execute("DELETE FROM logs WHERE id = ?1", [new_id])
            .expect("视图 DELETE 失败");
        let (kept_kind, kept_at): (String, String) = conn
            .query_row(
                "SELECT kind, COALESCE(deleted_at, '') FROM record WHERE id = ?1",
                [new_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(kept_kind, "log#deleted", "视图 DELETE 没有走软删除");
        assert!(!kept_at.is_empty(), "软删除没写 deleted_at");
        let hidden: i64 = conn
            .query_row("SELECT COUNT(*) FROM logs WHERE id = ?1", [new_id], |r| r.get(0))
            .unwrap();
        assert_eq!(hidden, 0, "软删除的记录仍出现在 logs 视图里");

        // ④ 二次迁移幂等：版本号已到 11，不应重复插入。
        // 基准必须现取：v13 起视图 DELETE 是软删除，行数不随删除减少，
        // 拿上面那个 n（视图 INSERT 之前的快照）会比出「多 1 行」的假失败。
        let n_now: i64 = conn
            .query_row("SELECT COUNT(*) FROM record", [], |r| r.get(0))
            .unwrap();
        drop(conn);
        init_and_migrate_db_at(&db_str, &json_str).expect("二次迁移失败");
        let conn = Connection::open(&db).unwrap();
        let n2: i64 = conn.query_row("SELECT COUNT(*) FROM record", [], |r| r.get(0)).unwrap();
        assert_eq!(n2, n_now, "二次迁移不应改变行数");

        // ⑤ 引用重映射：linked_todo 必须指向真实存在的 todo
        let dangling: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM record r WHERE r.kind = 'log' \
                 AND r.linked_todo != '' AND r.linked_todo IS NOT NULL \
                 AND NOT EXISTS (SELECT 1 FROM record t WHERE t.kind = 'todo' AND CAST(t.id AS TEXT) = r.linked_todo)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dangling, 0, "linked_todo 存在悬空引用");

        drop(conn);
        let _ = fs::remove_dir_all(&tmp);
    }

    // 迁移只保证「数据搬过去了」。前端是通过视图读写的，所以这里把
    // data.js / quickCapture.js / todo.js / sheetStore.js 里真实用到的 SQL 形态
    // 逐条跑一遍。抓的是三类不会报错、只会静默少数据的失败：
    //   ①视图列名与旧表对不上  ②参数个数不对  ③类型变了导致 WHERE 匹配不上
    // 第 ③ 类最隐蔽 —— done 从字符串 'true' 变成整数 1 时，
    // 「清理已完成待办」会一条都删不掉，而且界面毫无提示。
    #[test]
    fn frontend_sql_surface_still_works() {
        let src = Path::new("D:/MyDesktopApp/work_data/my_data.db");
        if !src.exists() {
            eprintln!("跳过：真实数据库不存在，无法验证");
            return;
        }

        let tmp = std::env::temp_dir().join("wr-v10-sql-surface");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("创建临时目录失败");
        let db = tmp.join("t.db");
        fs::copy(src, &db).expect("复制数据库失败");
        let json = tmp.join("t.json");
        init_and_migrate_db_at(&db.to_string_lossy(), &json.to_string_lossy()).expect("迁移失败");

        let conn = Connection::open(&db).unwrap();

        // ---- 读取：data.js loadData ----
        for sql in [
            "SELECT * FROM todos",
            "SELECT * FROM logs ORDER BY date DESC, time DESC",
            "SELECT name FROM tags",
            "SELECT main_tag, name FROM sub_tags",
            "SELECT key, value FROM settings",
        ] {
            conn.prepare(sql).unwrap_or_else(|e| panic!("读取失败 [{}]: {}", sql, e));
        }

        // ---- 流水：quickCapture 写入 + 编辑 ----
        // 这里复刻 db_execute 的计数方式（total_changes 差值），
        // 因为 quickCapture.js 用它的返回值判断「是否保存成功」。
        // 如果视图写入让这个数变成 0，那条路径会误报「保存失败」——
        // 用户以为没存上，其实已经落库。
        let before = total_changes(&conn);
        conn.execute(
            "INSERT INTO logs (date, time, text, tag, sub_tag, detail, remark, linked_todo, deadline, is_overdue, status, record_type) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                "2026-11-12", "21:00", "前端写入验证", "测试", "", "", "", "", "",
                "false", "unprocessed", "quick"
            ],
        ).expect("流水写入失败");
        let inserted = total_changes(&conn) - before;
        assert!(inserted >= 1, "写入计数为 {}，前端会误判为保存失败", inserted);

        let log_id: i64 = conn
            .query_row("SELECT id FROM record WHERE title = '前端写入验证'", [], |r| r.get(0))
            .expect("流水未落到 record");
        let status: String = conn
            .query_row("SELECT status FROM record WHERE id = ?1", [log_id], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "inbox", "quick 记录应进入待整理");

        conn.execute("UPDATE logs SET tag=?, sub_tag=? WHERE id=?",
            rusqlite::params!["测试2", "", log_id]).unwrap();
        conn.execute(
            "UPDATE logs SET date=?, time=?, text=?, detail=?, deadline=?, tag=?, sub_tag=? WHERE id=?",
            rusqlite::params!["2026-11-12", "21:01", "前端写入验证2", "", "", "测试2", "", log_id],
        ).unwrap();

        // ---- 待办：todo.js 写入 / 勾选 / 取消 / 级联 ----
        conn.execute(
            "INSERT INTO todos (task, done, tag, sub_tag, detail, remark, deadline, start_at, end_at, parent_id, completed_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params!["前端待办验证", "false", "测试", "", "", "", "", "", "", "", ""],
        ).expect("待办写入失败");

        let todo_id: i64 = conn
            .query_row("SELECT id FROM record WHERE title = '前端待办验证'", [], |r| r.get(0))
            .expect("待办未落到 record");

        conn.execute("UPDATE todos SET done = ?, completed_at = ? WHERE id = ?",
            rusqlite::params!["true", "2026-11-12 21:02:00", todo_id]).unwrap();
        let status: String = conn
            .query_row("SELECT status FROM record WHERE id = ?1", [todo_id], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "done", "勾选后应为 done");

        conn.execute("UPDATE todos SET done = ?, completed_at = ? WHERE id = ?",
            rusqlite::params!["false", "", todo_id]).unwrap();
        let status: String = conn
            .query_row("SELECT status FROM record WHERE id = ?1", [todo_id], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "pending", "取消勾选后应为 pending");

        conn.execute("UPDATE todos SET parent_id=? WHERE parent_id=?",
            rusqlite::params!["", todo_id]).unwrap();

        let pending: i64 = conn
            .query_row("SELECT COUNT(*) FROM todos WHERE done = 'false'", [], |r| r.get(0))
            .unwrap();
        assert!(pending >= 1, "WHERE done = 'false' 未匹配到未完成待办");

        // 第 ③ 类失败就在这里暴露：视图 done 必须是字符串 'true'，
        // 否则下面这句会删掉 0 行 —— 而且不报错，界面照常显示「已清理」。
        //
        // 注意不能用 conn.execute 的返回值断言：DELETE 打在视图上时，
        // SQLite 的 changes() 不统计 INSTEAD OF 触发器内部的删除，恒为 0。
        // 必须回查 record 才能确认数据是否真的没了。
        conn.execute("UPDATE todos SET done = ? WHERE id = ?",
            rusqlite::params!["true", todo_id]).unwrap();
        conn.execute("DELETE FROM todos WHERE done = ?", rusqlite::params!["true"])
            .expect("按 done 删除失败");
        let gone: i64 = conn
            .query_row("SELECT COUNT(*) FROM todos WHERE id = ?1", [todo_id], |r| r.get(0))
            .unwrap();
        assert_eq!(gone, 0, "WHERE done = 'true' 未删除到已完成待办（视图 done 类型变了）");

        // ---- 表格行：sheetStore 增改删 ----
        let sheet_id: i64 = conn
            .query_row("SELECT id FROM sheet LIMIT 1", [], |r| r.get(0))
            .unwrap_or(1);

        conn.execute(
            "INSERT INTO sheet_row (sheet_id, data, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            rusqlite::params![sheet_id, "{\"f_demo\":\"表格写入验证\"}", 999,
                             "2026-11-12 21:00:00", "2026-11-12 21:00:00"],
        ).expect("表格行写入失败");

        let row_id: i64 = conn
            .query_row("SELECT id FROM record WHERE custom LIKE '%表格写入验证%'", [], |r| r.get(0))
            .expect("表格行未落到 record");

        conn.execute("UPDATE sheet_row SET data = ?, updated_at = ? WHERE id = ?",
            rusqlite::params!["{\"f_demo\":\"已改\"}", "2026-11-12 21:05:00", row_id]).unwrap();
        conn.execute("UPDATE sheet_row SET height = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![72, "2026-11-12 21:06:00", row_id]).unwrap();

        let data: String = conn
            .query_row("SELECT data FROM sheet_row WHERE id = ?1", [row_id], |r| r.get(0))
            .unwrap();
        assert!(data.contains("已改"), "表格行内容未更新：{}", data);

        conn.execute("DELETE FROM sheet_row WHERE sheet_id = ?", [sheet_id]).unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM record WHERE kind = 'sheet_row' AND sheet_id = ?1",
                       [sheet_id], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "按表删除行未生效");

        drop(conn);
        let _ = fs::remove_dir_all(&tmp);
    }

    // v11 只加索引与 note_index.record_id。它最大的风险不是「加不上」，而是
    // 「有人顺手给视图补了一列」—— 补列要重建视图与触发器，而三个触发器都是
    // 全列 NEW.* 覆写，漏写一列，那列就被 COALESCE(NEW.x, '') 静默抹成空，不报错。
    // 所以这里不测「加成功了」，测「没碰不该碰的东西」：
    //   ①版本号 11、四个索引/列都在
    //   ②重跑一次迁移，视图与触发器的 SQL 与上一次逐字一致
    //   ③走视图写一次，视图里没有的列（body / parent_id）必须原样存活
    #[test]
    fn v11_adds_indexes_without_touching_views() {
        let tmp = std::env::temp_dir().join("wr-v11-index-only");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("创建临时目录失败");
        let db = tmp.join("t.db");
        let json = tmp.join("t.json");
        let db_str = db.to_string_lossy().to_string();
        let json_str = json.to_string_lossy().to_string();

        // 全新库跑一遍：验证 0 → 11 这条路径（老库走的是 v11 单独一段）
        init_and_migrate_db_at(&db_str, &json_str).expect("全新库迁移失败");

        let conn = Connection::open(&db).unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        // 这里只断言「至少到 11」：v12 及以后会在全新库上继续往上推版本号，
        // 写死 11 会让每加一次迁移就要来改这条 v11 的用例。
        assert!(version >= 11, "全新库版本号应为 11 及以上，实际 {}", version);

        // ① 索引与列
        for idx in [
            "idx_record_parent",
            "idx_record_sheet_only",
            "idx_sheet_task_id",
            "idx_note_index_record",
        ] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    [idx],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "缺少索引 {}（v11 未生效）", idx);
        }

        let has_record_id = {
            let mut stmt = conn.prepare("PRAGMA table_info(note_index)").unwrap();
            let names: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .filter_map(|x| x.ok())
                .collect();
            names.iter().any(|n| n == "record_id")
        };
        assert!(has_record_id, "note_index 缺少 record_id 列");

        // ② 冻结校验：把版本号退回 10 再跑一次，视图与 insert/update 触发器必须逐字不变。
        //    delete 触发器由 v13 合法改写成软删除，单独由 assert_soft_delete_triggers 守。
        let before_sql = frozen_snapshot(&conn);
        assert!(!before_sql.is_empty(), "没有视图/触发器，说明 v10 没跑");

        conn.execute_batch("PRAGMA user_version = 10;").unwrap();
        drop(conn);
        init_and_migrate_db_at(&db_str, &json_str).expect("v11 重跑失败");
        let conn = Connection::open(&db).unwrap();
        assert_eq!(
            frozen_snapshot(&conn),
            before_sql,
            "v11 之后的迁移改动了视图或 insert/update 触发器定义"
        );
        assert_soft_delete_triggers(&conn);

        // ③ 行为校验：视图里没有 body / parent_id，经视图 UPDATE 后必须还在
        conn.execute(
            "INSERT INTO record (kind, sheet_id, custom, sort, title, body, parent_id, created_at, updated_at) \
             VALUES ('sheet_row', 999, '{\"a\":1}', 0, 'v11 探针', '正文必须存活', 4242, '', '')",
            [],
        )
        .unwrap();
        let probe: i64 = conn
            .query_row("SELECT id FROM record WHERE title = 'v11 探针'", [], |r| r.get(0))
            .unwrap();

        conn.execute(
            "UPDATE sheet_row SET data = ?, updated_at = ? WHERE id = ?",
            rusqlite::params!["{\"a\":2}", "2026-11-13 10:00:00", probe],
        )
        .expect("视图 UPDATE 失败");

        let (body, parent, custom): (String, Option<i64>, String) = conn
            .query_row(
                "SELECT body, parent_id, custom FROM record WHERE id = ?1",
                [probe],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(body, "正文必须存活", "视图 UPDATE 把 body 抹掉了（触发器漏列）");
        assert_eq!(parent, Some(4242), "视图 UPDATE 把 parent_id 抹掉了（触发器漏列）");
        assert!(custom.contains("\"a\":2"), "视图 UPDATE 没写进 custom：{}", custom);

        drop(conn);
        let _ = fs::remove_dir_all(&tmp);
    }

    // v12 只加一张派生表 note_record。它最大的风险同样不是「加不上」，而是
    // 有人顺手在 v12 段里给视图补一列 / 重建触发器（理由见上面 v11 用例的注释）。
    // 这里断言四件事：
    //   ①版本号 12、note_record 表与反向索引都在
    //   ②搬迁只搬 typeof(record_id)='integer' 且 >0 的行（'null' 幽灵值不许进）
    //   ③把版本退回 11 重跑一次，视图与触发器的 SQL 与上一次逐字一致
    //   ④note_record 里没有 <=0 的 id、没有文本型 id
    #[test]
    fn v12_adds_note_record_without_touching_views() {
        let tmp = std::env::temp_dir().join("wr-v12-note-record");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("创建临时目录失败");
        let db = tmp.join("t.db");
        let json = tmp.join("t.json");
        let db_str = db.to_string_lossy().to_string();
        let json_str = json.to_string_lossy().to_string();

        // 全新库跑一遍：验证 0 → 12 这条路径
        init_and_migrate_db_at(&db_str, &json_str).expect("全新库迁移失败");

        let conn = Connection::open(&db).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert!(version >= 12, "全新库版本号应至少为 12，实际 {}", version);

        // ① 表与索引
        for name in ["note_record", "idx_note_record_record"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                    [name],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "缺少 {}（v12 未生效）", name);
        }

        // 造 v11 遗留数据：一条正常的整数关联 + 一条 params.map(String) 留下的 'null' 幽灵值
        conn.execute(
            "INSERT INTO note_index (rel_path, title, note_type, status, tag, sub_tag, record_id, created_at, updated_at) \
             VALUES ('工作/2026-09-20-甲.md', '甲', 'idea', 'usable', '工作', '', 12, '', '')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO note_index (rel_path, title, note_type, status, tag, sub_tag, record_id, created_at, updated_at) \
             VALUES ('工作/2026-09-20-乙.md', '乙', 'idea', 'usable', '工作', '', 'null', '', '')",
            [],
        )
        .unwrap();
        let ghost_type: String = conn
            .query_row(
                "SELECT typeof(record_id) FROM note_index WHERE rel_path = '工作/2026-09-20-乙.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ghost_type, "text", "探针没复现出 'null' 幽灵值，用例失真");

        // ③ 冻结快照：视图与 insert/update 触发器逐字不变（delete 触发器由 v13 合法改写）
        let before_sql = frozen_snapshot(&conn);
        assert!(!before_sql.is_empty(), "没有视图/触发器，说明 v10 没跑");

        conn.execute_batch("PRAGMA user_version = 11;").unwrap();
        drop(conn);
        init_and_migrate_db_at(&db_str, &json_str).expect("v12 重跑失败");
        let conn = Connection::open(&db).unwrap();
        assert_eq!(
            frozen_snapshot(&conn),
            before_sql,
            "v12 之后的迁移改动了视图或 insert/update 触发器定义"
        );
        assert_soft_delete_triggers(&conn);

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert!(version >= 12, "v12 重跑后版本号应至少为 12，实际 {}", version);

        // ② + ④ 搬迁范围：只有整数那一行进来
        let rows: Vec<(String, i64)> = {
            let mut stmt = conn
                .prepare("SELECT rel_path, record_id FROM note_record ORDER BY rel_path")
                .unwrap();
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .unwrap()
                .filter_map(|x| x.ok())
                .collect();
            rows
        };
        assert_eq!(rows.len(), 1, "只该搬进 1 行整数关联，实际 {:?}", rows);
        assert_eq!(rows[0].0, "工作/2026-09-20-甲.md", "搬错了 rel_path");
        assert_eq!(rows[0].1, 12, "搬错了 record_id");
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM note_record WHERE typeof(record_id) != 'integer' OR record_id <= 0",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap(),
            0,
            "note_record 里混进了非整数或非正数 id"
        );

        drop(conn);
        let _ = fs::remove_dir_all(&tmp);
    }

    // v13 = 软删除：DELETE 不再销毁数据，只给 kind 打 '#deleted' 后缀。
    // 守四件事：
    //   ① 三个 delete 触发器真的改成软删除（真删了 Ctrl+Z 无从恢复）
    //   ② 打标记后视图立刻查不到 → 前端 90 余处 SQL 一行都不用改
    //   ③ 摘标记后原样回来，且重复删除不会把后缀叠成 '#deleted#deleted'
    //   ④ 三个视图（logs / todos / sheet_row）规则一致
    #[test]
    fn v13_soft_delete_hides_from_views_and_can_be_restored() {
        let tmp = std::env::temp_dir().join("wr-v13-soft-delete");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("创建临时目录失败");
        let db = tmp.join("t.db");
        let json = tmp.join("t.json");
        init_and_migrate_db_at(&db.to_string_lossy(), &json.to_string_lossy())
            .expect("全新库迁移失败");

        let conn = Connection::open(&db).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert!(version >= 13, "全新库版本号应至少为 13，实际 {}", version);

        // ① 列与触发器
        assert!(
            table_has_column(&conn, "record", "deleted_at").unwrap(),
            "record 缺 deleted_at 列"
        );
        assert_soft_delete_triggers(&conn);

        // ② 走视图写一条，再从视图删掉
        conn.execute(
            "INSERT INTO logs (date, time, text, tag, sub_tag) \
             VALUES ('2026-11-17', '10:00', '软删除探针', '工作', '')",
            [],
        )
        .unwrap();
        let id: i64 = conn
            .query_row("SELECT id FROM logs WHERE text = '软删除探针'", [], |r| {
                r.get(0)
            })
            .unwrap();

        conn.execute("DELETE FROM logs WHERE id = ?1", [id]).unwrap();

        let visible: i64 = conn
            .query_row("SELECT COUNT(*) FROM logs WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(visible, 0, "软删除后 logs 视图仍在返回该行（kind 后缀没生效）");

        let (kind, deleted_at): (String, String) = conn
            .query_row(
                "SELECT kind, COALESCE(deleted_at, '') FROM record WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(kind, "log#deleted", "kind 没打上删除后缀");
        assert!(!deleted_at.is_empty(), "deleted_at 没写时间");

        // ③ 恢复：摘后缀 + 清时间，视图重新可见
        conn.execute(
            "UPDATE record SET deleted_at = '', kind = REPLACE(kind, '#deleted', '') WHERE id = ?1",
            [id],
        )
        .unwrap();
        let back: i64 = conn
            .query_row("SELECT COUNT(*) FROM logs WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(back, 1, "恢复后 logs 视图仍看不到该行");

        // 连删两次：第二次不能再叠一层 '#deleted'
        conn.execute("DELETE FROM logs WHERE id = ?1", [id]).unwrap();
        let twice: String = conn
            .query_row("SELECT kind FROM record WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(twice, "log#deleted", "重复删除把后缀叠成了 {}", twice);

        // ④ todos 同一套规则
        conn.execute("INSERT INTO todos (task, done) VALUES ('软删除待办', 'false')", [])
            .unwrap();
        let todo_id: i64 = conn
            .query_row("SELECT id FROM todos WHERE task = '软删除待办'", [], |r| {
                r.get(0)
            })
            .unwrap();
        conn.execute("DELETE FROM todos WHERE id = ?1", [todo_id]).unwrap();
        let todo_visible: i64 = conn
            .query_row("SELECT COUNT(*) FROM todos WHERE id = ?1", [todo_id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(todo_visible, 0, "todos 视图没过滤软删除");

        drop(conn);
        let _ = fs::remove_dir_all(&tmp);
    }

    // v14 = 基础表列宽初值。守三件事：
    //   ① 全新库的内置字段宽度不再统一 160（否则一开表所有列等宽，比例全丢）
    //   ② 用户已调过的宽度不被迁移覆盖（只动「还停在 160」的行）
    //   ③ 迁移可重跑：跑第二遍不该把宽度改回种子值
    #[test]
    fn v14_seeds_base_table_column_widths() {
        let tmp = std::env::temp_dir().join("wr-v14-col-widths");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("创建临时目录失败");
        let db = tmp.join("t.db");
        let json = tmp.join("t.json");
        init_and_migrate_db_at(&db.to_string_lossy(), &json.to_string_lossy())
            .expect("全新库迁移失败");

        let conn = Connection::open(&db).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert!(version >= 14, "全新库版本号应至少为 14，实际 {}", version);

        let width_of = |key: &str| -> i64 {
            conn.query_row(
                "SELECT width FROM field_def WHERE entity = 'log' AND key = ?1",
                [key],
                |r| r.get(0),
            )
            .unwrap()
        };

        // ① 不再是等宽 160，且与前端 DEFAULT_WIDTHS 一致
        assert_eq!(width_of("text"), 280, "内容列宽度未初始化");
        assert_eq!(width_of("date"), 128, "时间列宽度未初始化");
        assert_eq!(width_of("attachments"), 96, "附件列宽度未初始化");

        // ② 模拟用户把内容列拖到 400，再跑一遍迁移，不该被改回 280
        conn.execute(
            "UPDATE field_def SET width = 400 WHERE entity = 'log' AND key = 'text'",
            [],
        )
        .unwrap();
        drop(conn);
        init_and_migrate_db_at(&db.to_string_lossy(), &json.to_string_lossy())
            .expect("二次迁移失败");

        let conn = Connection::open(&db).unwrap();
        let kept: i64 = conn
            .query_row(
                "SELECT width FROM field_def WHERE entity = 'log' AND key = 'text'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, 400, "二次迁移覆盖了用户调过的列宽");

        drop(conn);
        let _ = fs::remove_dir_all(&tmp);
    }

    // v15 = 表 / 视图分层的地基。守四件事：
    //   ① 预置表恰好一张（kind='preset'），它是「基础表」的新身份
    //   ② 每张表都有一个默认「表格」视图，历史表由迁移补齐
    //   ③ settings.default_table_id 指向预置表，供删表时兜底
    //   ④ 迁移可重跑：不会多出第二张预置表、也不会重复补视图
    #[test]
    fn v15_seeds_preset_table_and_default_views() {
        let tmp = std::env::temp_dir().join("wr-v15-table-views");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("创建临时目录失败");
        let db = tmp.join("t.db");
        let json = tmp.join("t.json");
        init_and_migrate_db_at(&db.to_string_lossy(), &json.to_string_lossy())
            .expect("全新库迁移失败");

        let conn = Connection::open(&db).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert!(version >= 15, "全新库版本号应至少为 15，实际 {}", version);

        // ① 预置表恰好一张
        let presets: i64 = conn
            .query_row("SELECT COUNT(*) FROM sheet WHERE kind = 'preset'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(presets, 1, "预置表应恰好一张，实际 {}", presets);

        // ② 没有「裸表」——每张表都挂了默认视图，且预置表的是表格形态
        let missing: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sheet s \
                 WHERE NOT EXISTS (SELECT 1 FROM view_def v WHERE v.table_id = s.id)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(missing, 0, "有 {} 张表没有默认视图", missing);

        let form: String = conn
            .query_row(
                "SELECT v.form FROM view_def v JOIN sheet s ON s.id = v.table_id \
                 WHERE s.kind = 'preset' LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(form, "table", "预置表的默认视图不是表格形态");

        // ③ 全局捕获落点指向预置表
        let preset_id: i64 = conn
            .query_row("SELECT id FROM sheet WHERE kind = 'preset' LIMIT 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        let default_id: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'default_table_id'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            default_id,
            preset_id.to_string(),
            "default_table_id 没指向预置表"
        );

        let views_before: i64 = conn
            .query_row("SELECT COUNT(*) FROM view_def", [], |r| r.get(0))
            .unwrap();

        // ④ 幂等：重跑不新增预置表、不重复补视图
        drop(conn);
        init_and_migrate_db_at(&db.to_string_lossy(), &json.to_string_lossy())
            .expect("二次迁移失败");
        let conn = Connection::open(&db).unwrap();
        let presets_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM sheet WHERE kind = 'preset'", [], |r| {
                r.get(0)
            })
            .unwrap();
        let views_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM view_def", [], |r| r.get(0))
            .unwrap();
        assert_eq!(presets_after, 1, "二次迁移多建了预置表");
        assert_eq!(views_after, views_before, "二次迁移重复补了视图");

        drop(conn);
        let _ = fs::remove_dir_all(&tmp);
    }

    // v16：「内容」列默认开启自动换行（行为本体在前端：is-wrap → 截断行数）。
    //   ① 全新库：field_def(log/text).options 里带 wrap = true
    //   ② 幂等：重跑不报错、值不变
    //   ③ 边界：用户显式关掉（wrap:false）后，v16 再跑一遍不能把它翻回来
    #[test]
    fn v16_wraps_preset_content_field() {
        let tmp = std::env::temp_dir().join("wr-v16-wrap");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("创建临时目录失败");
        let db = tmp.join("t.db");
        let json = tmp.join("t.json");
        init_and_migrate_db_at(&db.to_string_lossy(), &json.to_string_lossy())
            .expect("全新库迁移失败");

        // 只读「内容」列的 options，别的列一概不关心
        fn content_options(conn: &Connection) -> Value {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT options FROM field_def WHERE entity = 'log' AND key = 'text'",
                    [],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap_or(None);
            raw.as_deref()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .unwrap_or(Value::Null)
        }

        let conn = Connection::open(&db).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert!(version >= 16, "全新库版本号应至少为 16，实际 {}", version);

        // ① 默认开
        let options = content_options(&conn);
        assert_eq!(
            options.get("wrap"),
            Some(&Value::Bool(true)),
            "「内容」列没有默认开启换行：{}",
            options
        );

        // ② 幂等
        drop(conn);
        init_and_migrate_db_at(&db.to_string_lossy(), &json.to_string_lossy())
            .expect("二次迁移失败");
        let conn = Connection::open(&db).unwrap();
        assert_eq!(
            content_options(&conn).get("wrap"),
            Some(&Value::Bool(true)),
            "二次迁移把默认值改掉了"
        );

        // ③ 用户显式关掉后，重放 v16 不能覆盖
        conn.execute(
            "UPDATE field_def SET options = '{\"wrap\":false}' WHERE entity = 'log' AND key = 'text'",
            [],
        )
        .unwrap();
        conn.execute_batch("PRAGMA user_version = 15;").unwrap();
        drop(conn);
        init_and_migrate_db_at(&db.to_string_lossy(), &json.to_string_lossy())
            .expect("重放 v16 失败");
        let conn = Connection::open(&db).unwrap();
        assert_eq!(
            content_options(&conn).get("wrap"),
            Some(&Value::Bool(false)),
            "v16 覆盖了用户显式关掉的换行设置"
        );

        drop(conn);
        let _ = fs::remove_dir_all(&tmp);
    }

    // T01 的核心行为：一条随手记被「移入」表格后，必须能从表格里查到。
    // 改造前 loadRows 走 sheet_row 视图（WHERE kind = 'sheet_row'），查不到它 ——
    // 这就是「表格里看不见、记录页看得见、又删不掉」的根源。
    // 这里逐条复刻 sheetStore.js 改后的 SQL，抓四件事：
    //   ①直读 record 且 custom AS data 别名可用  ②CAST(sort AS INTEGER)
    //   ③移入的行（kind 仍是 log）能被查到      ④删表两段式不留孤儿、NULL 不是字符串
    #[test]
    fn sheet_store_direct_read_handles_moved_in_records() {
        let tmp = std::env::temp_dir().join("wr-t01-direct-read");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("创建临时目录失败");
        let db = tmp.join("t.db");
        let json = tmp.join("t.json");
        init_and_migrate_db_at(&db.to_string_lossy(), &json.to_string_lossy()).expect("迁移失败");

        let conn = Connection::open(&db).unwrap();
        conn.execute(
            "INSERT INTO sheet (name, created_at, updated_at, sort) VALUES ('设备台账', '', '', 0)",
            [],
        )
        .unwrap();
        let sheet_id: i64 = conn
            .query_row("SELECT id FROM sheet WHERE name = '设备台账'", [], |r| r.get(0))
            .unwrap();

        // 一条在「记录」页出生的随手记
        conn.execute(
            "INSERT INTO logs (date, time, text, tag, sub_tag, detail, remark, linked_todo, deadline, is_overdue, status, record_type) \
             VALUES ('2026-11-13', '09:00', '前置泵温差偏大', '设备', '', '', '', '', '', 'false', 'unprocessed', 'log')",
            [],
        )
        .unwrap();
        let log_id: i64 = conn
            .query_row("SELECT id FROM record WHERE title = '前置泵温差偏大'", [], |r| r.get(0))
            .unwrap();

        // 移入表格：只写 sheet_id，kind 不变（这就是「保留出生地」）
        conn.execute("UPDATE record SET sheet_id = ?1 WHERE id = ?2", [sheet_id, log_id])
            .unwrap();

        // ① + ② + ③：sheetStore.loadRows 的完整 SQL
        let load_rows = "SELECT id, sheet_id, custom AS data, CAST(sort AS INTEGER) AS sort, \
                                height, created_at, updated_at, \
                                kind, title, body, parent_id, status \
                           FROM record WHERE sheet_id = ?1 ORDER BY sort, id";
        let mut stmt = conn.prepare(load_rows).expect("loadRows SQL 不合法");
        let cols: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
        assert!(cols.contains(&"data".to_string()), "custom AS data 别名失效，parseRowData 会读到空");
        let rows: Vec<(i64, String)> = stmt
            .query_map([sheet_id], |r| Ok((r.get(0)?, r.get(7)?)))
            .unwrap()
            .filter_map(|x| x.ok())
            .collect();
        drop(stmt);
        assert_eq!(rows.len(), 1, "移入表格的随手记没被查出来（还在走 kind='sheet_row'？）");
        assert_eq!(rows[0].1, "log", "移入后 kind 不应改变");

        // ② sort 必须是整数：record.sort 是 REAL，不加 CAST 会拿到 2.0 让严格比较失效
        conn.execute(
            "INSERT INTO record (kind, sheet_id, custom, sort, title, body, created_at, updated_at) \
             VALUES ('sheet_row', ?1, '{\"f\":\"整数校验\"}', 2.5, '', '', '', '')",
            [sheet_id],
        )
        .unwrap();
        let frac_id: i64 = conn
            .query_row("SELECT id FROM record WHERE custom LIKE '%整数校验%'", [], |r| r.get(0))
            .expect("插入的小数 sort 行没找到");
        let (sort_val, sort_type): (i64, String) = conn
            .query_row(
                "SELECT CAST(sort AS INTEGER), typeof(CAST(sort AS INTEGER)) FROM record WHERE id = ?1",
                [frac_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("CAST(sort AS INTEGER) 查询失败");
        assert_eq!(sort_val, 2, "CAST 应把 2.5 截断为 2");
        assert_eq!(sort_type, "integer", "CAST 后类型应为 integer，否则 row.sort === 3 会失效");

        // ④ 删表两段式（顺序：先删表格出生的行，再把移入的放回记录页）
        conn.execute("DELETE FROM record WHERE sheet_id = ?1 AND kind = 'sheet_row'", [sheet_id])
            .unwrap();
        conn.execute("UPDATE record SET sheet_id = NULL WHERE sheet_id = ?1", [sheet_id])
            .unwrap();
        conn.execute("DELETE FROM sheet WHERE id = ?1", [sheet_id]).unwrap();

        let remain: i64 = conn
            .query_row("SELECT COUNT(*) FROM record WHERE sheet_id = ?1", [sheet_id], |r| r.get(0))
            .unwrap();
        assert_eq!(remain, 0, "删表后留下孤儿行（sheet_id 还指着已删的表）");

        let log_alive: i64 = conn
            .query_row("SELECT COUNT(*) FROM record WHERE id = ?1", [log_id], |r| r.get(0))
            .unwrap();
        assert_eq!(log_alive, 1, "移入的行被错误地随表销毁了");

        // 关键：NULL 必须是 SQL NULL，不能是字符串 'null'
        let sid_type: String = conn
            .query_row("SELECT typeof(sheet_id) FROM record WHERE id = ?1", [log_id], |r| r.get(0))
            .unwrap();
        assert_eq!(sid_type, "null", "sheet_id 落成了 '{}'，WHERE sheet_id IS NULL 会查不到它", sid_type);

        drop(conn);
        let _ = fs::remove_dir_all(&tmp);
    }

    // recordStore.createRecord 用 `INSERT ... RETURNING id` 拿新 id，不用 MAX(id)：
    // MAX(id) 在插入失败时会返回「上一条记录的 id」，调用方拿去打开就是错的记录。
    // 但这条语句走的是 db_query（prepare → query_map → 逐行取列），
    // 必须确认它对**写语句**真的会 step 并返回行 —— 只准备不执行的话，这里会拿到空结果，
    // 而 createRecord 会把空当成「新建失败」抛错（那还算好的），
    // 更糟的是若被当成 0 继续，后续 patch 全会打到 id=0 上。
    #[test]
    fn insert_returning_id_works_through_db_query_path() {
        let tmp = std::env::temp_dir().join("wr-t03-returning");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("创建临时目录失败");
        let db = tmp.join("t.db");
        let json = tmp.join("t.json");
        init_and_migrate_db_at(&db.to_string_lossy(), &json.to_string_lossy()).expect("迁移失败");

        let conn = Connection::open(&db).unwrap();

        let sql = "INSERT INTO record (kind, title, sheet_id, parent_id) \
                   VALUES ('log', 'RETURNING 探针', NULL, NULL) RETURNING id";
        let mut stmt = conn.prepare(sql).expect("INSERT ... RETURNING 无法 prepare");
        let names: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
        assert_eq!(names, vec!["id".to_string()], "RETURNING 没有返回 id 列");
        let first: i64 = stmt.query_row([], |r| r.get(0)).expect("RETURNING 没有返回行，createRecord 会拿不到 id");
        assert!(first > 0, "拿到的 id 不是正数：{}", first);
        drop(stmt);

        // 连插两条必须拿到两个不同的 id（防止拿到常量 / 上一次的缓存）
        let second: i64 = conn
            .query_row(
                "INSERT INTO record (kind, title) VALUES ('log', 'RETURNING 探针2') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(first, second, "两次插入拿到同一个 id");

        // 字面量 NULL 必须落成真正的 NULL，不是字符串 'null'
        let (sheet, parent, title): (Option<i64>, Option<i64>, String) = conn
            .query_row(
                "SELECT sheet_id, parent_id, title FROM record WHERE id = ?1",
                [first],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(sheet, None, "sheet_id 应为 NULL");
        assert_eq!(parent, None, "parent_id 应为 NULL");
        assert_eq!(title, "RETURNING 探针");

        let typeof_parent: String = conn
            .query_row("SELECT typeof(parent_id) FROM record WHERE id = ?1", [first], |r| r.get(0))
            .unwrap();
        assert_eq!(typeof_parent, "null", "parent_id 的存储类型是 {}，应为 null", typeof_parent);

        drop(conn);
        let _ = fs::remove_dir_all(&tmp);
    }
}
