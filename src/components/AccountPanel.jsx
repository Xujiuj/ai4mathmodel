import { CreditCard, LogOut, RefreshCw, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { desktopApi } from '../api.js';
import { CommandButton } from './Shell.jsx';

function formatAmount(value, currency = 'CNY') {
  const symbol = currency === 'CNY' ? '¥' : `${currency} `;
  return `${symbol}${Number(value || 0).toFixed(2)}`;
}

export function AccountPanel({ tiers, activeTiers, onTierChange }) {
  const [state, setState] = useState({ status: 'loading', configured: false, signedIn: false });
  const [credentials, setCredentials] = useState({ email: '', password: '' });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await desktopApi.getAccount();
      setState({ status: 'ready', ...result });
    } catch (error) {
      setState({ status: 'error', configured: true, signedIn: false });
      setMessage(error.message || '无法读取账户信息。');
    }
  }, []);

  useEffect(() => {
    load();
    const refresh = () => load();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [load]);

  const run = async (action, fallback) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
      await load();
    } catch (error) {
      setMessage(error.message || fallback);
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'loading') {
    return <section className="account-panel"><p className="account-hint">正在读取账户信息…</p></section>;
  }

  if (!state.configured) {
    return (
      <section className="account-panel">
        <div className="settings-section-title"><div><h3>官方托管</h3></div></div>
        <p className="account-hint">当前版本未配置托管服务地址，请改用自带模型。</p>
      </section>
    );
  }

  if (!state.signedIn) {
    return (
      <section className="account-panel">
        <div className="settings-section-title"><div><h3>登录托管账户</h3></div></div>
        <form
          className="account-login"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => desktopApi.loginAccount(credentials.email, credentials.password), '登录失败。');
          }}
        >
          <label><span>账户邮箱</span><input type="email" autoComplete="username" value={credentials.email} onChange={(event) => setCredentials((current) => ({ ...current, email: event.target.value }))} /></label>
          <label><span>密码</span><input type="password" autoComplete="current-password" value={credentials.password} onChange={(event) => setCredentials((current) => ({ ...current, password: event.target.value }))} /></label>
          <CommandButton type="submit" tone="primary" disabled={busy || !credentials.email || !credentials.password}>{busy ? '登录中' : '登录'}</CommandButton>
        </form>
        <span className="settings-save-message" role="status">{message}</span>
      </section>
    );
  }

  const account = state.account || {};
  const options = tiers?.length ? tiers : state.tiers || [];

  return (
    <section className="account-panel">
      <div className="settings-section-title">
        <div><h3>账户</h3></div>
        <span className="settings-status-line">{account.email}</span>
      </div>
      <div className="account-balance">
        <Wallet size={16} />
        <strong>{formatAmount(account.balance, account.currency)}</strong>
        <small>累计消费 {formatAmount(account.totalSpend, account.currency)}</small>
      </div>
      <div className="account-actions">
        <CommandButton icon={CreditCard} tone="primary" disabled={busy} onClick={() => run(() => desktopApi.openTopUp(), '无法打开充值页面。')}>充值</CommandButton>
        <CommandButton icon={RefreshCw} disabled={busy} onClick={() => run(async () => {}, '刷新失败。')}>刷新余额</CommandButton>
        <CommandButton icon={LogOut} disabled={busy} onClick={() => run(() => desktopApi.logoutAccount(), '退出失败。')}>退出登录</CommandButton>
      </div>
      {options.length ? (
        <div className="account-tiers">
          {[['reasoning', '推理与代码'], ['writing', '文本']].map(([key, label]) => (
            <label key={key}>
              <span>{label}档位</span>
              <select
                value={activeTiers?.[key] || state.defaultTiers?.[key] || ''}
                onChange={(event) => onTierChange?.(key, event.target.value)}
              >
                {options.map((tier) => <option key={tier.id} value={tier.id}>{tier.label || tier.id}</option>)}
              </select>
            </label>
          ))}
        </div>
      ) : null}
      <span className="settings-save-message" role="status">{message}</span>
    </section>
  );
}
