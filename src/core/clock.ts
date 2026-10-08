/**
 * 统一时间源 —— 「墙上时钟」和「单调时钟」**分开**用，别再混着算时长。
 *
 * ============================ 真机事故（必读） ============================
 * 现象：树莓派上 BT 任务明明只下了几个小时，**断电重启后页面显示「已下载 140 多小时」**，
 *       随后被「超时清理」拉走（用户报的 bug）。
 *
 * 根因：那时候"已下载尝试时长"是拿 **墙上时钟差值** 算的：
 *          ageHours = (Date.now() - Date.parse(payload.btHandedAt)) / 3600e3
 *       两个致命点：
 *         1. `Date.now()` 是墙上时钟。**关机/断电那段时间也被算成"在下载"** ——
 *            机器停了 6 天，任务就"凭空"多出 144 小时；
 *         2. 树莓派**没有 RTC**（没有纽扣电池）。断电重启后系统时间要等 NTP 校准，
 *            校准前 `Date.now()` 可能是几天前（甚至 1970），一校准就"跳"一大步；
 *            反向（校时往回调）还会算出负数。任何用墙上时钟做减法的时长都不可信。
 *
 * 规矩（以后新功能照这个来，别再犯）：
 *   1. 「花了多久 / 过了多久」→ 一律用 `monoMs()`（process.hrtime，单调递增，
 *      不受 settimeofday/NTP 校准影响，也不会因为用户改系统时间而跳变）；
 *   2. 「记录某个时刻 / 展示给用户看」→ 用 `nowIso()`（墙上时钟，人能读）；
 *   3. **跨进程重启、断电停机期间的时长，不要算进"实际运行了多久"** ——
 *      服务都没在跑，任务当然没在下载。需要跨重启累计时，把 `monoMs()` 的**增量**
 *      累加后落库（见 services/btEvict.ts 的 `btActiveMs`），而不是回填墙上时钟差值。
 * ==========================================================================
 */

/** 墙上时钟（毫秒）—— 只用于"记录时刻"和展示，**不要**用它做时长减法。 */
export function nowMs(): number {
  return Date.now() + wallOffsetMs;
}

/** 墙上时钟 ISO 串（落库/展示用）。 */
export function nowIso(): string {
  return new Date(nowMs()).toISOString();
}

/**
 * 单调时钟（毫秒）—— 只用于"算时长"。
 *
 * `process.hrtime.bigint()` 底层是 `CLOCK_MONOTONIC`：从开机起单调递增，
 * 不受 NTP 校时、用户改时间、时区变更影响（Linux 上也不计系统挂起的时间）。
 * ⚠️ 它的"零点"每次进程重启（严格说是每次开机）都会重置 —— 所以**绝对不能**
 *    把它的绝对值落库或跨进程比较，只能在同一进程内做差。
 */
export function monoMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n) + monoOffsetMs;
}

/** 把毫秒差格式化成"x.x 小时"（日志/文案统一口径）。 */
export function hours(ms: number): number {
  return ms / 3_600_000;
}

/* ------------------------------------------------------------------ *
 * 仅供测试：模拟"系统时钟被 NTP 校准"与"单调时钟走了很久"。
 * 生产代码永远不要调用（grep 一下就这两个调用点，都在 test/ 里）。
 * ------------------------------------------------------------------ */
let wallOffsetMs = 0;
let monoOffsetMs = 0;

/** @internal 测试专用：把墙上时钟整体平移（模拟断电重启后 NTP 校时）。 */
export function __testSetWallClockOffset(ms: number): void {
  wallOffsetMs = ms;
}

/** @internal 测试专用：把单调时钟整体平移（模拟"服务又跑了 N 毫秒"）。 */
export function __testSetMonoClockOffset(ms: number): void {
  monoOffsetMs = ms;
}

/** @internal 测试专用：复位两个偏移，避免用例之间互相影响。 */
export function __testResetClockOffsets(): void {
  wallOffsetMs = 0;
  monoOffsetMs = 0;
}
