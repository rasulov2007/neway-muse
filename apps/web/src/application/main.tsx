import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './app';
import './application.css';

/*
 * The driver's DOT application v2 (/application/#token=…). Its own small entry: no router, no TMS
 * bundle, no account. The token stays in the fragment (a refresh or a copied address keeps
 * working, and it never reaches a server log); nothing personal is ever put in the address.
 */
const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const insecure = window.location.protocol === 'http:' && !local && !/^\d+\.\d+\.\d+\.\d+$/.test(window.location.hostname);
if (insecure) window.location.replace(`https://${window.location.host}${window.location.pathname}${window.location.hash}`);

const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token') ?? '';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

if (!insecure)
  createRoot(container).render(
    <StrictMode>
      <Root token={token} />
    </StrictMode>,
  );
