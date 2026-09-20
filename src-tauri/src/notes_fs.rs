//! 笔记文件系统层：文件优先（file-first）笔记存储。
//!
//! 设计约定：
//! - 笔记正文只以 `.md` 文件形式存在磁盘上，是唯一真相源（single source of truth）。
//! - 目录结构：`<数据目录>/notes/<主分类>/<子项目>/YYYY-MM-DD-标题.md`
//!   无子项目时直接落在 `<主分类>/` 下；主分类为空时归入「未分类」。
//! - 每个 `.md` 文件顶部带一段 YAML front-matter，承载 id/type/tag 等元数据。
//! - 数据库只做索引，方便快速列表与搜索，不存正文。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};

/// 无主分类时的兜底分类名，与前端 DEFAULT_TAG 保持一致。
pub const DEFAULT_TAG: &str = "未分类";

/// 单条笔记的元数据 + 正文，前端与 Rust 之间的传输结构。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NoteDoc {
    /// 数据库中的 id；新写入且未落库时为 None。
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default = "default_note_type")]
    pub note_type: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub sub_tag: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    /// 相对笔记根目录的路径，例如 `工作/项目A/2026-09-20-设计评审.md`。
    #[serde(default)]
    pub rel_path: String,
    /// 文件绝对路径，前端用于「在 Typora 中打开」。
    #[serde(default)]
    pub abs_path: String,
}

fn default_note_type() -> String {
    "idea".to_string()
}

fn notes_root(data_file_path: &str) -> PathBuf {
    let mut path = PathBuf::from(data_file_path);
    path.set_extension("");
    let parent = path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    parent.join("notes")
}

/// 把任意字符串里的路径非法字符替换掉，生成安全的单个路径片段。
///
/// 除了 Windows 保留字符，还要处理结尾的点和空格（Windows 不允许），
/// 并规避 CON/PRN/AUX 等保留设备名。
fn sanitize_segment(raw: &str) -> String {
    let mut cleaned: String = raw
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if (c as u32) < 0x20 => '-',
            c => c,
        })
        .collect();

    cleaned = cleaned.trim().trim_end_matches('.').trim().to_string();

    let upper = cleaned.to_ascii_uppercase();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&upper.as_str()) {
        cleaned = format!("_{}", cleaned);
    }

    if cleaned.is_empty() {
        cleaned = "未命名".to_string();
    }

    // 单个路径片段过长会让整条路径超出上限，这里保守截断。
    if cleaned.chars().count() > 80 {
        cleaned = cleaned.chars().take(80).collect();
    }

    cleaned
}

/// 计算笔记相对于笔记根目录的子目录路径（不含文件名）。
fn relative_dir(tag: &str, sub_tag: &str) -> PathBuf {
    let tag = tag.trim();
    let sub_tag = sub_tag.trim();

    let main = if tag.is_empty() {
        DEFAULT_TAG.to_string()
    } else {
        sanitize_segment(tag)
    };
    let sub = if sub_tag.is_empty() {
        None
    } else {
        Some(sanitize_segment(sub_tag))
    };

    match sub {
        Some(sub) => PathBuf::from(main).join(sub),
        None => PathBuf::from(main),
    }
}

/// 把「日期 + 标题」组合成文件名，并在冲突时追加序号。
fn build_file_name(date: &str, title: &str, dir: &Path, keep: Option<&Path>) -> String {
    let base_title = {
        let cleaned = sanitize_segment(title);
        let cleaned = cleaned.trim_matches('-').trim().to_string();
        if cleaned.is_empty() {
            "未命名笔记".to_string()
        } else {
            cleaned
        }
    };

    let prefix = if date.trim().is_empty() {
        String::new()
    } else {
        format!("{}-", date.trim())
    };

    let mut candidate = format!("{}{}.md", prefix, base_title);
    let mut index = 2;
    while dir.join(&candidate).exists() {
        // 正在改写的就是这个文件，不需要换名。
        if let Some(keep) = keep {
            if keep == dir.join(&candidate) {
                break;
            }
        }
        candidate = format!("{}{}-{}.md", prefix, base_title, index);
        index += 1;
        if index > 9999 {
            break;
        }
    }
    candidate
}

