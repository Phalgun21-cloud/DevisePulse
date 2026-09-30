import axios from 'axios';

const TOKEN_KEY = 'devicepulse.token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: the session just will not survive a reload */
  }
}

export const api = axios.create({ baseURL: '/api', timeout: 60_000 });

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// An expired or invalid session sends the user back to the sign-in page.
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && !err.config.url.startsWith('/auth/')) {
      setToken(null);
      if (window.location.pathname !== '/login') window.location.assign('/login');
    }
    return Promise.reject(err);
  },
);

export function errorText(err) {
  const code = err?.response?.data?.error;
  const messages = {
    invalid_credentials: 'That email and password do not match.',
    email_taken: 'An account with that email already exists. Sign in instead.',
    invalid_request: 'Please check the form: email must be valid and the password at least 8 characters.',
    rate_limited: 'Too many requests. Wait a minute and try again.',
    not_found: 'Not found.',
  };
  if (messages[code]) return messages[code];
  if (err?.code === 'ERR_NETWORK') return 'Cannot reach the DevicePulse API. Is the server running?';
  return 'Something went wrong. Try again.';
}

// The address an agent should upload to. In dev the API is on :4000 behind Vite's proxy.
export function apiOrigin() {
  const { origin, port } = window.location;
  return port === '5173' ? origin.replace(':5173', ':4000') : origin;
}
