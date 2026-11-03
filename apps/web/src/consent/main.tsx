import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConsentPage } from './ConsentPage';
import './consent.css';

/*
 * The driver's consent page (/consent/#token=…, owner brief 2026-10-11). Its own small entry like
 * dot.html: no router, no session, no TMS bundle. The token rides in the fragment, so it never
 * reaches a server log.
 */
const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const insecure = window.location.protocol === 'http:' && !local && !/^\d+\.\d+\.\d+\.\d+$/.test(window.location.hostname);
if (insecure) window.location.replace(`https://${window.location.host}${window.location.pathname}${window.location.hash}`);

const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
// The token stays in the address bar (owner, 2026-10-14): removing it made a refresh, or a link
// copied from the address bar and sent on, open as "not valid". The fragment still never reaches
// a server.
const token = fragment.get('token') ?? '';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

if (!insecure) createRoot(container).render(
  <StrictMode>
    <ConsentPage token={token} />
  </StrictMode>,
);