/// 校验并规范化前端传来的相对路径，阻止目录穿越。
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.replace('\\', "/");
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() {
        return Err("笔记路径为空".to_string());
    }

    let candidate = Path::new(rel);
    for component in candidate.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err(format!("笔记路径不合法: {}", rel)),
        }
    }

    let joined = root.join(candidate);
    let root_norm = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    if let Ok(target_norm) = fs::canonicalize(&joined) {
        if !target_norm.starts_with(&root_norm) {
            return Err(format!("笔记路径越出笔记目录: {}", rel));
        }
    }

    Ok(joined)
}

fn escape_yaml_value(value: &str) -> String {
    let needs_quote = value.contains(':')
        || value.contains('#')
        || value.contains('"')
        || value.contains('\'')
        || value.starts_with(' ')
        || value.ends_with(' ')
        || value.contains('\n')
        || value.is_empty();

    if needs_quote {
        let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{}\"", escaped)
    } else {
        value.to_string()
    }
}

fn unquote_yaml_value(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        let inner = &trimmed[1..trimmed.len() - 1];
        inner.replace("\\\"", "\"").replace("\\\\", "\\")
    } else {
        trimmed.to_string()
    }
}

/// 生成完整的 `.md` 文件文本：YAML front-matter + 正文。
pub fn render_markdown(doc: &NoteDoc) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    if let Some(id) = doc.id {
        out.push_str(&format!("id: {}\n", id));
    }
    out.push_str(&format!("title: {}\n", escape_yaml_value(&doc.title)));
    out.push_str(&format!(
        "type: {}\n",
        escape_yaml_value(if doc.note_type.is_empty() {
            "idea"
        } else {
            &doc.note_type
        })
    ));
    out.push_str(&format!(
        "status: {}\n",
        escape_yaml_value(if doc.status.is_empty() {
            "usable"
        } else {
            &doc.status
        })
    ));
    out.push_str(&format!("tag: {}\n", escape_yaml_value(&doc.tag)));
    out.push_str(&format!("sub_tag: {}\n", escape_yaml_value(&doc.sub_tag)));
    out.push_str(&format!(
        "created_at: {}\n",
        escape_yaml_value(&doc.created_at)
    ));
    out.push_str(&format!(
        "updated_at: {}\n",
        escape_yaml_value(&doc.updated_at)
    ));
    out.push_str("---\n\n");
    out.push_str(&doc.content);
    if !doc.content.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// 解析 `.md` 文件文本，拆出 front-matter 与正文。
