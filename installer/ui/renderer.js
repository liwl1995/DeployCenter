// 页面结构、令牌和动效来自已确认的安装器原型，运行状态由 NSIS 提供。
const V = {};
const state = {
  flow: 'fresh', step: 'welcome', theme: 'system', installPath: '',
  downgradeAck: false, desktopShortcut: true, removeData: false, launchAfter: true,
  progress: 0, indeterminate: false, eta: null, result: {}, failure: {},
};
const el = Object.fromEntries(['body', 'foot', 'wintitle'].map((id) => [id, document.getElementById(id)]));
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const ICON = {
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12.5 5.5 5.5L20 6.5"/></svg>',
  checkBig: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12.5 5.5 5.5L20 6.5"/></svg>',
  warn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 22 20H2L12 3.5Z"/><path d="M12 9.5v5"/><path d="M12 17.6v.1"/></svg>',
  alert: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.4v.1"/></svg>',
  car: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>',
  disk: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  folder: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v7.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z"/></svg>',
};

const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
const find = id => document.getElementById(id);
const driveOf = value => {
  const normalized = value.trim();
  return /^[a-z]:\\[^\\/]/i.test(normalized) ? normalized.slice(0, 2).toUpperCase() : '';
};
const currentInstallPath = () => V.chooseDirectory ? state.installPath.trim() : V.installPath;
const hasPrevious = () => state.flow !== 'fresh' && state.flow !== 'uninstall';

function stagesOf() {
  if (state.flow === 'uninstall') return [
    { key: 'verify', label: '检查卸载条件', to: 12 },
    { key: 'write', label: '移除程序与快捷方式', to: 70 },
    { key: 'data', label: state.removeData ? '删除用户数据' : '保留用户数据', to: 94 },
    { key: 'finish', label: '核验卸载结果', to: 100 },
  ];
  return [
    { key: 'prepare', label: '检查安装条件', to: 8 },
    { key: 'extract', label: '解压程序文件', to: 68 },
    { key: 'verify', label: '校验新版程序', to: 76 },
    ...(hasPrevious() ? [{ key: 'backup', label: '备份当前版本', to: 82 }] : []),
    { key: 'write', label: '写入程序与快捷方式', to: 94 },
    { key: 'finish', label: '核验安装结果', to: 100 },
  ];
}

function renderChromeIcons() {
  document.getElementById('ctl-min').innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg>';
  document.getElementById('ctl-max').innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
  document.getElementById('ctl-close').innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1"/></svg>';
}

function foot(buttons) {
  return buttons
    .map((b) => {
      if (b.spacer) return '<span class="spacer"></span>';
      const cls = 'btn' + (b.kind ? ' ' + b.kind : '');
      return `<button class="${cls}" data-act="${b.act}"${b.disabled ? ' disabled' : ''}>${b.label}</button>`;
    })
    .join('');
}

