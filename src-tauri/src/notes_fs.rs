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
    /// 关联的 record id 集合（v1.2 新口径）。文件里写成 `record_ids: 12,13`。
    ///
    /// 空 vec = 独立笔记。这是**内存里的唯一表示**，任何读路径都以它为准。
    /// 只是**元数据**，不是从属关系：笔记始终以 `.md` 文件为唯一真相，
    /// 可以脱离记录独立存在；删记录时笔记不动，只是变成 record id 悬空的孤儿笔记
    /// （在笔记页照常可见，`note_record` 里查不到而已）。
    #[serde(default)]
    pub record_ids: Vec<i64>,

    /// 旧口径单值，**只读兼容字段**：解析时并进 `record_ids`；写入时永不输出。
    ///
    /// 保留它只为一个用途 —— 让 v1.1 前端（回滚场景）继续能收到 `record_id`。
    /// 不要让任何新代码把它当真相：改关联只走 `record_ids`。
    #[serde(default)]
    pub record_id: Option<i64>,
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

/// 解析 front-matter 里的关联 id 串。
///
/// 为什么是**逗号串**而不是 YAML 块列表：本文件的 front-matter 解析器是手写逐行
/// `line.find(':')`，块列表（`record_ids:` 后换行 + `- 12`）根本读不回来 ——
/// 那会得到一个「应用自己写得出来、自己读不回来」的格式，第一次保存后关联全丢，
/// 而文件看起来完全正常。逗号串在现有解析器里只是 `value.split(',')`。
///
/// 读时宽容：`"12,13"` / `"12, 13"` / `"[12, 13]"` / `"[12,13]"` / `" 12 "` 全部接受，
/// 非数字片段与 `<= 0` 的值一律丢弃（手写出 `record_ids: 12, 待定` 时退化为只有 12）。
fn parse_id_list(raw: &str) -> Vec<i64> {
    raw.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(|c: char| c == ',' || c.is_ascii_whitespace())
        .filter_map(|part| {
            part.trim()
                .trim_matches(|c| c == '"' || c == '\'')
                .parse::<i64>()
                .ok()
        })
        .filter(|id| *id > 0)
        .collect()
}

/// 收口关联 id 集合：只留正整数、升序、去重。
///
/// 三个写入路径（`notes_write` / `mutate_records` / `notes_update_meta`）都调它，
/// 保证「文件里的 id 一定干净」。不这么做的话，一次手写的 `record_ids: 12,12,0`
/// 会永远留在文件里，并被每次全量同步带进 `note_record`。
fn sort_dedup_ids(ids: &mut Vec<i64>) {
    ids.retain(|id| *id > 0);
    ids.sort_unstable();
    ids.dedup();
}

