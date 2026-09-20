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

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table)).map_err(|e| e.to_string())?;
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
    let db_path = get_db_file_path();
    let json_path = get_data_file_path();
    let mut conn = Connection::open(&db_path).map_err(|e| format!("无法打开数据库: {}", e))?;

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

    let json_exists = Path::new(&json_path).exists();
    // ✅ 修复了之前的借用检查器报错，一步到位！
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0)).unwrap_or(0);

    if json_exists && count == 0 {
        println!("🚀 发现旧版 JSON 数据且数据库为空，正在后台静默迁移...");
        let file_content = fs::read_to_string(&json_path).unwrap_or_default();
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
    let rusqlite_params = rusqlite::params_from_iter(params.iter());
    conn.execute(&query, rusqlite_params).map_err(|e| e.to_string())
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

#[tauri::command] async fn load_data() -> String { 
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
            notes_fs::notes_ensure_root,
            notes_fs::notes_root_path,
            notes_fs::notes_list,
            notes_fs::notes_read,
            notes_fs::notes_write,
            notes_fs::notes_update_meta,
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
