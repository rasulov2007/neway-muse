import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider, TooltipProvider } from '@/design-system';
import { tokenFromPath } from './api';
import { DotPage } from './DotPage';
import './dot.css';

/*
 * The DOT application a recruiter sends to the driver (/dot/<token>). Its own small entry, like
 * apply.html and care.html: no router, no session, no TMS bundle. The token in the address is
 * the only key; nothing is written to the browser's storage.
 */
// The token is the key to a person's application: never over plain http, except on this computer.
const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const insecure = window.location.protocol === 'http:' && !local;
if (insecure) window.location.replace(`https://neway.example.com${window.location.pathname}`);

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

if (!insecure) createRoot(container).render(
  <StrictMode>
    <TooltipProvider>
      <ToastProvider>
        <DotPage token={tokenFromPath(window.location.pathname)} />
      </ToastProvider>
    </TooltipProvider>
  </StrictMode>,
);
