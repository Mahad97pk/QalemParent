/**
 * Barebones visual-editor boot gate (`QALEM_MINIMAL`).
 *
 * Phase 1: when enabled, App skips onboarding/dashboard and shows a blank
 * `minimal-workspace` placeholder. The shell itself is Phase 2+.
 *
 * @module lib/minimal
 */

import { invoke } from '@tauri-apps/api/core';

export interface MinimalMode {
  enabled: boolean;
  /** Absolute path from `QALEM_MINIMAL_PROJECT`, if set. */
  projectPath: string | null;
}

/** Read the minimal-mode boot flag from the backend (env vars at process start). */
export async function getMinimalMode(): Promise<MinimalMode> {
  const result = await invoke<{ enabled: boolean; projectPath: string | null }>('get_minimal_mode');
  return {
    enabled: result.enabled,
    projectPath: result.projectPath,
  };
}
