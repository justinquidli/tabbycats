import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// After a deploy, an open tab can ask for code files that no longer exist. Reload once to pick up the new version.
window.addEventListener('vite:preloadError', () => {
  try {
    if (sessionStorage.getItem('tabbycats:reloaded')) return;
    sessionStorage.setItem('tabbycats:reloaded', '1');
  } catch {
    /* ignore */
  }
  window.location.reload();
});
try {
  setTimeout(() => sessionStorage.removeItem('tabbycats:reloaded'), 10000);
} catch {
  /* ignore */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
