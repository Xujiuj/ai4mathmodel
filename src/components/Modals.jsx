import {
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  Monitor,
  Moon,
  RefreshCw,
  RotateCcw,
  Settings,
  Sun,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, MODEL_CONNECTIONS } from '../modelConfig.js';
import { CommandButton, IconButton } from './Shell.jsx';

export function Modal({ title, children, onClose, width = 520 }) {
  useEffect(() => {
    const close = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }}>
        <header><h2>{title}</h2><IconButton label="关闭" onClick={onClose}><X size={17} /></IconButton></header>
        {children}
      </section>
    </div>
  );
}

export function CreateProjectModal({ onClose, onCreate }) {
  const [name, setName] = useState('新建数模项目');
  return (
    <Modal title="新建项目" onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); onCreate(name); }}>
        <label><span>项目名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="project-structure-preview">
          <FolderOpen size={18} />
          <div><strong>标准工作区</strong><p>inputs/template、inputs/problem 与 work</p></div>
        </div>
        <footer><button type="button" onClick={onClose}>取消</button><CommandButton type="submit" tone="primary">创建项目</CommandButton></footer>
      </form>
    </Modal>
  );
}

function StatusLine({ value }) {
  return <span className="settings-status-line">{value}</span>;
}

export function ConnectionSettingsModal({ onClose, settings, onSave, onDiscoverModels }) {
  const [form, setForm] = useState({
    ...DEFAULT_SETTINGS,
    ...settings,
    connections: Object.fromEntries(MODEL_CONNECTIONS.map(([key]) => [key, {
      ...DEFAULT_SETTINGS.connections[key],
      ...settings?.connections?.[key],
      apiKey: '',
      clearApiKey: false,
    }])),
  });
  const [activeConnection, setActiveConnection] = useState('reasoning');
  const [discovery, setDiscovery] = useState({});
  const [showKeys, setShowKeys] = useState({});
  const [saving, setSaving] = useState(false);
  const [formMessage, setFormMessage] = useState('');

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const updateConnection = (key, field, value) => {
    const resetsDiscovery = ['baseUrl', 'protocol', 'apiKey'].includes(field);
    setForm((current) => ({
      ...current,
      connections: {
        ...current.connections,
        [key]: {
          ...current.connections[key],
          [field]: value,
          ...(field === 'apiKey' ? { clearApiKey: false } : {}),
          ...(['baseUrl', 'protocol'].includes(field) ? { apiKeyConfigured: false } : {}),
        },
      },
    }));
    if (resetsDiscovery) setDiscovery((current) => ({ ...current, [key]: { status: 'idle', message: '', models: [] } }));
    setFormMessage('');
  };

  const testConnection = async (key) => {
    const connection = form.connections[key];
    if (!connection.baseUrl) {
      setDiscovery((current) => ({ ...current, [key]: { status: 'error', message: '请先填写 Base URL', models: [] } }));
      return;
    }
    setDiscovery((current) => ({ ...current, [key]: { status: 'loading', message: '正在连接并读取模型', models: [] } }));
    try {
      const result = await onDiscoverModels(form, key);
      const models = result.models || [];
      setDiscovery((current) => ({ ...current, [key]: { status: 'success', message: `已读取 ${models.length} 个模型`, models } }));
      setForm((current) => ({
        ...current,
        connections: {
          ...current.connections,
          [key]: {
            ...current.connections[key],
            model: current.connections[key].model || models[0] || '',
            apiKeyConfigured: Boolean(result.apiKeyConfigured || current.connections[key].apiKeyConfigured),
          },
        },
      }));
    } catch (error) {
      setDiscovery((current) => ({ ...current, [key]: { status: 'error', message: error.message || '连接失败', models: [] } }));
    }
  };

  const save = async () => {
    setSaving(true);
    setFormMessage('');
    try {
      await onSave(form);
    } catch (error) {
      setFormMessage(error.message || '设置保存失败');
    } finally {
      setSaving(false);
    }
  };

  const activeMeta = MODEL_CONNECTIONS.find(([key]) => key === activeConnection) || MODEL_CONNECTIONS[0];
  const connection = form.connections[activeConnection];
  const result = discovery[activeConnection] || { status: 'idle', models: [] };

  return (
    <Modal title="模型设置" onClose={onClose} width={800}>
      <div className="settings-content">
        <nav className="settings-connection-tabs" role="tablist" aria-label="模型类型">
          {MODEL_CONNECTIONS.map(([key, title]) => (
            <button type="button" role="tab" aria-selected={activeConnection === key} className={activeConnection === key ? 'active' : ''} key={key} onClick={() => setActiveConnection(key)}>{title}</button>
          ))}
        </nav>

        <section className="model-settings-section connection-block">
          <div className="settings-section-title"><div><h3>{activeMeta[1]}</h3></div><StatusLine value={connection.model || '未选择模型'} /></div>
          <div className="connection-grid">
            <label><span>服务名称（Provider）</span><input value={connection.provider || ''} placeholder="自定义服务名称" onChange={(event) => updateConnection(activeConnection, 'provider', event.target.value)} /></label>
            <label><span>接口协议</span><select value={connection.protocol || 'openai'} onChange={(event) => updateConnection(activeConnection, 'protocol', event.target.value)}><option value="openai">OpenAI 兼容</option><option value="anthropic" disabled={activeConnection === 'image'}>Anthropic</option><option value="ollama">Ollama</option></select></label>
            <label className="connection-wide"><span>接口地址（Base URL）</span><input value={connection.baseUrl || ''} placeholder="https://api.example.com/v1" onChange={(event) => updateConnection(activeConnection, 'baseUrl', event.target.value)} /></label>
            <label><span>API 密钥</span><div className="input-with-action"><KeyRound size={14} /><input type={showKeys[activeConnection] ? 'text' : 'password'} value={connection.apiKey || ''} placeholder={connection.apiKeyConfigured ? '已安全保存，留空继续使用' : '按服务要求填写'} onChange={(event) => updateConnection(activeConnection, 'apiKey', event.target.value)} /><IconButton label={showKeys[activeConnection] ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKeys((current) => ({ ...current, [activeConnection]: !current[activeConnection] }))}>{showKeys[activeConnection] ? <EyeOff size={14} /> : <Eye size={14} />}</IconButton></div>{connection.apiKeyConfigured && !connection.apiKey ? <small className="credential-state">已配置本机密钥<button type="button" className="inline-danger" onClick={() => setForm((current) => ({ ...current, connections: { ...current.connections, [activeConnection]: { ...current.connections[activeConnection], apiKey: '', apiKeyConfigured: false, clearApiKey: true } } }))}>清除</button></small> : null}</label>
            <label className="model-field"><span>模型</span>{result.models.length ? <select value={connection.model || ''} onChange={(event) => updateConnection(activeConnection, 'model', event.target.value)}><option value="">选择可用模型</option>{connection.model && !result.models.includes(connection.model) ? <option value={connection.model}>{connection.model}</option> : null}{result.models.map((model) => <option key={model} value={model}>{model}</option>)}</select> : <input value={connection.model || ''} placeholder="测试连接后选择，或填写模型 ID" onChange={(event) => updateConnection(activeConnection, 'model', event.target.value)} />}</label>
            <label className="toggle-row connection-wide"><span><strong>允许远程 HTTP</strong><small>仅用于可信局域网，公网服务应使用 HTTPS</small></span><input type="checkbox" checked={Boolean(connection.allowInsecureRemote)} onChange={(event) => updateConnection(activeConnection, 'allowInsecureRemote', event.target.checked)} /></label>
          </div>
          <div className="model-discovery-row"><button type="button" className="command-button command-primary" onClick={() => testConnection(activeConnection)} disabled={result.status === 'loading'}><RefreshCw size={14} className={result.status === 'loading' ? 'spinning' : ''} />测试连接并读取模型</button><span className={`discovery-message discovery-${result.status}`}>{result.message || '尚未测试连接'}</span></div>
        </section>

        <section className="preference-section">
          <h3>工作区</h3>
          <div className="appearance-setting">
            <span><strong>外观</strong></span>
            <div className="appearance-segments" role="radiogroup" aria-label="界面外观">
              {[
                ['light', '浅色', Sun],
                ['dark', '深色', Moon],
                ['system', '跟随系统', Monitor],
              ].map(([value, label, Icon]) => (
                <button type="button" role="radio" aria-checked={form.appearance === value} className={form.appearance === value ? 'active' : ''} key={value} onClick={() => update('appearance', value)}><Icon size={14} />{label}</button>
              ))}
            </div>
          </div>
          <div className="preference-grid">
            <label className="toggle-row"><span><strong>自动保存</strong></span><input type="checkbox" checked={Boolean(form.autoSave)} onChange={(event) => update('autoSave', event.target.checked)} /></label>
            <label className="toggle-row"><span><strong>紧凑布局</strong></span><input type="checkbox" checked={Boolean(form.compactMode)} onChange={(event) => update('compactMode', event.target.checked)} /></label>
          </div>
        </section>

        <footer><span className="settings-save-message" role="status">{formMessage}</span><button type="button" onClick={onClose}>取消</button><CommandButton icon={Settings} tone="primary" onClick={save} disabled={saving}>{saving ? '保存中' : '保存设置'}</CommandButton></footer>
      </div>
    </Modal>
  );
}

