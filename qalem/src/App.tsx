/**
 * Main application entry point.
 *
 * Qalem is a barebones dual visual/code editor for a single HTML+CSS
 * project — it boots straight into MinimalWorkspace. There is no
 * dashboard, onboarding flow, or multi-project shell.
 *
 * @module App
 */

import { useState, useEffect } from 'react';
import { logger } from './lib/logger';
import { getMinimalMode } from './lib/minimal';
import { MinimalWorkspace } from './components/edit/MinimalWorkspace';
import { BootLoadingScreen } from './components/BootLoadingScreen';
import './styles/index.css';

// Boot-path guard: a throw at module scope would leave a black window,
// since this runs before ErrorBoundary exists. Logger init must never
// prevent React from mounting.
try {
  logger.init();
} catch (err) {
  console.error('[Qalem] Module-scope init failed', err);
}

interface AppProps {
  /** Initial project path from URL parameter (for multi-window support) */
  initialProjectPath?: string | null;
}

function App({ initialProjectPath }: AppProps) {
  const [projectPath, setProjectPath] = useState<string | null>(initialProjectPath ?? null);
  const [checking, setChecking] = useState(!initialProjectPath);

  useEffect(() => {
    if (initialProjectPath) return;
    let cancelled = false;
    void getMinimalMode()
      .then((mode) => {
        if (!cancelled) setProjectPath(mode.projectPath);
      })
      .catch((err) => {
        logger.warn('[App] get_minimal_mode failed', { error: String(err) });
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialProjectPath]);

  if (checking) {
    return <BootLoadingScreen />;
  }

  if (!projectPath) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-primary)',
          color: 'var(--text-secondary)',
          fontSize: 'var(--font-size-sm)',
        }}
      >
        No QALEM_MINIMAL_PROJECT set — point it at a project folder to open.
      </div>
    );
  }

  return <MinimalWorkspace projectPath={projectPath} />;
}

export default App;
