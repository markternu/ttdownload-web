import { Link } from 'react-router-dom'
import { Compass } from 'lucide-react'
import { Button, Card } from '../components/ui'

export default function NotFoundPage() {
  return (
    <Card className="mx-auto max-w-lg text-center">
      <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-300">
        <Compass className="h-6 w-6" />
      </span>
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">页面不存在</h2>
      <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
        你访问的地址没有对应的页面，可能链接已失效或输入有误。
      </p>
      <div className="mt-4 flex justify-center gap-2">
        <Link to="/">
          <Button>返回首页</Button>
        </Link>
        <Link to="/tasks">
          <Button variant="outline">查看任务</Button>
        </Link>
      </div>
    </Card>
  )
}
