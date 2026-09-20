/// Tauri 构建脚本。
///
/// 关键：`tauri_build::build()` 只跟踪 capabilities / permissions 等目录，
/// **不会**跟踪 `frontendDist` 指向的前端目录。
///
/// 而 Cargo 的规则是：`build.rs` 若没有发出 `rerun-if-changed`，
/// 就只在自身或依赖变化时重新运行。结果是——改了 `../src/` 下的任何
/// 前端文件（.js / .html / .css），`build.rs` 不重跑，嵌入资源不更新，
/// 构建出来的 exe 里仍是旧前端。表现为「改了代码完全没反应」，
/// 而且没有任何报错，极难排查。
///
/// 这里显式声明对前端目录的依赖，保证任何前端改动都会触发重新嵌入。
fn main() {
    tauri_build::build();

    // 递归监听前端资源目录（tauri.conf.json 的 frontendDist = "../src"）
    watch_dir(std::path::Path::new("../src"));
}

/// 递归遍历目录，为每个文件与子目录发出 rerun-if-changed。
///
/// Cargo 只对「被点名的文件」和「被点名目录的直接子项」敏感，
/// 更深层级需要单独声明，所以这里手动递归。
fn watch_dir(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        println!("cargo:rerun-if-changed={}", path.display());
        if path.is_dir() {
            watch_dir(&path);
        }
    }
}
