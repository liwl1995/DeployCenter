import { useEffect, useState } from 'react';
/** 静默期给出真实的最后接收时间，提示不写入完整日志或历史。 */
export function LogActivity({ received }: { received: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - received) / 1000));
  return (
    <p className="log-activity">
      {elapsed < 3
        ? '刚刚收到输出'
        : '最近输出 ' + elapsed + ' 秒前 · 正在等待下一条输出，任务仍在执行'}
    </p>
  );
}
