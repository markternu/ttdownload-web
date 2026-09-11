import { clsx, type ClassValue } from 'clsx'

/** 合并 className（clsx 的薄封装，统一全站调用点） */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}