///
/// 对格式损坏的文件保持宽容：解析不出 front-matter 时，整段文本当作正文。
pub fn parse_markdown(text: &str, fallback_title: &str) -> NoteDoc {
    let normalized = text.replace("\r\n", "\n");
    let mut doc = NoteDoc {
        title: fallback_title.to_string(),
        note_type: default_note_type(),
        status: "usable".to_string(),
        content: normalized.clone(),
        ..Default::default()
    };

    let trimmed_start = normalized.trim_start_matches('\u{feff}');
    if !trimmed_start.starts_with("---") {
        return doc;
    }

    // 找到 front-matter 的结束分隔行
    let after_first = &trimmed_start[3..];
    let after_first = after_first.strip_prefix('\n').unwrap_or(after_first);
    let mut end_index = None;
    let mut offset = 0usize;
    for line in after_first.split('\n') {
        if line.trim() == "---" {
            end_index = Some(offset);
            break;
        }
        offset += line.len() + 1;
    }

    let Some(end_index) = end_index else {
        return doc;
    };

    let front_matter = &after_first[..end_index];
    let body = &after_first[end_index..];
    let body = body.strip_prefix("---").unwrap_or(body);
    let body = body.strip_prefix('\n').unwrap_or(body);
    // 去掉 front-matter 与正文之间可能存在的空行，只保留正文自身结构
    let body = body.strip_prefix('\n').unwrap_or(body);

    for line in front_matter.split('\n') {
        let Some(colon) = line.find(':') else {
            continue;
        };
        let key = line[..colon].trim();
        let value = unquote_yaml_value(&line[colon + 1..]);
        match key {
            "id" => doc.id = value.parse::<i64>().ok(),
            "title" => {
                if !value.is_empty() {
                    doc.title = value;
                }
            }
            "type" | "note_type" => {
                if !value.is_empty() {
                    doc.note_type = value;
                }
            }
            "status" => {
                if !value.is_empty() {
                    doc.status = value;
                }
            }
            "tag" => doc.tag = value,
            "sub_tag" => doc.sub_tag = value,
            "created_at" => doc.created_at = value,
            "updated_at" => doc.updated_at = value,
            _ => {}
        }
    }

    doc.content = body.trim_end_matches('\n').to_string();
    doc
}

/// 从文件名里剥掉 `.md` 后缀与开头的 `YYYY-MM-DD-` 日期前缀，得到标题。
fn title_from_file_name(file_name: &str) -> String {
    let stem = file_name.strip_suffix(".md").unwrap_or(file_name);
    let bytes = stem.as_bytes();
    let has_date_prefix = stem.len() > 11
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'-'
        && stem[..4].chars().all(|c| c.is_ascii_digit())
        && stem[5..7].chars().all(|c| c.is_ascii_digit())
        && stem[8..10].chars().all(|c| c.is_ascii_digit());

    if has_date_prefix {
        stem[11..].trim_matches('-').to_string()
    } else {
        stem.to_string()
    }
}

fn walk_markdown_files(dir: &Path, root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_markdown_files(&path, root, out);
        } else if path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("md"))
            .unwrap_or(false)
        {
            out.push(path);
        }
    }
    let _ = root;
}

/// 确保笔记根目录存在，并保证「未分类」目录可用。
/// 返回笔记根目录的绝对路径。
#[tauri::command]
pub async fn notes_ensure_root(data_file_path: String) -> Result<String, String> {
    let root = notes_root(&data_file_path);
    fs::create_dir_all(root.join(DEFAULT_TAG))
        .map_err(|e| format!("创建笔记目录失败: {}", e))?;
    Ok(root.to_string_lossy().to_string())
}

/// 返回笔记根目录绝对路径（不创建）。
#[tauri::command]
pub async fn notes_root_path(data_file_path: String) -> String {
    notes_root(&data_file_path).to_string_lossy().to_string()
}

