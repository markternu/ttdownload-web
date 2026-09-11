import { EventEmitter } from 'node:events';

/** 进程内事件总线：任务/统计/文件/日志变化推送给 SSE */
class Bus extends EventEmitter {
  emitTask(task: unknown): void {
    this.emit('task', task);
  }
  emitStats(stats: unknown): void {
    this.emit('stats', stats);
  }
  emitFile(payload: unknown): void {
    this.emit('file', payload);
  }
  /** 空间腾挪广播：只要有空间被释放就通知（等待队列/前端都会收到） */
  emitSpaceFreed(payload: { bytes: number; reason: string; at?: string; detail?: unknown }): void {
    this.emit('space-freed', { at: new Date().toISOString(), ...payload });
  }
}

export const bus = new Bus();
bus.setMaxListeners(200);
