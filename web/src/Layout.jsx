import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api, setToken } from './api.js';
import { Aurora, CursorFX } from './fx.jsx';

// ---- toasts ------------------------------------------------------------------------------
const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

function Toasts({ items }) {
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast-in pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium shadow-[0_18px_40px_-18px_rgba(0,0,0,0.5)] ${
            t.tone === 'error' ? 'bg-[#8a1c12] text-white' : 'bg-[#1a2330] text-ink border border-line'
          }`}
        >
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${t.tone === 'error' ? 'bg-[#ffb4a8]' : 'bg-[#7fd1cb]'}`} />
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---- icons (inline stroke SVG) ----------------------------------------------------------------
const Icon = ({ d }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
const icons = {
  devices: <Icon d={<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M2 20h20" /></>} />,
  fleet: <Icon d={<><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></>} />,
  out: <Icon d={<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></>} />,
  db: <Icon d={<><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>} />,
};

export function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [me, setMe] = useState(null);
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    api.get('/me').then((r) => setMe(r.data)).catch(() => {});
  }, []);

  const toast = useCallback((text, tone = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  const link = ({ isActive }) =>
    `group flex min-h-11 items-center gap-3 rounded-xl px-3 text-[15px] no-underline transition-all duration-200 ${
      isActive ? 'bg-white/12 font-semibold text-white shadow-[inset_0_0_0_1px_rgba(127,209,203,0.35)]' : 'text-[#c9cccf] hover:bg-white/6 hover:text-white'
    }`;

  const signOut = () => {
    setToken(null);
    navigate('/login');
  };

  return (
    <ToastContext.Provider value={toast}>
      <div className="min-h-screen lg:pl-64">
        <Aurora />
        <CursorFX />

        {/* Sidebar on large screens, top bar on small ones */}
        <aside className="brand-bar z-40 flex items-center gap-4 px-4 py-3 text-ink lg:fixed lg:inset-y-0 lg:left-0 lg:w-64 lg:flex-col lg:items-stretch lg:gap-8 lg:px-4 lg:py-7">
          <NavLink to="/" className="wordmark px-3 text-2xl font-bold tracking-tight no-underline">
            DevicePulse
          </NavLink>
          <nav aria-label="Main" className="flex flex-grow gap-1 lg:flex-col">
            <NavLink to="/" end className={link}>
              {icons.fleet}
              <span className="hidden sm:inline">Dashboard</span>
            </NavLink>
            <NavLink to="/devices" className={link}>
              {icons.devices}
              <span className="hidden sm:inline">Devices</span>
            </NavLink>
            <NavLink to="/monitoring" className={link}>
              {icons.db}
              <span className="hidden sm:inline">How it works</span>
            </NavLink>
            <NavLink to="/fleet" className={link}>
              {icons.fleet}
              <span className="hidden sm:inline">Fleet demo</span>
            </NavLink>
          </nav>
          <div className="hidden flex-col gap-3 rounded-2xl bg-white/6 p-4 text-sm lg:flex">
            <div className="truncate font-medium text-white" title={me?.email}>
              {me?.email ?? '…'}
            </div>
            <div className="flex items-center gap-2 text-xs text-[#c9cccf]">
              {icons.db}
              Database: <span className="font-semibold uppercase tracking-wide text-[#7fd1cb]">{me?.database ?? '…'}</span>
            </div>
          </div>
          <button onClick={signOut} className="press flex min-h-11 items-center gap-2 rounded-xl border border-white/15 px-3 text-sm text-ink hover:bg-white/8">
            {icons.out}
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </aside>

        <main key={location.pathname} className="page-enter mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-8 lg:py-10">
          <Outlet />
        </main>
        <Toasts items={toasts} />
      </div>
    </ToastContext.Provider>
  );
}
