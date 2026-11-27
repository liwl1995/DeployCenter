import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Button } from './design/ui/button';
import { Modal } from './ui';
import type { WorkspacePage } from './workspace-model';
import build from './tutorial/build.png';
import server from './tutorial/server.png';
import service from './tutorial/service.png';
import target from './tutorial/target.png';
import deploy from './tutorial/deploy.png';

const lessons = [
  {
    title: '配置构建环境',
    image: build,
    imageHeight: 186,
    alt: '构建环境页面，标出添加 JDK 按钮',
    instructions: [
      '在「构建环境」点击「添加 JDK」，选择项目需要的完整 JDK 安装目录。',
      'Maven 在服务的构建配置中选择。项目有 Maven Wrapper 时可以优先使用它。',
    ],
    page: 'tools',
    action: '去构建环境',
  },
  {
    title: '添加服务器',
    image: server,
    imageHeight: 233,
    alt: '服务器列表，标出添加服务器和测试连接按钮',
    instructions: [
      '在「服务器」点击「添加服务器」，填写主机、端口和登录方式。',
      '保存后点击「测试连接」。首次连接时，先向管理员核对 SSH 主机指纹，再确认信任。',
    ],
    page: 'servers',
    action: '去服务器',
  },
  {
    title: '添加服务',
    image: service,
    imageHeight: 220,
    alt: '服务管理列表，标出添加服务按钮',
    instructions: [
      '在「服务管理」点击「添加服务」，填写服务名称和本机项目目录。',
      '选择项目所需的 JDK 和 Maven，填写构建产物的 JAR 目录与文件名。',
    ],
    page: 'services',
    action: '去服务管理',
  },
  {
    title: '添加部署目标',
    image: target,
    imageHeight: 160,
    alt: '服务工作台，标出添加部署目标按钮',
    instructions: [
      '在「部署目标」选择服务，点击「添加部署目标」，关联服务器并填写远端部署目录。',
      '按目标实际运行方式选择普通 JAR 或 Docker JAR，再配置启停和健康检查。',
    ],
    page: 'targets',
    action: '去部署目标',
  },
  {
    title: '完成第一次部署',
    image: deploy,
    imageHeight: 76,
    alt: '服务工作台底部，标出试运行和部署按钮',
    instructions: [
      '选择「重新构建」或「使用现有 JAR」，勾选目标后先点击「试运行（远程只读）」核对环境。',
      '试运行通过后，核对目标和备份选择，再发起部署。正式环境需要输入目标名称确认。',
    ],
    page: 'deploy',
    action: '去部署工作台',
  },
] as const;

export function TutorialGuide({
  onClose, onNavigate,
}: {
  onClose: () => void;
  onNavigate: (page: WorkspacePage) => void;
}) {
  const [index, setIndex] = useState(0);
  const last = index === lessons.length - 1;
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    heading.current?.scrollIntoView?.({ block: 'nearest' });
  }, [index]);

  return (
    <Modal title="教学向导" onClose={onClose} wide footer={
      <div className="tutorial-actions">
        <Button variant="ghost" onClick={onClose}>跳过</Button>
        <div className="tutorial-navigation">
          <Button variant="neutral" disabled={!index} onClick={() => setIndex(index - 1)}>
            <ArrowLeft size={16} />上一步
          </Button>
          <Button data-autofocus onClick={() => last ? onClose() : setIndex(index + 1)}>
            {last ? '完成' : '下一步'}{!last && <ArrowRight size={16} />}
          </Button>
        </div>
      </div>
    }>
      <div className="tutorial-pages">
        <p className="compact-visually-hidden" aria-live="polite">第 {index + 1} 步：{lessons[index].title}</p>
        {lessons.map((lesson, step) => {
          const active = step === index;
          return (
            <section key={lesson.title} className="tutorial-lesson" aria-hidden={!active} inert={!active}>
              <div ref={active ? heading : undefined}>
                <p className="muted">第 {step + 1} 步 / 共 {lessons.length} 步</p>
                <h3>{lesson.title}</h3>
              </div>
              <img className="tutorial-image" src={lesson.image} alt={lesson.alt} width={778} height={lesson.imageHeight} />
              <ol>
                {lesson.instructions.map((instruction) => <li key={instruction}>{instruction}</li>)}
              </ol>
              <Button className="tutorial-link" variant="link" disabled={!active} onClick={() => onNavigate(lesson.page)}>
                {lesson.action}<ArrowRight size={16} />
              </Button>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
