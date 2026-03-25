#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};
use serde_json::{json, Value};
use chrono::Local;

// 获取记忆的路径配置文件
fn get_config_path() -> PathBuf {
    std::env::current_dir().unwrap_or_default().join("path_config.txt")
}

// 获取当前真正的数据存放路径
fn get_data_file_path() -> String {
    let config_path = get_config_path();
    if let Ok(custom_path) = fs::read_to_string(&config_path) {
        let trimmed = custom_path.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    std::env::current_dir().unwrap_or_default().join("my_data.json").to_string_lossy().to_string()
}

#[tauri::command]
fn get_current_path() -> String {
    get_data_file_path()
}

// 🛡️ 防御升级 1：安全的路径迁移与强制备份
// main.rs

// 🛡️ 新增：路径检测探针，只检查不修改
#[tauri::command]
fn check_path(target: String) -> String {
    let path = Path::new(&target);
    let mut final_path = path.to_path_buf();

    // 如果用户选的是文件夹，自动追加 my_data.json
    if path.is_dir() {
        final_path = path.join("my_data.json");
    } else if final_path.extension().and_then(|e| e.to_str()) != Some("json") {
        // 如果用户瞎选了个没后缀的文件，强制纠正
        final_path.set_extension("json");
    }

    let exists = final_path.exists();
    let mut is_empty = true;
    if exists {
        if let Ok(meta) = fs::metadata(&final_path) {
            is_empty = meta.len() == 0;
        }
    }

    json!({
        "final_path": final_path.to_string_lossy().into_owned(),
        "exists": exists,
        "is_empty": is_empty
    }).to_string()
}

// 🛡️ 重构：安全的路径应用引擎，严格区分「覆盖」与「加载」
#[tauri::command]
fn apply_new_path(new_path: String, mode: String) -> Result<String, String> {
    let old_path = get_data_file_path();
    if old_path == new_path {
        return Ok("路径未发生改变".to_string());
    }

    if let Some(parent) = Path::new(&new_path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let config_path = get_config_path();

    if mode == "OVERWRITE" || mode == "CREATE" {
        // 【覆盖/新建模式】：必须先备份目标位置的旧文件，然后把当前数据拷贝过去
        if Path::new(&new_path).exists() {
            let timestamp = Local::now().format("%Y%m%d_%H%M%S");
            let backup_path = format!("{}.{}.bak", new_path, timestamp);
            let _ = fs::rename(&new_path, backup_path); // 使用 rename 进行安全备份
        }
        if Path::new(&old_path).exists() {
            fs::copy(&old_path, &new_path).map_err(|e| format!("复制数据失败: {}", e))?;
        }
    } else if mode == "LOAD" {
        // 【加载模式】：说明用户想直接读取目标位置的文件。我们什么文件都不用拷贝，只改配置！
    } else {
        return Err("未知的操作模式".to_string());
    }

    // 更新指向配置文件
    fs::write(config_path, &new_path).map_err(|e| format!("保存配置失败: {}", e))?;
    Ok("路径更新成功".to_string())
}


#[tauri::command]
fn load_data() -> String {
    let data_file = get_data_file_path();
    
    let default_data = json!({
        "todos": [], 
        "logs": {}, 
        "tags": ["💻 工作", "☕ 生活", "🎮 娱乐", "✅ 待办", "📚 学习"],
        "settings": { "auto_cleanup_days": 7, "theme": "dark" }
    });

    if let Some(parent) = Path::new(&data_file).parent() {
        let _ = fs::create_dir_all(parent);
    }

    let file_content = fs::read_to_string(&data_file).unwrap_or_default();
    if file_content.is_empty() {
        return default_data.to_string();
    }

    let mut data: Value = serde_json::from_str(&file_content).unwrap_or(default_data.clone());

    if data.get("tags").is_none() { data["tags"] = default_data["tags"].clone(); }
    if data.get("sub_tags").is_none() { data["sub_tags"] = json!({}); }
    if data.get("settings").is_none() { data["settings"] = default_data["settings"].clone(); }
    
    if let Some(todos) = data.get_mut("todos").and_then(|t| t.as_array_mut()) {
        for t in todos.iter_mut() {
            if t.get("tag").is_none() { t["tag"] = json!("✅ 待办"); }
            if t.get("remark").is_none() { t["remark"] = json!(""); }
        }
    }

    data.to_string()
}

// 🛡️ 防御升级 2：原子化保存 (防断电、防写空)
#[tauri::command]
fn save_data(data: String) -> Result<(), String> {
    let data_file = get_data_file_path();
    
    // 如果传入的数据极其异常（比如空字符串或者太短），拒绝保存并抛出错误
    if data.trim().is_empty() || data.len() < 10 {
        return Err("检测到异常空数据，拒绝覆盖源文件！".to_string());
    }

    if let Some(parent) = Path::new(&data_file).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // 双保险机制：不要直接覆盖原文件。
    // 先把数据写到一个临时的 .tmp 文件里。
    let tmp_file = format!("{}.tmp", data_file);
    fs::write(&tmp_file, &data).map_err(|e| format!("临时数据写入失败: {}", e))?;

    // 只有临时文件完整写成功了，才瞬间替换掉原文件 (原子操作)
    fs::rename(&tmp_file, &data_file).map_err(|e| format!("保存数据失败: {}", e))?;

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_data, 
            save_data, 
            get_current_path, 
            check_path, 
            apply_new_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}