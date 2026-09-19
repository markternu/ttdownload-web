import { Router } from 'express';
import { asyncHandler } from '../utils/http';
import { autoMount, ejectUsb, getCachedUsbState, getUsbState } from '../services/usbMount';

export const usbRouter = Router();

/** 当前外部存储（U 盘/移动硬盘）状态 —— 前端每几秒轮询一次实现"实时"显示 */
usbRouter.get('/usb', asyncHandler(async (_req, res) => {
  res.json({ usb: getCachedUsbState() });
}));

/** 手动触发一次检测 + 自动挂载 */
usbRouter.post('/usb/mount', asyncHandler(async (_req, res) => {
  res.json({ usb: autoMount() });
}));

/** 弹出（sync + umount /mnt/usb） */
usbRouter.post('/usb/eject', asyncHandler(async (_req, res) => {
  res.json({ usb: ejectUsb() });
}));

/** 立即扫描一次（挂载状态下把归档成品剪切到外部盘） */
usbRouter.post('/usb/sync', asyncHandler(async (_req, res) => {
  res.json({ usb: getUsbState() });
}));