/* ---------- 欢迎页 ---------- */
function pageWelcome() {
  const isUpgrade = state.flow === 'upgrade';
  const isRepair = state.flow === 'repair';
  const isDowngrade = state.flow === 'downgrade';
  const isExisting = hasPrevious();

  const title = isDowngrade
    ? '降级安装 YOTOO 部署中心'
    : isRepair
      ? '修复安装 YOTOO 部署中心'
      : isUpgrade
        ? '升级 YOTOO 部署中心'
        : isExisting ? '覆盖安装 YOTOO 部署中心' : '安装 YOTOO 部署中心';

  const meta = isExisting ? V.arch : `v${escapeHtml(V.to)} · ${V.arch} · 全新安装`;

  let notice = '';
  if (isDowngrade) {
    notice = `
      <div class="notice danger">
        <div class="nhead">${ICON.warn}检测到已安装 <span class="nver">v${escapeHtml(V.from)}</span>，将降级到 <span class="nver">v${escapeHtml(V.to)}</span></div>
        <div class="nbody">降级可能丢失新版本写入的配置项，或在读取旧数据时出现不兼容。配置、部署历史和日志本身不会被删除。</div>
      </div>
      <label class="confirm-row">
        <input type="checkbox" id="ack"${state.downgradeAck ? ' checked' : ''} />
        <span>我了解降级的影响，仍然继续。</span>
      </label>`;
  } else if (isRepair) {
    notice = `
      <div class="notice neutral">
        <div class="nhead">检测到已安装 <span class="nver">v${escapeHtml(V.to)}</span>，与将要安装的版本相同</div>
        <div class="nbody">将重新覆盖程序文件以修复安装。配置、部署历史和日志会保留，安装位置和快捷方式不变。</div>
      </div>`;
  } else if (isUpgrade) {
    notice = `
      <div class="notice neutral">
        <div class="nhead">检测到已安装 <span class="nver">v${escapeHtml(V.from)}</span>，将升级到 <span class="nver">v${escapeHtml(V.to)}</span></div>
        <div class="nbody">配置、部署历史和日志会保留。安装位置沿用原目录，原有快捷方式不变。</div>
      </div>`;
  }

  const desc = isExisting
    ? '本向导会先备份当前版本，再替换程序文件。'
    : '在本机管理 Java 服务的构建、部署与回滚。安装过程不会改动已有用户数据。';

  el.body.innerHTML = `
    <div class="page">
      <div class="lede">
        <span class="logo"><img src="icon.svg" alt="YOTOO" /></span>
        <div>
          <h2>${title}</h2>
          <div class="meta">${meta}</div>
        </div>
      </div>
      ${isDowngrade ? '' : `<p class="copy">${desc}</p>`}
      ${notice}
      <div class="facts">
        ${isExisting ? `<span>${ICON.folder} 安装目录 <b>${escapeHtml(V.installPath)}</b></span>` : `<span>${ICON.disk} 安装大小 <b>${escapeHtml(V.size)}</b></span><span>${ICON.folder} 可选择安装位置</span>`}
      </div>
      ${!isExisting ? '<p class="hint">支持为当前用户安装。</p>' : ''}
    </div>`;

  const blocked = isDowngrade && !state.downgradeAck;
  el.foot.innerHTML = foot([
    { label: '取消', act: 'cancel' },
    { spacer: true },
    { label: '下一步', act: 'next', kind: 'primary', disabled: blocked },
  ]);
}

/* ---------- 安装位置页 ---------- */
function pageLocation() {
  el.body.innerHTML = `
    <div class="page">
      <div class="lede">
        <div>
          <h2>选择安装位置</h2>
          <div class="meta">程序文件写在这里，用户数据另有目录</div>
        </div>
      </div>
      <div class="field">
        <label for="path">安装目录</label>
        <div class="pathrow">
          <input class="input" id="path" spellcheck="false" aria-describedby="disk-space" />
          <button class="btn" data-act="browse">浏览</button>
        </div>
        <div class="space">
          ${ICON.disk}<span id="disk-space" role="status"></span>
        </div>
      </div>
      <label class="opt">
        <input type="checkbox" id="desktop"${state.desktopShortcut ? ' checked' : ''} />
        <span>创建桌面快捷方式<small>开始菜单入口会自动创建。</small></span>
      </label>
      <p class="footnote">配置、部署历史和日志保存在独立的数据目录，不会被安装程序改动。</p>
    </div>`;

  el.foot.innerHTML = foot([
    { label: '取消', act: 'cancel' },
    { spacer: true },
    { label: '上一步', act: 'back' },
    { label: '安装', act: 'install', kind: 'primary' },
  ]);
  find('path').value = state.installPath;
  validateLocation();
}

function pageRunningCheck() {
  const action = state.flow === 'uninstall' ? '卸载' : '安装';
  el.body.innerHTML = `
    <div class="page">
      <div class="lede">
        <span class="fail-mark">${ICON.warn}</span>
        <div><h2>请先退出 YOTOO 部署中心</h2><div class="meta">${action}前检测到应用仍在运行</div></div>
      </div>
      <p class="copy">如果有部署任务，请等待任务结束，再从系统托盘退出应用。退出后点击「重新检查」。</p>
    </div>`;
  el.foot.innerHTML = foot([
    { label: '取消', act: 'cancel' }, { spacer: true },
    { label: '重新检查', act: 'recheck', kind: 'primary' },
  ]);
}

/* ---------- 安装中页 ---------- */
function stageIndex(stages, p) {
  const found = stages.findIndex((s) => p < s.to);
  return Math.max(0, Math.min(found === -1 ? stages.length - 1 : found, stages.length - 1));
}

