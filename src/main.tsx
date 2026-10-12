import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from './ui/Shell';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
