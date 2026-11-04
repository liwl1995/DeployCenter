from pathlib import Path
import hashlib
import zipfile
import argparse
import json

# 交付包只收录源码、测试、构建产物及必要配置，不包含依赖、安装输出或测试数据。
ROOT = Path(__file__).resolve().parent.parent
DIRECTORIES = ('src', 'electron', 'tests', 'smoke', 'scripts', 'installer', 'assets', 'dist', 'dist-electron', 'docs')
FILES = ('package.json', 'package-lock.json', 'README.md', 'index.html', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts', '.gitignore', '.prettierrc.json')

def package(output: Path):
    entries = [ROOT / name for name in FILES]
    for name in DIRECTORIES:
        entries.extend(p for p in (ROOT / name).rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    entries.sort(key=lambda p: p.relative_to(ROOT).as_posix())
    manifest = ''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.relative_to(ROOT).as_posix() + '\n' for p in entries)
    (ROOT / 'SHA256SUMS').write_text(manifest, encoding='utf-8')
    output.parent.mkdir(parents=True, exist_ok=True)
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
    prefix = f'YOTOO部署中心-{version}-source/'
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for p in entries:
            archive.write(p, prefix + p.relative_to(ROOT).as_posix())
        archive.write(ROOT / 'SHA256SUMS', prefix + 'SHA256SUMS')
    # 校验压缩完整性与逐文件哈希，避免交付时源码或构建产物遗漏。
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None, 'ZIP CRC 校验失败'
        for line in manifest.splitlines():
            digest, name = line.split('  ', 1)
            assert hashlib.sha256(archive.read(prefix + name)).hexdigest() == digest, name
        assert not any('/node_modules/' in name or '/.test-data/' in name for name in archive.namelist())
    print(f'{output}: {len(entries)} files, SHA-256 and ZIP CRC passed')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='生成 YOTOO 部署中心完整源码压缩包')
    parser.add_argument('--output', required=True, type=Path)
    package(parser.parse_args().output)
