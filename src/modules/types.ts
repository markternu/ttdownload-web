import type { ModuleId, Task, TaskStatus } from '../types';

export type TaskWithPayload = Task & { payload?: Record<string, unknown>; retryCount?: number };

export interface PollResult {
  status?: TaskStatus;
  progress?: number;
  speedBps?: number;
  etaSec?: number | null;
  totalBytes?: number;
  downloadedBytes?: number;
  expectBytes?: number;
  error?: string | null;
  /**
   * 下载完成，交给归档流水线。
   * units：发布单元（一个单元 = 一个成品）。BT 里"多个大视频"会拆成多个单元，
   *        这样不会被塞进同一个 zip；"一堆小文件"合成一个单元（打成 zip）。
   *        不传则按"全部文件一个单元"处理（保持旧行为）。
   */
  done?: {
    files: string[];
    originalName: string;
    sizeBytes: number;
    units?: { files: string[]; name: string }[];
    /** BT：种子名，用于发布完成后清理下载目录 */
    torrentName?: string;
    /** 发布完成后是否清理 BT 下载/incomplete 目录 */
    cleanupBtDirs?: boolean;
  };
}

export interface ModuleAdapter {
  readonly id: ModuleId;
  /** 生产者：把外部来源（上传的 zip、待处理种子等）转成任务 */
  produce?(): Promise<void>;
  /** 准备：解析元数据、确定 expectBytes（可能较慢） */
  prepare?(task: TaskWithPayload): Promise<void>;
  /** 开始下载（调度器已确认并发与磁盘空间） */
  start(task: TaskWithPayload): Promise<void>;
  /** 轮询进度；返回 done 表示下载完成，需要归档 */
  poll(task: TaskWithPayload): Promise<PollResult>;
  pause(task: TaskWithPayload): Promise<void>;
  resume(task: TaskWithPayload): Promise<void>;
  cancel(task: TaskWithPayload): Promise<void>;
}

export interface RunResult {
  ok: boolean;
  output?: string;
  error?: string;
}
