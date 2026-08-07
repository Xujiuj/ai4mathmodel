import { Download, PackageSearch, RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { desktopApi } from '../api.js';
import { updaterReason } from '../updateMessages.js';
import { CommandButton } from './Shell.jsx';

const COMPONENT_LABELS = {
  core: '桌面核心',
  python: 'Python 运行时',
  latex: 'LaTeX 运行时',
  plotting: '科研绘图组件',
  research: '科研检索组件',
};

function componentReason(reason) {
  if (/Manifest fetch failed|fetch failed|ENOTFOUND|example\.com/i.test(reason || '')) {
    return '运行组件更新源未配置或暂不可用。';
  }
  if (/signature/i.test(reason || '')) return '运行组件更新清单签名校验失败。';
  return reason || '无法读取运行组件更新。';
}

export function UpdateCenter() {
  const [appVersion, setAppVersion] = useState('');
  const [appUpdate, setAppUpdate] = useState({ status: 'idle', message: '尚未检查应用更新。', version: '', percent: 0 });
  const [componentUpdate, setComponentUpdate] = useState({ status: 'idle', message: '尚未检查运行组件。', updates: [], percent: 0 });
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let active = true;
    desktopApi.appInfo()
      .then((info) => active && setAppVersion(info?.version || ''))
      .catch(() => {});

    const unsubscribe = desktopApi.onUpdaterEvent((event = {}) => {
      if (!active) return;
      if (event.type === 'checking') {
        setAppUpdate({ status: 'checking', message: '正在检查应用更新…', version: '', percent: 0 });
      } else if (event.type === 'available') {
        setAppUpdate({ status: 'available', message: `发现版本 ${event.version || ''}`.trim(), version: event.version || '', percent: 0 });
      } else if (event.type === 'up-to-date') {
        setAppUpdate({ status: 'current', message: '当前已是最新版本。', version: '', percent: 0 });
      } else if (event.type === 'download-progress') {
        const percent = Math.max(0, Math.min(100, Number(event.percent || 0)));
        setAppUpdate((current) => ({ ...current, status: 'downloading', message: `正在下载 ${Math.round(percent)}%`, percent }));
      } else if (event.type === 'ready') {
        setAppUpdate({ status: 'ready', message: `版本 ${event.version || ''} 已就绪，安装将重启应用。`.trim(), version: event.version || '', percent: 100 });
      } else if (event.type === 'error') {
        setAppUpdate({ status: 'error', message: updaterReason(event.message), version: '', percent: 0 });
      }
    });
    const unsubscribeComponents = desktopApi.onComponentEvent((event = {}) => {
      if (!active) return;
      const label = COMPONENT_LABELS[event.component] || event.component || '运行组件';
      const percent = event.total ? Math.max(0, Math.min(100, (Number(event.received) / Number(event.total)) * 100)) : 0;
      if (event.phase === 'download') {
        setComponentUpdate((current) => ({ ...current, status: 'installing', message: `正在下载 ${label} ${Math.round(percent)}%`, percent }));
      } else if (event.phase === 'extract') {
        setComponentUpdate((current) => ({ ...current, status: 'installing', message: `正在安装 ${label}`, percent: 95 }));
      }
    });

    return () => {
      active = false;
      unsubscribe?.();
      unsubscribeComponents?.();
    };
  }, []);

  const checkApplication = async () => {
    setBusy('check-app');
    setAppUpdate({ status: 'checking', message: '正在检查应用更新…', version: '', percent: 0 });
    try {
      const result = await desktopApi.checkForUpdates();
      if (!result?.ok) setAppUpdate({ status: 'unavailable', message: updaterReason(result?.reason), version: '', percent: 0 });
    } catch (error) {
      setAppUpdate({ status: 'error', message: updaterReason(error.message), version: '', percent: 0 });
    } finally {
      setBusy('');
    }
  };

  const downloadApplication = async () => {
    setBusy('download-app');
    try {
      const result = await desktopApi.downloadUpdate();
      if (!result?.ok) setAppUpdate((current) => ({ ...current, status: 'error', message: updaterReason(result?.reason) }));
    } catch (error) {
      setAppUpdate((current) => ({ ...current, status: 'error', message: updaterReason(error.message) }));
    } finally {
      setBusy('');
    }
  };

  const installApplication = async () => {
    setBusy('install-app');
    try {
      const result = await desktopApi.installUpdate();
      if (!result?.ok) {
        setAppUpdate((current) => ({ ...current, status: 'error', message: updaterReason(result?.reason) }));
        setBusy('');
      }
    } catch (error) {
      setAppUpdate((current) => ({ ...current, status: 'error', message: updaterReason(error.message) }));
      setBusy('');
    }
  };

  const checkComponents = async () => {
    setBusy('check-components');
    setComponentUpdate({ status: 'checking', message: '正在检查运行组件…', updates: [], percent: 0 });
    try {
      const result = await desktopApi.listComponentUpdates();
      if (!result?.ok) {
        setComponentUpdate({ status: 'unavailable', message: componentReason(result?.reason), updates: [], percent: 0 });
      } else if (!result.updates?.length) {
        setComponentUpdate({ status: 'current', message: '运行组件已是最新版本。', updates: [], percent: 0 });
      } else {
        setComponentUpdate({ status: 'available', message: `发现 ${result.updates.length} 项组件更新。`, updates: result.updates, percent: 0 });
      }
    } catch (error) {
      setComponentUpdate({ status: 'error', message: componentReason(error.message), updates: [], percent: 0 });
    } finally {
      setBusy('');
    }
  };

  const installComponents = async () => {
    const updates = [...componentUpdate.updates];
    if (!updates.length) return;
    setBusy('install-components');
    try {
      for (const item of updates) {
        setComponentUpdate((current) => ({ ...current, status: 'installing', message: `正在安装 ${COMPONENT_LABELS[item.name] || item.name}`, percent: 0 }));
        const result = await desktopApi.installComponentUpdate(item.name);
        if (!result?.ok) throw new Error(result?.reason || '运行组件安装失败。');
      }
      setComponentUpdate({ status: 'current', message: '运行组件安装完成。', updates: [], percent: 100 });
    } catch (error) {
      setComponentUpdate((current) => ({ ...current, status: 'error', message: componentReason(error.message), percent: 0 }));
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="update-center" aria-labelledby="update-center-title">
      <div className="settings-section-title">
        <div><h3 id="update-center-title">更新</h3></div>
        <span className="settings-status-line">{appVersion ? `当前版本 ${appVersion}` : '桌面应用'}</span>
      </div>

      <div className="update-group">
        <div className="update-row">
          <div className="update-meta"><strong>桌面应用</strong><small role="status">{appUpdate.message}</small></div>
          <div className="update-actions">
            <CommandButton icon={RefreshCw} disabled={Boolean(busy)} onClick={checkApplication}>{busy === 'check-app' ? '检查中' : '检查更新'}</CommandButton>
            <CommandButton icon={Download} disabled={Boolean(busy) || appUpdate.status !== 'available'} onClick={downloadApplication}>{busy === 'download-app' ? '下载中' : '下载'}</CommandButton>
            <CommandButton icon={RotateCcw} tone="primary" disabled={Boolean(busy) || appUpdate.status !== 'ready'} onClick={installApplication}>安装并重启</CommandButton>
          </div>
        </div>
        {appUpdate.status === 'downloading' ? (
          <div className="update-progress" role="progressbar" aria-label="应用更新下载进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(appUpdate.percent)}>
            <i style={{ width: `${appUpdate.percent}%` }} />
          </div>
        ) : null}
      </div>

      <div className="update-group">
        <div className="update-row">
          <div className="update-meta"><strong>运行组件</strong><small role="status">{componentUpdate.message}</small></div>
          <div className="update-actions">
            <CommandButton icon={PackageSearch} disabled={Boolean(busy)} onClick={checkComponents}>{busy === 'check-components' ? '检查中' : '检查组件'}</CommandButton>
            <CommandButton icon={Download} tone="primary" disabled={Boolean(busy) || !componentUpdate.updates.length} onClick={installComponents}>{busy === 'install-components' ? '安装中' : '安装组件'}</CommandButton>
          </div>
        </div>
        {componentUpdate.status === 'installing' ? (
          <div className="update-progress" role="progressbar" aria-label="运行组件安装进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(componentUpdate.percent)}>
            <i style={{ width: `${componentUpdate.percent}%` }} />
          </div>
        ) : null}
        {componentUpdate.updates.length ? (
          <ul className="component-update-list">
            {componentUpdate.updates.map((item) => (
              <li key={item.name}>
                <strong>{COMPONENT_LABELS[item.name] || item.name}</strong>
                <span>{item.from || '未安装'} → {item.to}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