function pageProgress() {
  const stages = stagesOf();
  const p = state.progress;
  const idx = stageIndex(stages, p);
  const cur = stages[idx];
  const overall = Math.round(p);

  const list = stages
    .map((s, i) => {
      const cls = p >= s.to ? 'done' : i === idx ? 'active' : 'wait';
      const mark = cls === 'done' ? ICON.check : '';
      return `<li class="${cls}"><span class="mk" aria-hidden="true">${mark}</span><span>${s.label}</span><span class="stage-state"></span></li>`;
    })
    .join('');

  el.body.innerHTML = `
    <div class="page">
      <div class="phead">
        <strong tabindex="-1">${'正在' + cur.label}</strong>
        <span class="stat"><b>${overall}%</b></span>
      </div>
      <div class="pbar" id="pbar" role="progressbar" aria-label="${state.flow === 'uninstall' ? '卸载进度' : '安装进度'}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${overall}"><i style="width:${p}%"></i></div>
      <ul class="stages">${list}</ul>
    </div>`;

  el.foot.innerHTML = foot([{ label: '取消', act: 'cancel', disabled: true }, { spacer: true }]);
  paintProgress();
}

/* ---------- 完成页 ---------- */
function pageDone() {
  const uninstall = state.flow === 'uninstall';
  const isUpgrade = state.flow === 'upgrade';
  const isRepair = state.flow === 'repair';
  const isDowngrade = state.flow === 'downgrade';
  const title = uninstall ? '卸载完成' : isDowngrade
    ? '降级完成'
    : isRepair
      ? '修复安装完成'
      : isUpgrade
        ? '升级完成'
        : '安装完成';
  const text = uninstall
    ? (state.result.reason || (state.result.purged ? '程序文件和快捷方式已移除，用户数据已删除。' : '程序文件和快捷方式已移除，配置、部署历史和日志已保留。'))
    : isDowngrade
    ? `已从 v${(V.from)} 降级到 v${(V.to)}。配置、部署历史和日志已保留。`
    : isRepair
      ? `v${(V.to)} 的修复安装已完成。配置、部署历史和日志已保留。`
      : isUpgrade
        ? `已从 v${(V.from)} 升级到 v${(V.to)}。配置、部署历史和日志已保留。`
        : `YOTOO 部署中心 v${(V.to)} 已安装到 ${currentInstallPath()}。`;

  el.body.innerHTML = `
    <div class="page">
      <div class="done-wrap">
        <span class="done-mark">${ICON.checkBig}</span>
        <h2>${title}</h2>
        <p id="done-text"></p>
        ${uninstall ? '' : `<label class="opt">
          <input type="checkbox" id="launch-after"${state.launchAfter ? ' checked' : ''} />
          <span>立即打开 YOTOO 部署中心</span>
        </label>`}
      </div>
    </div>`;

  el.foot.innerHTML = foot([{ spacer: true }, { label: '完成', act: 'finish', kind: 'primary' }]);
  find('done-text').textContent = text;
}

/* ---------- 失败页 ---------- */
function pageFailed() {
  el.body.innerHTML = `
    <div class="page fail">
      <div class="lede">
        <span class="fail-mark">${ICON.alert}</span>
        <div>
          <h2>${state.flow === 'uninstall' ? '卸载未完成' : '安装未完成'}</h2>
          <div class="meta">${escapeHtml(state.failure.recovery)}</div>
        </div>
      </div>
      <p class="copy">${escapeHtml(state.failure.reason)}</p>
      <div class="advice"><b>建议</b>　${escapeHtml(state.failure.advice)}</div>
    </div>`;

  el.foot.innerHTML = foot([
    { label: '打开日志位置', act: 'openlog', kind: 'ghost' },
    { spacer: true },
    { label: '取消', act: 'cancel' },
    ...(state.flow === 'fresh' ? [{ label: '上一步', act: 'back' }] : []),
    ...(state.flow === 'uninstall' ? [] : [{ label: '重试', act: 'retry', kind: 'primary' }]),
  ]);
}

/* ---------- 卸载页 ---------- */
function pageUninstall() {
  el.body.innerHTML = `
    <div class="page">
      <div class="lede">
        <span class="logo"><img src="icon.svg" alt="YOTOO" /></span>
        <div>
          <h2>卸载 YOTOO 部署中心</h2>
          <div class="meta">v${escapeHtml(V.to)} · ${escapeHtml(V.installPath)}</div>
        </div>
      </div>
      <p class="copy">将移除程序文件和快捷方式。请先退出应用，卸载程序不会强制关闭正在执行的部署任务。</p>
      <label class="opt" style="margin-top:16px">
        <input type="checkbox" id="remove-data"${state.removeData ? ' checked' : ''} />
        <span>同时删除配置、部署历史和日志
          <small>默认保留。不勾选时，重新安装可以继续使用现有配置和历史。</small>
        </span>
      </label>
      <p class="hint">数据目录将在删除确认中显示。</p>
    </div>`;

  el.foot.innerHTML = foot([
    { label: '取消', act: 'cancel' },
    { spacer: true },
    { label: '卸载', act: 'uninstall', kind: 'primary' },
  ]);
}

