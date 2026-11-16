import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { allowedProjectLink } from './update-links';

/** 更新说明为不可信内容：不渲染原始 HTML 或远端图片，链接只交给受限的桌面接口。 */
function ReleaseNotes({ notes, onLink }: { notes: string; onLink?: (url: string) => void }) {
  return (
    <div className="update-notes" aria-label="更新说明">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) =>
            href && allowedProjectLink(href) && onLink ? (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  onLink(href);
                }}
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => <span className="muted">{alt || '图片已省略'}</span>,
        }}
      >
        {notes || '该版本未提供更新说明。'}
      </Markdown>
    </div>
  );
}

// 下载进度持续刷新时，不重复解析相同的远程 Markdown。
export const UpdateNotes = memo(ReleaseNotes);
