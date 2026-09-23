import { useState } from 'react';
import { api, auth } from '../lib/api';
import { Button } from '../components/ui';

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.login(username.trim(), password);
      auth.set(res.token);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-[380px]">
        {/* Terminal-style identity block, not a logo lockup */}
        <div className="mb-3 flex items-center gap-2.5">
          <div
            className="grid place-items-center bg-accent font-[family-name:var(--font-label)]
                       text-[15px] font-bold text-[#17130a]"
            style={{ height: 30, width: 30 }}
          >
            C
          </div>
          <div className="leading-none">
            <div className="label-lg">Corvex</div>
            <div className="label mt-1" style={{ fontSize: 9.5 }}>
              Corrosion Integrity Console
            </div>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5">
            <span className="lamp text-normal" />
            <span className="label" style={{ fontSize: 9 }}>Online</span>
          </div>
        </div>

        <div className="bracket px-6 py-6">
          <form onSubmit={submit}>
            <label className="mb-3.5 block">
              <span className="label">Operator ID</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                placeholder="supervisor1"
                className={FIELD}
              />
            </label>
            <label className="mb-4 block">
              <span className="label">Passcode</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className={FIELD}
              />
            </label>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Authenticating…' : 'Sign in'}
            </Button>
            {error && (
              <p className="mt-3 flex items-center gap-2 text-[12px] text-critical">
                <span className="lamp lamp-critical" />
                {error}
              </p>
            )}
          </form>

          <div className="mt-5 border-t border-line-soft pt-3.5">
            <div className="label mb-2">Demo accounts</div>
            <table className="w-full border-collapse">
              <tbody className="num text-[10.5px] text-dim">
                {[
                  ['inspector1', 'inspect123', 'Western zone only'],
                  ['supervisor1', 'supervise123', '+ fleet, scheduler'],
                  ['admin', 'admin123', 'full access'],
                ].map(([u, p, scope]) => (
                  <tr key={u}>
                    <td className="py-[2px] pr-3 text-ink">{u}</td>
                    <td className="py-[2px] pr-3">{p}</td>
                    <td className="py-[2px] text-right">{scope}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[10px] leading-relaxed text-dim">
              Demo credentials — this is a class project, not production auth.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

const FIELD =
  'num mt-1.5 w-full border border-line bg-bg px-3 py-2 text-[13px] text-ink outline-none ' +
  'placeholder:text-dim focus:border-accent';