/// 扫描笔记目录，读出所有 `.md` 笔记。
#[tauri::command]
pub async fn notes_list(data_file_path: String) -> Result<Vec<NoteDoc>, String> {
    let root = notes_root(&data_file_path);
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    walk_markdown_files(&root, &root, &mut files);

    let mut docs = Vec::with_capacity(files.len());
    for file in files {
        let Ok(text) = fs::read_to_string(&file) else {
            // 单个文件读失败（编码异常等）不应该中断整次扫描
            continue;
        };

        let file_name = file
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let fallback_title = title_from_file_name(&file_name);
        let mut doc = parse_markdown(&text, &fallback_title);

        let rel = file
            .strip_prefix(&root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| file_name.clone());
        doc.rel_path = rel;
        doc.abs_path = file.to_string_lossy().to_string();

        // 目录结构是分类归属的权威来源，文件内容里的 tag 只作为补充
        if let Some(parent) = Path::new(&doc.rel_path).parent() {
            let mut parts = parent
                .components()
                .filter_map(|c| match c {
                    Component::Normal(s) => Some(s.to_string_lossy().to_string()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            let dir_tag = parts.first().cloned().unwrap_or_default();
            let dir_sub = if parts.len() > 1 {
                parts.remove(1)
            } else {
                String::new()
            };
            if !dir_tag.is_empty() && dir_tag != DEFAULT_TAG {
                doc.tag = dir_tag;
            }
            doc.sub_tag = dir_sub;
        }

        docs.push(doc);
    }

    // 按更新时间倒序，缺失更新时间的排到最后。
    // 两个键必须用同一套回退规则，否则空 updated_at 会让顺序错乱。
    let sort_key = |doc: &NoteDoc| {
        if doc.updated_at.is_empty() {
            doc.created_at.clone()
        } else {
            doc.updated_at.clone()
        }
    };
    docs.sort_by(|a, b| sort_key(b).cmp(&sort_key(a)));

    Ok(docs)
}

/// 读取单篇笔记。
#[tauri::command]
pub async fn notes_read(data_file_path: String, rel_path: String) -> Result<NoteDoc, String> {
    let root = notes_root(&data_file_path);
    let target = safe_join(&root, &rel_path)?;
    let text = fs::read_to_string(&target)
        .map_err(|e| format!("读取笔记失败 {}: {}", rel_path, e))?;

    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut doc = parse_markdown(&text, &title_from_file_name(&file_name));
    doc.rel_path = rel_path;
    doc.abs_path = target.to_string_lossy().to_string();
    Ok(doc)
}

/// 新建或覆盖保存一篇笔记，返回保存后的文档（含最终路径）。
///
/// - `rel_path` 为空表示新建。
/// - 内容变化时会自动改名以匹配新的标题，并删除旧文件。
#[tauri::command]
pub async fn notes_write(data_file_path: String, doc: NoteDoc) -> Result<NoteDoc, String> {
    let root = notes_root(&data_file_path);
    let target_dir = root.join(relative_dir(&doc.tag, &doc.sub_tag));
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("创建笔记分类目录失败: {}", e))?;

    let date_prefix = if doc.created_at.len() >= 10 {
        // 用 get 而非切片：按字节切可能落在多字节字符中间而 panic
        doc.created_at.get(..10).unwrap_or("").to_string()
    } else {
        String::new()
    };

    let existing_path = if doc.rel_path.trim().is_empty() {
        None
    } else {
        Some(safe_join(&root, &doc.rel_path)?)
    };
    let keep = existing_path.as_deref();

    // 标题变化时，文件名也跟着变，保持「文件名即标题」
    let mut file_name = existing_path
        .as_ref()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let desired_name = build_file_name(&date_prefix, &doc.title, &target_dir, keep);
    let existing_name_matches = existing_path
        .as_ref()
        .map(|p| p.parent() == Some(target_dir.as_path()))
        .unwrap_or(false);

    if !existing_name_matches
        || file_name.is_empty()
        || title_from_file_name(&file_name) != title_from_file_name(&desired_name)
    {
        file_name = desired_name;
    }

    let final_path = target_dir.join(&file_name);
    let text = render_markdown(&doc);
    fs::write(&final_path, text)
        .map_err(|e| format!("写入笔记失败 {}: {}", file_name, e))?;

    // 位置或文件名变了，清掉旧文件
    if let Some(old_path) = existing_path {
        if old_path != final_path && old_path.exists() {
            let _ = fs::remove_file(&old_path);
        }
    }

    let rel = final_path
        .strip_prefix(&root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or(file_name.clone());

    let mut saved = doc.clone();
    saved.rel_path = rel;
    saved.abs_path = final_path.to_string_lossy().to_string();
    Ok(saved)
}

/// 只改写 front-matter，不动正文。用于列表里的快速改分类等操作。
#[tauri::command]
pub async fn notes_update_meta(
    data_file_path: String,
    rel_path: String,
    doc: NoteDoc,
) -> Result<NoteDoc, String> {
    let root = notes_root(&data_file_path);
    let existing = safe_join(&root, &rel_path)?;
    let text = fs::read_to_string(&existing)
        .map_err(|e| format!("读取笔记失败 {}: {}", rel_path, e))?;

    let file_name = existing
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut parsed = parse_markdown(&text, &title_from_file_name(&file_name));

    // 仅覆盖调用方明确给出的字段，正文一律以磁盘为准
    parsed.id = doc.id.or(parsed.id);
    if !doc.title.trim().is_empty() {
        parsed.title = doc.title;
    }
    if !doc.note_type.trim().is_empty() {
        parsed.note_type = doc.note_type;
    }
    if !doc.status.trim().is_empty() {
        parsed.status = doc.status;
    }
    parsed.tag = doc.tag;
    parsed.sub_tag = doc.sub_tag;
    if !doc.updated_at.trim().is_empty() {
        parsed.updated_at = doc.updated_at;
    }
    parsed.rel_path = rel_path;

    notes_write(data_file_path, parsed).await
}

/// 删除笔记文件。文件不存在时视为已完成（幂等）。
#[tauri::command]
pub async fn notes_delete(data_file_path: String, rel_path: String) -> Result<(), String> {
    let root = notes_root(&data_file_path);
    let target = safe_join(&root, &rel_path)?;
    if !target.exists() {
        return Ok(());
    }
    fs::remove_file(&target).map_err(|e| format!("删除笔记失败 {}: {}", rel_path, e))?;

    // 顺手清掉空目录，保持分类树干净
    if let Some(mut parent) = target.parent().map(|p| p.to_path_buf()) {
        while parent.starts_with(&root) && parent != root {
            let is_empty = fs::read_dir(&parent)
                .map(|mut it| it.next().is_none())
                .unwrap_or(false);
            if !is_empty {
                break;
            }
            if fs::remove_dir(&parent).is_err() {
                break;
            }
            match parent.parent() {
                Some(p) if p.starts_with(&root) => parent = p.to_path_buf(),
                _ => break,
            }
        }
    }

    Ok(())
}

/// 旧笔记迁移结果，回传给前端做提示。
#[derive(Debug, Serialize, Default)]
pub struct MigrateOutcome {
    pub skipped: bool,
    pub migrated: usize,
    pub failed: usize,
    pub backup_count: usize,
    pub messages: Vec<String>,
}

/// 把旧的 SQLite `notes` 表迁移成磁盘 `.md` 文件。
///
/// 放在 Rust 侧执行，原因：
/// - 迁移只读一次源表、写一批文件，本质是后端职责，不需要前端往返；
/// - 前端逐条 `invoke` 在数据量或环境异常时容易半途中断，恢复逻辑复杂。
///
/// 幂等：以 `settings.notes_fs_migrated` 为标记，已迁移直接返回。
/// 安全：先备份到 `notes_migrated_backup`，任一文件写入失败都不清空源表。
#[tauri::command]
pub async fn notes_migrate_legacy(data_file_path: String, force: Option<bool>) -> Result<MigrateOutcome, String> {
    let force = force.unwrap_or(false);
    let mut outcome = MigrateOutcome::default();

    // 数据库与数据文件同目录，扩展名换成 .db
    let mut db_file = PathBuf::from(&data_file_path);
    db_file.set_extension("db");

    let conn = rusqlite::Connection::open(&db_file)
        .map_err(|e| format!("打开数据库失败 {}: {}", db_file.to_string_lossy(), e))?;

    // 标记表不存在时先建，保证 INSERT 可用
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)",
        [],
    )
    .map_err(|e| format!("准备 settings 表失败: {}", e))?;

    if !force {
        let done: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'notes_fs_migrated'",
                [],
                |row| row.get(0),
            )
            .ok();
        if done.as_deref() == Some("1") {
            outcome.skipped = true;
            outcome.messages.push("已迁移过，跳过".to_string());
            return Ok(outcome);
        }
    }

    // 读出所有旧笔记
    let mut stmt = conn
        .prepare("SELECT id, title, content, note_type, status, tag, sub_tag, created_at, updated_at FROM notes")
        .map_err(|e| format!("读取旧笔记失败: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(NoteDoc {
                id: row.get::<_, Option<i64>>(0)?,
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                content: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                note_type: row.get::<_, Option<String>>(3)?.unwrap_or_else(default_note_type),
                status: row.get::<_, Option<String>>(4)?.unwrap_or_else(|| "usable".to_string()),
                tag: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                sub_tag: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                created_at: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                updated_at: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                rel_path: String::new(),
                abs_path: String::new(),
            })
        })
        .map_err(|e| format!("解析旧笔记失败: {}", e))?;

    let docs: Vec<NoteDoc> = rows.filter_map(|r| r.ok()).collect();
    drop(stmt);

    if docs.is_empty() {
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('notes_fs_migrated', '1')",
            [],
        )
        .map_err(|e| format!("写入迁移标记失败: {}", e))?;
        outcome.skipped = true;
        outcome.messages.push("没有旧笔记，已打标记".to_string());
        return Ok(outcome);
    }

    // 先备份，失败就中止且不动源表
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS notes_migrated_backup (
            id INTEGER PRIMARY KEY,
            title TEXT, content TEXT, note_type TEXT, status TEXT,
            tag TEXT, sub_tag TEXT, source_type TEXT, source_id INTEGER,
            created_at TEXT, updated_at TEXT, migrated_at TEXT
        );",
    )
    .map_err(|e| format!("创建备份表失败: {}", e))?;

    let existing: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes_migrated_backup", [], |row| row.get(0))
        .unwrap_or(0);

    if (existing as usize) < docs.len() {
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        for doc in &docs {
            let affected = conn
                .execute(
                    "INSERT OR REPLACE INTO notes_migrated_backup
                     (id, title, content, note_type, status, tag, sub_tag, source_type, source_id, created_at, updated_at, migrated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?)",
                    rusqlite::params![
                        doc.id,
                        doc.title,
                        doc.content,
                        doc.note_type,
                        doc.status,
                        doc.tag,
                        doc.sub_tag,
                        doc.created_at,
                        doc.updated_at,
                        stamp,
                    ],
                )
                .map_err(|e| format!("备份笔记 {:?} 失败: {}", doc.id, e))?;
            if affected == 0 {
                return Err(format!("备份笔记 {:?} 未生效，已保留原表", doc.id));
            }
            outcome.backup_count += 1;
        }
    }

    // 逐条写成 .md 文件
    for doc in &docs {
        match write_note_doc(&data_file_path, doc) {
            Ok(saved) => {
                outcome.migrated += 1;
                outcome.messages.push(format!("{} -> {}", doc.title, saved.rel_path));
            }
            Err(e) => {
                outcome.failed += 1;
                outcome.messages.push(format!("{} 失败: {}", doc.title, e));
            }
        }
    }

    // 全部成功才清空源表并打标记
    if outcome.failed == 0 {
        conn.execute("DELETE FROM notes", [])
            .map_err(|e| format!("清空旧笔记失败: {}", e))?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('notes_fs_migrated', '1')",
            [],
        )
        .map_err(|e| format!("写入迁移标记失败: {}", e))?;
    }

    Ok(outcome)
}

