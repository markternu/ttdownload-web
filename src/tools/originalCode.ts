/**
 * 打印「下载原始文件」当前有效的 6 位密码（供 deploy.sh --orig-code 调用）。
 *
 * 只依赖 services/originalCode.ts —— **不打开数据库、不启动服务**，root 或普通用户都能跑。
 * 需要 .env：默认读当前工作目录下的 .env（和主程序一致），可用 ENV_FILE 指定。
 */
import '../core/config';   // 副作用：加载 .env（dotenv.config）
import { CODE_WINDOW_MS, currentCode, originalDownloadEnabled, secondsLeftInWindow } from '../services/originalCode';

const enabled = originalDownloadEnabled();
if (!enabled) {
  console.log('「下载原始文件」未启用：.env 里没有 ORIGINAL_DL_SECRET（至少 16 位）。');
  console.log('生成一个：  echo "ORIGINAL_DL_SECRET=$(openssl rand -hex 24)" >> .env && sudo systemctl restart ttdownload-web');
  process.exit(1);
}

const code = currentCode();
const left = secondsLeftInWindow();
console.log('');
console.log(`  当前下载密码：\x1b[1;36m${code}\x1b[0m`);
console.log(`  有效剩余    ：${left} 秒（每 ${CODE_WINDOW_MS / 60000} 分钟自动换一次）`);
if (left <= 30) {
  console.log('  ⚠️  快换号了：建议等几秒拿到下一个再输入。');
}
console.log('');
console.log('  在网页「文件」页点「下载原始文件」时输入这 6 位数字；');
console.log('  输对之后 15 分钟内不再询问。');
console.log('');
