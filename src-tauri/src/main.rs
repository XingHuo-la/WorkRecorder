#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
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

// 🛡️ 应用启动时的数据迁移逻辑
fn init_and_migrate_db() -> Result<(), String> {
    let db_path = get_db_file_path();
    let json_path = get_data_file_path();
    let mut conn = Connection::open(&db_path).map_err(|e| format!("无法打开数据库: {}", e))?;

    conn.execute_batch(
        "BEGIN;
        CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, done BOOLEAN NOT NULL, tag TEXT, sub_tag TEXT, detail TEXT, remark TEXT, deadline TEXT, completed_at TEXT);
        CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, time TEXT NOT NULL, text TEXT NOT NULL, tag TEXT, sub_tag TEXT, detail TEXT, remark TEXT, linked_todo TEXT, deadline TEXT, is_overdue BOOLEAN);
        CREATE TABLE IF NOT EXISTS tags (name TEXT PRIMARY KEY, is_active BOOLEAN);
        CREATE TABLE IF NOT EXISTS sub_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, main_tag TEXT NOT NULL, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
        COMMIT;"
    ).map_err(|e| format!("建表失败: {}", e))?;

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
#[tauri::command]
fn db_query(query: String, params: Vec<String>) -> Result<String, String> {
    let conn = Connection::open(get_db_file_path()).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
    let column_names: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
    let rusqlite_params = rusqlite::params_from_iter(params.iter());
    
    let rows = stmt.query_map(rusqlite_params, |row| {
        let mut map = serde_json::Map::new();
        for i in 0..column_names.len() {
            let val = row.get_ref(i).unwrap();
            let json_val = match val {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(i) => json!(i),
                ValueRef::Real(f) => json!(f),
                ValueRef::Text(t) => json!(std::str::from_utf8(t).unwrap_or("")),
                ValueRef::Blob(_) => Value::Null,
            };
            map.insert(column_names[i].clone(), json_val);
        }
        Ok(Value::Object(map))
    }).map_err(|e| e.to_string())?;

    let mut result_vec = Vec::new();
    for row in rows { result_vec.push(row.unwrap()); }
    Ok(json!(result_vec).to_string())
}

// 🌟 万能桥梁 2：让前端直接修改/删除/插入数据
#[tauri::command]
fn db_execute(query: String, params: Vec<String>) -> Result<usize, String> {
    let conn = Connection::open(get_db_file_path()).map_err(|e| e.to_string())?;
    let rusqlite_params = rusqlite::params_from_iter(params.iter());
    let rows_affected = conn.execute(&query, rusqlite_params).map_err(|e| e.to_string())?;
    Ok(rows_affected)
}

// （保留旧的指令，确保我们重写 JS 前，应用绝不崩溃！）
#[tauri::command] fn get_current_path() -> String { get_data_file_path() }
#[tauri::command] fn check_path(target: String) -> String { json!({"final_path": target, "exists": false, "is_empty": true}).to_string() }
#[tauri::command] fn apply_new_path(_new_path: String, _mode: String) -> Result<String, String> { Ok("".to_string()) }
#[tauri::command] fn load_data() -> String { 
    fs::read_to_string(&get_data_file_path()).unwrap_or_else(|_| json!({ "todos": [], "logs": {}, "tags": [], "settings": {} }).to_string()) 
}
#[tauri::command] fn save_data(data: String) -> Result<(), String> { 
    fs::write(&get_data_file_path(), &data).map_err(|e| e.to_string()) 
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            if let Err(e) = init_and_migrate_db() { eprintln!("⚠️ 数据库初始化或迁移出错: {}", e); }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_data, save_data, get_current_path, check_path, apply_new_path,
            db_query, db_execute // 👈 注册了两个新桥梁
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}