/// 写入单篇笔记文件的内部实现，供迁移与命令共用。
fn write_note_doc(data_file_path: &str, doc: &NoteDoc) -> Result<NoteDoc, String> {
    let root = notes_root(data_file_path);
    let target_dir = root.join(relative_dir(&doc.tag, &doc.sub_tag));
    fs::create_dir_all(&target_dir).map_err(|e| format!("创建分类目录失败: {}", e))?;

    let date_prefix = if doc.created_at.len() >= 10 {
        doc.created_at.get(..10).unwrap_or("").to_string()
    } else {
        String::new()
    };

    let file_name = build_file_name(&date_prefix, &doc.title, &target_dir, None);
    let final_path = target_dir.join(&file_name);
    fs::write(&final_path, render_markdown(doc))
        .map_err(|e| format!("写入 {} 失败: {}", file_name, e))?;

    let rel = final_path
        .strip_prefix(&root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or(file_name.clone());

    let mut saved = doc.clone();
    saved.rel_path = rel;
    saved.abs_path = final_path.to_string_lossy().to_string();
    Ok(saved)
}

/// 展开路径里的 `%VAR%` 环境变量（Windows 风格）。
///
/// Tauri 2 不再向前端暴露 `window.__TAURI__.env`，所以候选路径里的
/// `%LOCALAPPDATA%` 之类只能在后端展开。
fn expand_env_vars(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(value) if !value.is_empty() => out.push_str(&value),
                    // 变量不存在时保留原样，交给后续 exists 判断自然失败
                    _ => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                // 落单的 % 原样输出
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// 批量检查若干路径是否存在，返回存在的那些（路径已展开环境变量）。
///
/// 供前端探测外部编辑器用。前端无法直接访问文件系统，
/// 而用 asset 协议 fetch 探测会因下载整个文件而长时间阻塞。
///
/// 返回值为 `[原始候选路径, 展开后的绝对路径]` 配对，
/// 前端用原始字符串去重匹配，用展开后的路径真正启动程序。
#[tauri::command]
pub async fn paths_exist(paths: Vec<String>) -> Vec<(String, String)> {
    paths
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .filter_map(|raw| {
            let expanded = expand_env_vars(&raw);
            if Path::new(&expanded).exists() {
                Some((raw, expanded))
            } else {
                None
            }
        })
        .collect()
}

/// 用系统默认程序打开某个文件（用于「在 Typora 中打开」）。
#[tauri::command]
pub async fn open_path_with_app(path: String, app: Option<String>) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        // 指定了可执行程序就直接调用，否则交给系统默认关联程序
        let mut cmd = match app.as_deref() {
            Some(exe) if !exe.trim().is_empty() => Command::new(exe),
            _ => {
                let mut c = Command::new("cmd");
                c.args(["/C", "start", ""]);
                c.arg(&path);
                c.spawn().map_err(|e| format!("打开文件失败: {}", e))?;
                return Ok(());
            }
        };
        cmd.arg(&path)
            .spawn()
            .map_err(|e| format!("打开文件失败: {}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let program = app.clone().unwrap_or_else(|| "open".to_string());
        let mut cmd = Command::new(program);
        if app.is_some() {
            cmd.arg(&path);
        } else {
            cmd.arg(&path);
        }
        cmd.spawn().map_err(|e| format!("打开文件失败: {}", e))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::process::Command;
        let program = app
            .clone()
            .unwrap_or_else(|| "xdg-open".to_string());
        let mut cmd = Command::new(program);
        cmd.arg(&path);
        cmd.spawn().map_err(|e| format!("打开文件失败: {}", e))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Ok(())
}

/// 列出笔记根目录下的分类（一级目录名）。
#[tauri::command]
pub async fn notes_ensure_tag_dir(data_file_path: String, tag: String) -> Result<String, String> {
    let root = notes_root(&data_file_path);
    let name = if tag.trim().is_empty() {
        DEFAULT_TAG.to_string()
    } else {
        sanitize_segment(&tag)
    };
    let dir = root.join(&name);
    fs::create_dir_all(&dir).map_err(|e| format!("创建分类目录失败: {}", e))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 打开笔记根目录（资源管理器）。
#[tauri::command]
pub async fn notes_open_root(data_file_path: String) -> Result<String, String> {
    let root = notes_root(&data_file_path);
    fs::create_dir_all(&root).map_err(|e| format!("创建笔记目录失败: {}", e))?;

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("explorer")
            .arg(&root)
            .spawn()
            .map_err(|e| format!("打开笔记目录失败: {}", e))?;
        return Ok(root.to_string_lossy().to_string());
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .arg(&root)
            .spawn()
            .map_err(|e| format!("打开笔记目录失败: {}", e))?;
        return Ok(root.to_string_lossy().to_string());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::process::Command;
        Command::new("xdg-open")
            .arg(&root)
            .spawn()
            .map_err(|e| format!("打开笔记目录失败: {}", e))?;
        return Ok(root.to_string_lossy().to_string());
    }

    #[allow(unreachable_code)]
    Ok(root.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_illegal_characters() {
        assert_eq!(sanitize_segment("a/b:c*d?e\"f<g>h|i"), "a-b-c-d-e-f-g-h-i");
        assert_eq!(sanitize_segment("尾部点..."), "尾部点");
        assert_eq!(sanitize_segment("   "), "未命名");
        assert_eq!(sanitize_segment("CON"), "_CON");
    }

    #[test]
    fn front_matter_round_trip() {
        let doc = NoteDoc {
            id: Some(7),
            title: "带: 冒号 的标题".to_string(),
            content: "# 标题\n\n正文公式 $a^2+b^2=c^2$\n".to_string(),
            note_type: "method".to_string(),
            status: "usable".to_string(),
            tag: "工作".to_string(),
            sub_tag: "项目A".to_string(),
            created_at: "2026-09-20 10:00:00".to_string(),
            updated_at: "2026-09-20 11:00:00".to_string(),
            ..Default::default()
        };

        let text = render_markdown(&doc);
        let parsed = parse_markdown(&text, "fallback");

        assert_eq!(parsed.id, Some(7));
        assert_eq!(parsed.title, "带: 冒号 的标题");
        assert_eq!(parsed.note_type, "method");
        assert_eq!(parsed.tag, "工作");
        assert_eq!(parsed.sub_tag, "项目A");
        assert_eq!(parsed.created_at, "2026-09-20 10:00:00");
        assert_eq!(
            parsed.content.trim(),
            "# 标题\n\n正文公式 $a^2+b^2=c^2$".trim()
        );
    }

    #[test]
    fn parse_without_front_matter_keeps_body() {
        let parsed = parse_markdown("就是一段普通文本\n第二行", "回退标题");
        assert_eq!(parsed.title, "回退标题");
        assert!(parsed.content.contains("第二行"));
    }

    #[test]
    fn title_from_file_name_drops_date_prefix() {
        assert_eq!(
            title_from_file_name("2026-09-20-设计评审.md"),
            "设计评审"
        );
        assert_eq!(title_from_file_name("随手记.md"), "随手记");
    }

    #[test]
    fn relative_dir_defaults_to_default_tag() {
        assert_eq!(relative_dir("", ""), PathBuf::from("未分类"));
        assert_eq!(
            relative_dir("工作", "项目A"),
            PathBuf::from("工作").join("项目A")
        );
    }

    #[test]
    fn safe_join_blocks_traversal() {
        let root = PathBuf::from("C:/data/notes");
        assert!(safe_join(&root, "../secret.md").is_err());
        assert!(safe_join(&root, "工作/ok.md").is_ok());
        assert!(safe_join(&root, "").is_err());
    }

    #[test]
    fn build_file_name_adds_suffix_on_conflict() {
        let dir = std::env::temp_dir().join("wr_note_name_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("2026-09-20-标题.md"), "x").unwrap();

        let name = build_file_name("2026-09-20", "标题", &dir, None);
        assert_eq!(name, "2026-09-20-标题-2.md");

        let _ = fs::remove_dir_all(&dir);
    }
}

