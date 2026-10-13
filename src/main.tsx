import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from './ui/Shell';
import { createBrowserSession } from './net/browser';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
const session = createBrowserSession();
createRoot(root).render(
  <StrictMode>
    <Shell session={session} />
  </StrictMode>,
);
