import { NavLink, Outlet, useNavigate } from 'react-router';
import { setToken, getToken } from './api.js';

function email() {
  try {
    return JSON.parse(atob(getToken().split('.')[1])).email;
  } catch {
    return '';
  }
}

export function Layout() {
  const navigate = useNavigate();
  const link = ({ isActive }) =>
    `border-b-2 pb-1 no-underline ${isActive ? 'border-[#7fd1cb] font-semibold text-ground' : 'border-transparent text-[#c9cccf] hover:text-ground'}`;

  return (
    <div className="min-h-screen">
      <header className="bg-ink text-ground">
        <div className="mx-auto flex min-h-[68px] max-w-6xl flex-wrap items-center gap-x-8 gap-y-2 px-4 py-2 sm:px-8">
          <NavLink to="/" className="text-xl font-bold tracking-tight text-ground no-underline hover:text-ground">
            DevicePulse
          </NavLink>
          <nav aria-label="Main" className="flex gap-6 text-[15px]">
            <NavLink to="/" end className={link}>
              Devices
            </NavLink>
            <NavLink to="/fleet" className={link}>
              Fleet demo
            </NavLink>
          </nav>
          <div className="flex-grow" />
          <div className="hidden text-sm text-[#c9cccf] sm:block">{email()}</div>
          <button
            className="min-h-11 rounded-lg border border-[#5b6166] px-4 text-sm text-ground hover:bg-[#2a2d30]"
            onClick={() => {
              setToken(null);
              navigate('/login');
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-8">
        <Outlet />
      </main>
    </div>
  );
}
