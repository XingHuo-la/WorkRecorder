// ==========================================
// 前端日志上报
//
// GUI 应用没有控制台，出问题时前端异常看不见。
// 这里把关键日志与未捕获异常写到数据目录下的
// work_recorder_frontend.log，方便排查线上问题。
//
// 设计取舍：不做缓冲、不做批量冲刷。
// 缓冲看着优雅，但一旦初始化中途崩溃，恰好把最该留下的
// 启动日志全丢了（这个坑踩过一次）。日志量级很小，
// 每条直接写盘最可靠。
// ==========================================

let invokeFn = null;
let warnedNoInvoke = false;

function resolveInvoke() {
  if (invokeFn) return invokeFn;
  try {
    invokeFn = window.__TAURI__?.core?.invoke || null;
  } catch (error) {
    invokeFn = null;
  }
  return invokeFn;
}

/** 把任意值转成可读文本。 */
function toText(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

/**
 * 写一条日志到文件。
 *
 * 任何失败都静默降级为控制台输出，绝不让日志本身把应用搞崩。
 */
export function logToFile(level, message) {
  const text = toText(message);

  // 控制台保留一份，开发时可直接看
  const consoleFn = level === 'error' ? console.error : (level === 'warn' ? console.warn : console.log);
  try {
    consoleFn(`[${level}] ${text}`);
  } catch (error) {
    // 忽略控制台异常
  }

  const invoke = resolveInvoke();
  if (!invoke) {
    if (!warnedNoInvoke) {
      warnedNoInvoke = true;
      // 这里只打一次，避免刷屏
      try { console.warn('[logger] Tauri invoke 尚不可用，日志暂存于控制台'); } catch (e) {}
    }
    return;
  }

  try {
    // 不 await：日志不需要阻塞调用方，失败也没人在意
    Promise.resolve(invoke('log_frontend', { level, message: text })).catch(() => {});
  } catch (error) {
    // 忽略
  }
}

/**
 * 装上全局错误捕获。尽早调用。
 *
 * 注意不要改写 console 方法：ES module 是严格模式，
 * 在部分 WebView 上给 console.error 赋值会直接抛错，
 * 反而把日志模块自己搞崩。
 */
export function installGlobalErrorHandlers() {
  window.addEventListener('error', event => {
    const where = event.filename
      ? `${event.filename}:${event.lineno}:${event.colno}`
      : 'unknown';
    logToFile('error', `未捕获错误 @ ${where} :: ${event.message}`);
    if (event.error?.stack) {
      logToFile('error', `stack: ${event.error.stack}`);
    }
  });

  window.addEventListener('unhandledrejection', event => {
    logToFile('error', `未处理的 Promise 拒绝 :: ${toText(event.reason)}`);
  });
}

/** 保留接口以兼容既有调用方；当前实现无需就绪切换。 */
export function markLogReady() {
  // 日志已改为直写，无需冲刷缓冲区
}

// 模块加载即装上捕获器，尽量早
installGlobalErrorHandlers();