/// 生成完整的 `.md` 文件文本：YAML front-matter + 正文。
pub fn render_markdown(doc: &NoteDoc) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    if let Some(id) = doc.id {
        out.push_str(&format!("id: {}\n", id));
    }
    // 只写有值的记录：独立笔记不产生这一行。
    // 注意这里**只输出 record_ids，永不输出 record_id** —— 旧文件在第一次保存时
    // 自动完成迁移，不需要单独的 migrate 命令（也没法保证用户会去点它）。
    //
    // ⚠️ 这个函数是**整份覆盖**：front-matter 完全由 doc 重建。所以任何调用方
    //    （notes_write / notes_update_meta / 三个关联命令 / notes_migrate_legacy）
    //    只要手里有 record_ids 就必须传全，漏传等于把关联清空且零报错。
    if !doc.record_ids.is_empty() {
        let list = doc
            .record_ids
            .iter()
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",");
        // 逗号串只含数字与逗号，不触发 escape_yaml_value 的引号分支（少一条会被引号搞坏的路）。
        out.push_str(&format!("record_ids: {}\n", list));
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

    // 旧口径的单值先攒在局部变量里，循环结束后统一裁决。
    // 必须两段式：文件里 `record_id` 可能出现在 `record_ids` **之前**，边读边定会误判。
    let mut legacy_single: Option<i64> = None;
    let mut saw_multi = false;

    for line in front_matter.split('\n') {
        let Some(colon) = line.find(':') else {
            continue;
        };
        let key = line[..colon].trim();
        let value = unquote_yaml_value(&line[colon + 1..]);
        match key {
            "id" => doc.id = value.parse::<i64>().ok(),
            "record_ids" => {
                doc.record_ids = parse_id_list(&value);
                saw_multi = true;
            }
            "record_id" => {
                // 不再直接写进 doc：等循环结束再决定它是否生效。
                // 解析失败（手写成了 record_id: 待定）时保持 None，不让整份笔记失效。
                legacy_single = value.parse::<i64>().ok();
            }
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

    // 只有**完全没有** `record_ids` 这一行时，旧单值才生效（QA #1「旧文件无需手工迁移」）。
    //
    // 两个键同时存在时 `record_ids` 赢、`record_id` 整行忽略（不求并集）。
    // 求并集看着更「不丢数据」，但会造出**删不掉的关联**：用户在笔记页点 × 摘掉 #12
    // → 写回 `record_ids: 13`，可文件里那行 `record_id: 12` 还在 → 下次读盘又被并回来
    // → 12 复活。点五次 × 五次都「成功了」关联还在，比丢一条关联更伤信任。
    // 而「两个键同时存在」只可能来自手写：render_markdown 整份重写 front-matter，
    // 新代码保存过一次的文件里就没有 record_id 这一行了。
    if !saw_multi {
        if let Some(id) = legacy_single {
            doc.record_ids.push(id);
        }
    } else if legacy_single.is_some() {
        // 数据矛盾要留痕（§8.5）：只写路径与结论，不写正文。
        eprintln!("笔记 front-matter 同时含 record_ids 与 record_id，以 record_ids 为准");
    }
    sort_dedup_ids(&mut doc.record_ids);
    // 兼容投影：供 v1.1 前端（回滚场景）继续读到「第一条关联」（最小 id）。
    doc.record_id = doc.record_ids.first().copied();

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
///
/// ⚠️ **整份覆盖**：`render_markdown` 从 `doc` 重建全部 front-matter，
/// 所以 `doc.record_ids` 必须由调用方传全。漏传（传空 vec）等于把关联清空，
/// 文件里 `record_ids` 行消失，而界面上什么都不报 —— 这是本轮最容易翻车的一条。
/// 需要「清空关联」时走 `notes_set_records([])`，不要靠漏传。
#[tauri::command]
pub async fn notes_write(data_file_path: String, mut doc: NoteDoc) -> Result<NoteDoc, String> {
    // 写入前收口：文件里的 record_ids 永远是「正整数、升序、去重」。
    sort_dedup_ids(&mut doc.record_ids);
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
    // 返回值的 record_id 是 record_ids 的兼容投影（最小 id），与 parse_markdown 一致。
    saved.record_id = saved.record_ids.first().copied();
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
    // 关联一律走 record_ids，规则与 title 相同：**非空才覆盖**。
    // 空 Vec 表示「调用方不想改关联」，不是「清空关联」——清空必须走 notes_set_records([])。
    // 旧字段 record_id 在这里被忽略：它的语义已被 add/remove 覆盖，
    // 且 Option<i64> 区分不了「没传」和「要清空」（§8.7 第 3 条）。
    if !doc.record_ids.is_empty() {
        parsed.record_ids = doc.record_ids.clone();
        sort_dedup_ids(&mut parsed.record_ids);
    }
    parsed.rel_path = rel_path;

    notes_write(data_file_path, parsed).await
}

/// 读文件 → 解析 → 改 record_ids → 写回。三个关联命令的唯一内部入口。
///
/// 为什么必须共用一个实现：三份「读—改—写」分叉之后，总有一份会忘掉
/// `retain(>0) + sort + dedup`，然后全量同步把脏 id 带进 `note_record`。
///
/// 终点是 `notes_write` → `render_markdown` → 写文件：关联的真相永远在 `.md` 里，
/// `note_record` 只是可随时重建的派生表。
async fn mutate_records<F>(
    data_file_path: &str,
    rel_path: &str,
    f: F,
) -> Result<NoteDoc, String>
where
    F: FnOnce(&mut Vec<i64>),
{
    if rel_path.trim().is_empty() {
        return Err("笔记路径为空".to_string());
    }
    let root = notes_root(data_file_path);
    // safe_join 负责「含 .. / 越出笔记根」的校验，错误信息原样上抛
    let existing = safe_join(&root, rel_path)?;
    let text = fs::read_to_string(&existing)
        .map_err(|e| format!("读取笔记失败 {}: {}", rel_path, e))?;
    let file_name = existing
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut parsed = parse_markdown(&text, &title_from_file_name(&file_name));
    let mut ids = parsed.record_ids.clone();
    f(&mut ids);
    sort_dedup_ids(&mut ids);
    parsed.record_ids = ids;
    parsed.rel_path = rel_path.to_string();

    notes_write(data_file_path.to_string(), parsed).await
}

/// 给笔记追加一条关联。**幂等**：已存在则原样返回，不报错、不重复写。
///
/// 不校验 record 是否存在：记录可能已被删（R06 要求保留悬空 id 并显示灰色占位），
/// 把校验放在这里会让「先删记录、后挂笔记」这种操作直接失败。
#[tauri::command]
pub async fn notes_add_record(
    data_file_path: String,
    rel_path: String,
    record_id: i64,
) -> Result<NoteDoc, String> {
    if record_id <= 0 {
        return Err(format!("record_id 非法: {}", record_id));
    }
    mutate_records(&data_file_path, &rel_path, move |ids| ids.push(record_id)).await
}

/// 解除一条关联。**幂等**：本来就没有则原样返回。
///
/// 只改 front-matter，**永远不删笔记文件**（文件是独立存在的，解除只是少一行元数据）。
#[tauri::command]
pub async fn notes_remove_record(
    data_file_path: String,
    rel_path: String,
    record_id: i64,
) -> Result<NoteDoc, String> {
    mutate_records(&data_file_path, &rel_path, move |ids| {
        ids.retain(|id| *id != record_id)
    })
    .await
}

/// 整组替换。空数组 = 显式清空（这是**唯一**能把关联清成 0 的入口）。
#[tauri::command]
pub async fn notes_set_records(
    data_file_path: String,
    rel_path: String,
    record_ids: Vec<i64>,
) -> Result<NoteDoc, String> {
    mutate_records(&data_file_path, &rel_path, move |ids| {
        ids.clear();
        ids.extend(record_ids);
    })
    .await
}

/// 【保留，语义收窄】设置或解除**单值**关联。
///
/// v1.1 的两个调用点（notesStore.setNoteRecord → 抽屉的挂上 / 解除）继续可用：
/// `Some(id)` 等价于 `notes_set_records([id])`，`None` 等价于 `notes_set_records([])`。
/// 新代码不要用它 —— 它会把已有的其它关联一起清掉，那正是 R01 要消灭的语义。
#[tauri::command]
pub async fn notes_set_record(
    data_file_path: String,
    rel_path: String,
    record_id: Option<i64>,
) -> Result<NoteDoc, String> {
    if let Some(id) = record_id {
        if id <= 0 {
            return Err(format!("record_id 非法: {}", id));
        }
    }
    mutate_records(&data_file_path, &rel_path, move |ids| {
        ids.clear();
        if let Some(id) = record_id {
            ids.push(id);
        }
    })
    .await
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
                // 旧 notes 表没有「挂在哪一行」的概念，迁移过来的笔记一律是独立笔记
                record_ids: Vec::new(),
                record_id: None,
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
    // 关联命令是 async（Tauri 命令签名），单测里用 tauri 自带的运行时驱动，
    // 不为测试单独引一个 executor 依赖。
    use tauri::async_runtime::block_on;

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
            // 多值关联：写 → 读 必须相等（逗号串格式的核心保证）
            record_ids: vec![12, 13],
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
        // 断言必须带冒号：`"record_ids:"` 本身包含 `"record_id"` 子串，
        // 少了冒号这条断言永远为假。
        assert!(
            !text.contains("record_id:"),
            "render_markdown 不许再输出 record_id 行：\n{}",
            text
        );
        assert!(text.contains("record_ids: 12,13"), "关联没写成逗号串：\n{}", text);

        let parsed = parse_markdown(&text, "fallback");

        assert_eq!(parsed.id, Some(7));
        assert_eq!(parsed.record_ids, vec![12, 13]);
        // 兼容投影：v1.1 前端还能读到第一条
        assert_eq!(parsed.record_id, Some(12));
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

    // QA #1「旧文件无需手工迁移」的单元级判据：只含 record_id 的文件照样读出关联。
    #[test]
    fn legacy_record_id_merges_into_record_ids() {
        let parsed = parse_markdown("---\nrecord_id: 12\ntitle: T\n---\n", "回退");
        assert_eq!(parsed.record_ids, vec![12], "旧单值没并进 record_ids");
        assert_eq!(parsed.record_id, Some(12));
    }

    // 两个键同时存在：record_ids 赢，不求并集（求并集 → 删不掉的关联会「复活」）。
    // 两个顺序都要测 —— 这正是必须有「两段式裁决」的原因：
    // 边读边定的话，record_id 在前的那份文件会先写进 doc，再被 record_ids 覆盖，
    // 看起来对；但换成「只有 record_id」时就分不清了。顺序反过来才会暴露真问题。
    #[test]
    fn record_ids_wins_over_record_id() {
        let after = parse_markdown("---\nrecord_ids: 13\nrecord_id: 12\ntitle: T\n---\n", "回退");
        assert_eq!(after.record_ids, vec![13], "record_id 在后时仍不许并进来");

        let before = parse_markdown("---\nrecord_id: 12\nrecord_ids: 13\ntitle: T\n---\n", "回退");
        assert_eq!(before.record_ids, vec![13], "record_id 在前时也不许并进来");
        assert_eq!(before.record_id, Some(13), "兼容投影应取 record_ids 的第一条");
    }

    #[test]
    fn parse_id_list_tolerates_junk() {
        assert_eq!(parse_id_list("12, 13"), vec![12, 13]);
        assert_eq!(parse_id_list("[12,13]"), vec![12, 13]);
        assert_eq!(parse_id_list("[12, 13]"), vec![12, 13]);
        assert_eq!(parse_id_list(" 12 "), vec![12]);
        // 手写脏值：非数字片段、负数、0 全部丢弃，剩下的照常生效
        assert_eq!(parse_id_list("12,待定,-3,0"), vec![12]);
        assert_eq!(parse_id_list(""), Vec::<i64>::new());
    }

    // 三个命令的行为契约：幂等 + 清空是唯一入口 + 清空后文件里不留空行。
    // 走真文件：这些命令的终点是 fs::write，用假对象测不出「文件里到底写了什么」。
    #[test]
    fn add_remove_set_are_idempotent() {
        let tmp = std::env::temp_dir().join("wr-note-record-mutate");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("创建临时目录失败");

        let data_file = tmp.join("t.json").to_string_lossy().to_string();
        let root = notes_root(&data_file);
        let dir = root.join(DEFAULT_TAG);
        fs::create_dir_all(&dir).expect("创建分类目录失败");

        let rel = format!("{}/2026-09-20-关联探针.md", DEFAULT_TAG);
        let abs = root.join(&rel);
        fs::write(
            &abs,
            "---\nid: 3\nrecord_ids: 5\ntitle: 关联探针\ntag: 未分类\n\
             created_at: 2026-09-20 10:00:00\nupdated_at: 2026-09-20 10:00:00\n---\n\n正文\n",
        )
        .expect("写探针笔记失败");

        // add：并集里加一个，且升序
        let added = block_on(notes_add_record(data_file.clone(), rel.clone(), 12)).expect("add 失败");
        assert_eq!(added.record_ids, vec![5, 12]);
        assert_eq!(added.record_id, Some(5), "兼容投影应是最小 id");
        let text = fs::read_to_string(&abs).unwrap();
        assert!(text.contains("record_ids: 5,12"), "文件内容不对：\n{}", text);

        // add 幂等：再来一次还是一条，文件里不会出现第二行 record_ids
        let again = block_on(notes_add_record(data_file.clone(), rel.clone(), 12)).expect("add 重入失败");
        assert_eq!(again.record_ids, vec![5, 12], "add 不幂等");
        let text = fs::read_to_string(&abs).unwrap();
        assert_eq!(
            text.matches("record_ids:").count(),
            1,
            "重复写入了 record_ids 行：\n{}",
            text
        );

        // remove 一条不存在的：原样返回，不报错
        let same = block_on(notes_remove_record(data_file.clone(), rel.clone(), 999)).expect("remove 不存在的失败");
        assert_eq!(same.record_ids, vec![5, 12], "remove 不存在的却改了集合");

        // remove 一条存在的
        let removed = block_on(notes_remove_record(data_file.clone(), rel.clone(), 5)).expect("remove 失败");
        assert_eq!(removed.record_ids, vec![12]);

        // set([]) 是唯一的清空入口：集合清空 + 文件里整行消失
        let cleared = block_on(notes_set_records(data_file.clone(), rel.clone(), Vec::new())).expect("set([]) 失败");
        assert!(cleared.record_ids.is_empty(), "set([]) 没清空");
        assert_eq!(cleared.record_id, None, "清空后兼容投影应为 None");
        let text = fs::read_to_string(&abs).unwrap();
        assert!(
            !text.contains("record_ids:"),
            "清空后文件里不许留 record_ids 行：\n{}",
            text
        );

        // set([id]) 是单值别名（notes_set_record 收窄后的语义）
        let single = block_on(notes_set_record(data_file.clone(), rel.clone(), Some(21))).expect("set_record 失败");
        assert_eq!(single.record_ids, vec![21]);

        let _ = fs::remove_dir_all(&tmp);
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

