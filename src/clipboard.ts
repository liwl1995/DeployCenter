/** 桌面端通过受限 IPC 写入系统剪贴板；失败只报错，复制不会变成文件下载。 */
export async function copyText(value: string) {
  try {
    if (window.deployCenter) await window.deployCenter.copyText(value);
    else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else throw new Error('剪贴板不可用');
  } catch {
    throw new Error('复制失败，请稍后重试。可先选中文字后按 Ctrl+C 复制。');
  }
}
