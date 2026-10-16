import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

async function bootstrap() {
  if (import.meta.env.DEV || import.meta.env.VITE_MOCK === '1') {
    const { setupMocks } = await import('./mocks/browser');
    await setupMocks();
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

bootstrap();

