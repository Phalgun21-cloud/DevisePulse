import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import './index.css';
import { Layout } from './Layout.jsx';
import { getToken } from './api.js';
import Login from './pages/Login.jsx';
import Devices from './pages/Devices.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Monitoring from './pages/Monitoring.jsx';
import DeviceDetail from './pages/DeviceDetail.jsx';
import Diagnose from './pages/Diagnose.jsx';
import Fleet from './pages/Fleet.jsx';

function RequireAuth({ children }) {
  return getToken() ? children : <Navigate to="/login" replace />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<Dashboard />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/monitoring" element={<Monitoring />} />
          <Route path="/devices/:id" element={<DeviceDetail />} />
          <Route path="/devices/:id/diagnose" element={<Diagnose />} />
          <Route path="/fleet" element={<Fleet />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