export function ConfirmModal({ title, message, confirmLabel = '确认', tone = 'primary', onClose, onConfirm }) {
  return (
    <Modal title={title} onClose={onClose} width={470}>
      <div className="confirm-content">
        <p>{message}</p>
        <footer><button onClick={onClose}>取消</button><CommandButton tone={tone} onClick={onConfirm}>{confirmLabel}</CommandButton></footer>
      </div>
    </Modal>
  );
}

export function FigureReviewModal({ figures = [], onClose, onSelect, onOpen }) {
  const [selected, setSelected] = useState(figures[0] || null);
  return (
    <Modal title="图表审阅器" onClose={onClose} width={900}>
      <div className="figure-review-modal">
        <nav>
          {figures.map((figure, index) => (
            <button key={figure.path || figure.name} className={selected?.path === figure.path ? 'active' : ''} onClick={() => setSelected(figure)}>
              <span>图 {index + 1}</span><strong>{figure.name}</strong>
            </button>
          ))}
        </nav>
        <section>
          <div className="figure-review-canvas">{selected?.url ? <img src={selected.url} alt={selected.name} /> : <FolderOpen size={28} />}</div>
          <div className="figure-review-meta"><div><strong>{selected?.name || '暂无图表'}</strong><small>{selected?.relative || '项目中尚未登记图表'}</small></div><span>{selected ? '源文件' : '空状态'}</span></div>
          <footer>
            <CommandButton icon={RotateCcw} onClick={() => selected && onSelect(selected)} disabled={!selected}>设为论文预览</CommandButton>
            <CommandButton icon={ExternalLink} tone="primary" onClick={() => selected && onOpen(selected)} disabled={!selected}>系统打开</CommandButton>
          </footer>
        </section>
      </div>
    </Modal>
  );
}
