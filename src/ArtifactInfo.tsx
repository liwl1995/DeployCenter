import { FileArchive } from 'lucide-react';
import { fmtTime, type Artifact, type ServiceSnapshot } from './model';
import { OldArtifactWarning } from './OldArtifactWarning';
import { Badge } from './ui';

export function niceSize(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

export function ArtifactInfo({ value, service }: { value: Artifact; service?: ServiceSnapshot }) {
  return (
    <div className="artifact">
      <div className="row spread">
        <span className="row">
          <FileArchive size={16} />
          <strong>{value.name}</strong>
        </span>
        <Badge kind={value.exists ? 'good' : 'danger'}>
          {value.source === 'sample'
            ? '示例文件信息'
            : value.exists
              ? '文件已读取'
              : value.source === 'file'
                ? '文件不存在或无法读取'
                : '尚未检测'}
        </Badge>
      </div>
      <p className="path">{value.path}</p>
      <div className="metadata">
        <span>
          大小：{value.source === 'unknown' ? '待检测' : !value.exists ? '—' : niceSize(value.size)}
        </span>
        <span>
          修改：
          {value.source === 'unknown' ? '待检测' : !value.exists ? '—' : fmtTime(value.modified)}
        </span>
      </div>
      {service && <OldArtifactWarning value={value} service={service} />}
    </div>
  );
}