/* ============================================================
   渲染入口
   ============================================================ */
function render() {
  applyTheme();
  const close = find('ctl-close');
  close.disabled = state.step === 'progress';
  close.title = close.disabled ? '操作进行中，暂时无法关闭' : '关闭';
  el.wintitle.textContent =
    state.flow === 'uninstall' ? 'YOTOO 部署中心 卸载程序' : 'YOTOO 部署中心 安装程序';

  if (state.step === 'welcome') (state.flow === 'uninstall' ? pageUninstall : pageWelcome)();
  else if (state.step === 'location') pageLocation();
  else if (state.step === 'running-check') pageRunningCheck();
  else if (state.step === 'progress') pageProgress();
  else if (state.step === 'done') pageDone();
  else if (state.step === 'failed') pageFailed();

}

function applyTheme() {
  const dark = state.theme === 'dark' || (state.theme === 'system' && systemTheme.matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

function paintProgress() {
  const bar = document.getElementById('pbar');
  if (!bar) return;

  const stages = stagesOf();
  const p = state.progress;
  const idx = stageIndex(stages, p);
  const unknown = p < 100 && state.indeterminate;
  const overall = Math.floor(p);
  const fill = bar.firstElementChild;
  const waitingForStart = unknown && p === 0;
  fill.style.transition = waitingForStart || bar.classList.contains('pending') ? 'none' : '';
  fill.style.width = waitingForStart ? '28%' : p + '%';
  bar.classList.toggle('pending', waitingForStart);
  if (unknown) bar.removeAttribute('aria-valuenow');
  else bar.setAttribute('aria-valuenow', String(overall));
  const list = document.querySelector('.stages');
  if (list) {
    [...list.children].forEach((li, i) => {
      const s = stages[i];
      const cls = p >= s.to ? 'done' : i === idx ? 'active' : 'wait';
      if (li.className !== cls) {
        li.className = cls;
        li.firstElementChild.innerHTML = cls === 'done' ? ICON.check : '';
      }
      li.lastElementChild.textContent = cls === 'done' ? '已完成' : cls === 'active' ? '进行中' : '等待';
    });
  }

  const stat = document.querySelector('.phead .stat');
  if (stat) {
    const detail = unknown && stages[idx].key === 'finish' ? '正在核验'
      : p >= 5 && p < 100 && Number.isFinite(state.eta) ? `解压剩余约 ${Math.max(1, Math.round(state.eta))} 秒` : '';
    stat.innerHTML = `<b>${overall}%</b>${detail ? ' · ' + detail : ''}`;
  }
  const head = document.querySelector('.phead strong');
  if (head) {
    head.textContent = p >= 100 ? '已完成' : '正在' + stages[idx].label;
  }
}

function confirmDialog(title, message, action, run, kind = 'primary', dismiss) {
  const dialog = find('prompt');
  find('prompt-title').textContent = title;
  find('prompt-body').replaceChildren();
  const paragraph = document.createElement('p');
  paragraph.textContent = message;
  find('prompt-body').append(paragraph);
  find('prompt-actions').innerHTML = foot([
    { label: '返回', act: 'dismiss' }, { label: action, act: 'confirm', kind },
  ]);
  find('prompt-actions').querySelector('[data-act="dismiss"]').onclick = () => { dialog.close(); dismiss?.(); };
  dialog.oncancel = () => dismiss?.();
  find('prompt-actions').querySelector('[data-act="confirm"]').onclick = () => {
    dialog.close();
    run();
  };
  dialog.showModal();
}

let pathRevision = 0;
let pending = false;

async function validateLocation() {
  const revision = ++pathRevision;
  const message = find('disk-space');
  const pathInput = find('path');
  const install = el.foot.querySelector('[data-act="install"]');
  if (!install) return false;
  install.disabled = true;
  const drive = driveOf(state.installPath);
  const disk = drive && await window.wizard.request('space', drive);
  if (revision !== pathRevision || !message.isConnected) return false;
  const valid = Boolean(disk && disk.free >= state.required);
  const space = disk && (disk.free >= 1024 ? (disk.free / 1024).toFixed(1) + ' GB' : disk.free + ' MB');
  message.textContent = disk
    ? `需要 ${V.size} · ${drive} 盘可用 ${space}${valid ? '' : ' · 空间不足'}`
    : '请输入带盘符的完整安装目录。';
  message.parentElement.classList.toggle('insufficient', !valid);
  pathInput.setAttribute('aria-invalid', String(!valid));
  install.disabled = !valid;
  return valid;
}

function goStep(step) {
  if (find('prompt').open) find('prompt').close();
  state.step = step;
  render();
  const page = el.body.firstElementChild;
  page.classList.add('enter');
  const heading = page.querySelector('h2, .phead strong');
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

async function start() {
  if (pending) return;
  pending = true;
  try {
    await window.wizard.request('start', {
      directory: currentInstallPath(), desktop: state.desktopShortcut,
      downgrade: state.downgradeAck, purge: state.removeData,
    });
  } catch {
    pending = false;
    confirmDialog('无法继续', '安装向导无法写入状态，请检查临时目录权限和磁盘空间。', '确定', () => {});
  }
}

function applyStatus(status) {
  pending = false;
  if (status.phase === 'progress') {
    state.progress = Math.max(state.progress, status.progress);
    state.indeterminate = status.indeterminate;
    state.eta = status.eta;
    if (state.step === 'progress') paintProgress();
    else goStep('progress');
  } else if (status.phase === 'done') {
    state.result = status;
    state.progress = 100;
    if (state.step === 'progress') paintProgress();
    setTimeout(() => goStep('done'), 150);
  } else if (status.phase === 'failed') {
    const advice = state.flow === 'uninstall'
      ? '关闭占用程序文件的应用后，从 Windows 设置重新卸载。'
      : hasPrevious()
        ? '检查磁盘空间、目录权限和应用运行状态后重试。'
        : '检查磁盘空间和目录权限，也可以返回选择其他安装位置。';
    state.failure = { ...status, advice };
    goStep('failed');
  } else if (status.phase === 'running-check') {
    goStep('running-check');
  } else if (status.phase === 'invalid') {
    goStep(V.chooseDirectory ? 'location' : 'welcome');
    confirmDialog(state.flow === 'uninstall' ? '无法继续卸载' : '无法继续安装', status.reason, '确定', () => {});
  } else if (status.phase === 'confirm-purge') {
    confirmDialog('确认删除用户数据？', status.reason, '删除并卸载',
      () => window.wizard.request('confirmPurge'), 'danger', () => window.wizard.request('declinePurge'));
  } else if (status.phase === 'welcome') {
    goStep('welcome');
  }
}

el.body.addEventListener('click', async (event) => {
  if (!event.target.closest('[data-act="browse"]')) return;
  const selected = await window.wizard.request('browse', state.installPath);
  if (selected && state.step === 'location') {
    state.installPath = selected;
    find('path').value = selected;
    await validateLocation();
  }
});
el.body.addEventListener('input', (event) => {
  if (event.target.id === 'path') {
    state.installPath = event.target.value;
    void validateLocation();
  }
});
el.body.addEventListener('change', (event) => {
  const { id, checked } = event.target;
  if (id === 'ack') {
    state.downgradeAck = checked;
    el.foot.querySelector('[data-act="next"]').disabled = !checked;
  }
  if (id === 'desktop') state.desktopShortcut = checked;
  if (id === 'remove-data') state.removeData = checked;
  if (id === 'launch-after') state.launchAfter = checked;
});

el.foot.addEventListener('click', async (event) => {
  const action = event.target.closest('button[data-act]')?.dataset.act;
  switch (action) {
    case 'cancel': await window.wizard.request('close'); break;
    case 'next': if (V.chooseDirectory) goStep('location'); else await start(); break;
    case 'back':
      if (state.step === 'failed') await window.wizard.request('retry', true);
      else goStep('welcome');
      break;
    case 'install': if (await validateLocation()) await start(); break;
    case 'recheck': case 'uninstall': await start(); break;
    case 'retry': await window.wizard.request('retry', false); break;
    case 'openlog': if (await window.wizard.request('openLog')) confirmDialog('无法打开日志位置', '请检查日志目录是否可访问。', '确定', () => {}); break;
    case 'finish': await window.wizard.request('finish', state.launchAfter); break;
  }
});
find('ctl-close').addEventListener('click', () => window.wizard.request('close'));
find('ctl-min').addEventListener('click', () => window.wizard.request('minimize'));
systemTheme.addEventListener('change', applyTheme);

window.wizard.onStatus(applyStatus);
window.wizard.request('initial').then((settings) => {
  Object.assign(V, { ...settings, arch: 'Windows x64', size: settings.required + ' MB' });
  Object.assign(state, {
    flow: settings.mode, step: settings.back ? 'location' : 'welcome', required: settings.required, installPath: settings.installPath,
    desktopShortcut: settings.desktop,
  });
  renderChromeIcons();
  render();
});

