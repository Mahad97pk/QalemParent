/**
 * Phase 2 — barebones visual editor shell.
 *
 * Mounted only under `QALEM_MINIMAL=1` (see `App.tsx`). Reuses the same
 * hooks and panels the full `Preview`/`WorkspaceView` stack uses — the CSS
 * Mode cascade editor (`useCssCascadeEditor` + `CssCascadePanel`), the
 * element navigator (`useElementTree` + `ElementTreePanel`), and the
 * CodeMirror-based `CodeOverlayEditor` — but skips the dev-server session
 * registry, terminal tabs, GitHub/branches, screenshots, and plugin
 * machinery `useProjectLifecycle` normally orchestrates. This component owns
 * its own (much smaller) startup sequence: reserve a port, start the dev
 * server, connect the preview, done.
 *
 * Layout (per the spec): DOM tree left, live preview + dual HTML/CSS code
 * editor center, CSS styles panel right. Drag and drop is explicitly out of
 * scope for this phase.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDevServer } from '../../hooks/useDevServer';
import { usePreviewConnection } from '../../hooks/usePreviewConnection';
import { useCssCascadeEditor } from '../../hooks/useCssCascadeEditor';
import { useTextEditing } from '../../hooks/useTextEditing';
import { useElementTree } from '../../hooks/useElementTree';
import { useElementSettings } from '../../hooks/useElementSettings';
import { useCssVariables } from '../../hooks/useCssVariables';
import { useCssAnimations } from '../../hooks/useCssAnimations';
import { ElementTreePanel } from './ElementTreePanel';
import { CssCascadePanel } from './CssCascadePanel';
import { CodeOverlayEditor } from './CodeOverlayEditor';
import { findAndReservePort, getWindowLabel } from '../../lib/window';
import { basename } from '../../lib/paths';
import { listProjectFiles, readProjectFile, saveProjectFile } from '../../lib/code';
import { logger } from '../../lib/logger';

/** Only used the first time a project opens in minimal mode; the OS picks a
 *  real free port around this if it's taken (see `findAndReservePort`). */
const PREFERRED_PORT = 4173;
/** Quiet period after the last keystroke before a code-editor change writes
 *  to disk — matches the debounce feel of the cascade editor's autosave. */
const SAVE_DEBOUNCE_MS = 500;
/** Quiet period before a keystroke in the HTML editor is mirrored into the
 *  live preview. Much shorter than the disk-save debounce — this is a local
 *  DOM patch, not a file write, so it can run far more often. */
const LIVE_PREVIEW_DEBOUNCE_MS = 80;

interface Props {
  projectPath: string;
}

export function MinimalWorkspace({ projectPath }: Props) {
  const projectName = basename(projectPath);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // ── Tiny inline toast, no ToastProvider — keeps this shell dependency-free. ──
  const [toast, setToast] = useState<{ message: string; type?: 'success' | 'error' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const onToast = useCallback((message: string, type?: 'success' | 'error') => {
    setToast({ message, type });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  // ── Minimal startup: reserve a port, start the dev/static server. No session ──
  // registry, no hot-session reuse, no terminal tabs — this component only ever
  // opens one project, once, for the life of the window.
  const devServer = useDevServer(projectPath);
  const [starting, setStarting] = useState(true);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const port = await findAndReservePort(projectPath, PREFERRED_PORT);
        await devServer.startServerForProject(projectPath, projectName, port, getWindowLabel());
        if (!cancelled) setStarting(false);
      } catch (err) {
        logger.error('[MinimalWorkspace] failed to start server', { error: err });
        if (!cancelled) {
          setStartError(err instanceof Error ? err.message : String(err));
          setStarting(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally runs once — projectPath is fixed for this component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const conn = usePreviewConnection({
    port: devServer.devServerPort,
    projectPath,
    isDevServerRestarting: devServer.isRestartingDevServer,
    isStaticProject: devServer.projectType === 'statichtml',
    onToast,
  });

  // ── CSS Mode editor (plain HTML/CSS + vanilla Astro/Next). Always the mode ──
  // here — MinimalWorkspace has no Tailwind path and no mode toggle.
  const cssEditorEnabled = conn.serverReady;
  const cssEditor = useCssCascadeEditor({
    iframeRef,
    projectPath,
    enabled: cssEditorEnabled,
    onToast,
  });
  // No separate "enter edit mode" button in this shell — the CSS panel is
  // always the point, so turn it on as soon as the preview can support it.
  useEffect(() => {
    if (cssEditorEnabled && !cssEditor.editMode) cssEditor.toggleEditMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cssEditorEnabled]);

  // ── Inline canvas text editing (double-click a text node in the preview). ──
  // In the full app this is mounted once in Preview.tsx alongside the styling
  // editor, "active whenever either editor's edit mode is on" (per the hook's
  // own docstring) — it was missing here entirely, which is why double-click
  // text edits changed the iframe locally but never reached disk (and so
  // never showed up back in the HTML code editor below: nothing had written
  // the file, so there was nothing new to sync). We don't use its return
  // values (`textResolution`/`textBlockedNonce` just drive optional UI hints
  // in the full app's panel) — we only need it mounted for the side effect:
  // it owns the `ss:textCommit` listener that calls `applyTextEdit`.
  useTextEditing({
    iframeRef,
    projectPath,
    enabled: cssEditor.editMode,
    onToast,
  });

  // ── Force-reload the preview when `conn.reloadToken` bumps — but only when ──
  // the write behind it is one we don't already know about. `reloadToken`
  // bumps on EVERY file-watcher event, including ones we caused ourselves
  // (a code-editor save, or a canvas text commit) — and for those, the
  // on-screen content is already correct (via the live patch below, or the
  // canvas's own optimistic edit), so reloading is pure redundant flicker,
  // not a real update. `skipNextReloadUntilRef` is a short grace window we
  // arm right before/around a self-caused write; if the next bump lands
  // inside it, we treat it as "ours" and skip the reload once. A genuine
  // external change (edited in another editor, git, etc.) arrives outside
  // any grace window and still gets the real reload below.
  //
  // This is deliberately a time window, not a precise 1:1 credit count: if
  // two self-writes land close together and the watcher coalesces them into
  // one bump, the worst case is a redundant reload slips through — never a
  // missed *external* one, since we only ever skip inside a window we
  // ourselves armed.
  const skipNextReloadUntilRef = useRef(0);
  const SELF_WRITE_GRACE_MS = 3000;
  const armSelfWriteGrace = useCallback(() => {
    skipNextReloadUntilRef.current = Date.now() + SELF_WRITE_GRACE_MS;
  }, []);

  const prevReloadTokenRef = useRef(0);
  useEffect(() => {
    if (conn.reloadToken === prevReloadTokenRef.current) return;
    prevReloadTokenRef.current = conn.reloadToken;
    if (conn.reloadToken === 0) return;
    if (Date.now() < skipNextReloadUntilRef.current) {
      skipNextReloadUntilRef.current = 0; // consumed — next bump gets the normal check again
      return;
    }
    if (!iframeRef.current || !conn.serverReady) return;
    const refreshUrl = conn.currentUrl;
    iframeRef.current.src = 'about:blank';
    setTimeout(() => {
      if (iframeRef.current) iframeRef.current.src = refreshUrl;
    }, 100);
  }, [conn.reloadToken, conn.serverReady, conn.currentUrl]);

  // Canvas text commits go through `useTextEditing` above, which we don't
  // own — so we can't hook a "write succeeded" callback into it directly.
  // Instead we listen for the same `ss:textCommit` message ourselves (same
  // origin check `useTextEditing` uses) purely to arm the grace window. If
  // the write actually fails (reverted), no file-watcher bump follows it
  // anyway, so the armed window just expires unused — harmless.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as { type?: string } | null;
      if (d?.type === 'ss:textCommit') armSelfWriteGrace();
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [armSelfWriteGrace]);

  const elementSettings = useElementSettings({
    iframeRef,
    projectPath,
    enabled: cssEditorEnabled,
    signature: cssEditor.selection?.signature ?? null,
    onToast,
  });
  const cssVariables = useCssVariables({
    iframeRef,
    projectPath,
    enabled: cssEditor.editMode,
    onToast,
  });
  const cssAnimations = useCssAnimations({
    projectPath,
    enabled: cssEditor.editMode,
    onToast,
  });
  // `enabled` must track when the iframe actually exists, not just "always
  // true": the iframe below is only mounted once `conn.serverReady` flips to
  // true (before that we render a CenteredMessage instead), so `iframeRef`
  // is still null on the render where this hook's effect first runs. With a
  // hardcoded `enabled: true` that effect never re-fires once the iframe
  // shows up (its deps don't include serverReady), so `ss:requestTree` is
  // never (re)posted and the tree panel is stuck on "Loading elements…".
  // Tying `enabled` to `serverReady` makes the effect re-run right as the
  // iframe mounts, matching how Preview.tsx drives the same hook.
  const elementTree = useElementTree({ iframeRef, enabled: conn.serverReady });

  // ── Dual code editor: the project's first HTML file (index.* preferred) and ──
  // first CSS file. Good enough for a single-page barebones project; a project
  // with several HTML/CSS files just gets whichever sorts first.
  const [htmlPath, setHtmlPath] = useState<string | null>(null);
  const [cssPath, setCssPath] = useState<string | null>(null);
  const [htmlText, setHtmlText] = useState('');
  const [cssText, setCssText] = useState('');
  const [filesLoading, setFilesLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const entries = await listProjectFiles(projectPath);
        const files = entries.filter((e) => !e.isDirectory);
        const html =
          files.find((e) => /(^|\/)index\.html?$/i.test(e.path)) ??
          files.find((e) => /\.html?$/i.test(e.path));
        const css = files.find((e) => /\.css$/i.test(e.path));
        if (cancelled) return;
        setHtmlPath(html?.path ?? null);
        setCssPath(css?.path ?? null);
        if (html) setHtmlText((await readProjectFile(projectPath, html.path)).content);
        if (css) setCssText((await readProjectFile(projectPath, css.path)).content);
      } catch (err) {
        logger.error('[MinimalWorkspace] failed to load project files', { error: err });
        onToast('Could not read project files', 'error');
      } finally {
        if (!cancelled) setFilesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  // ── Re-sync the code editors after an EXTERNAL change (canvas text edit, ──
  // CSS cascade panel edit) lands on disk. Both editors only ever loaded
  // their file once, at mount — any write that didn't come from typing in
  // that same editor (e.g. a double-click text commit from the canvas, or a
  // style edit from the CSS panel) left them silently stale. `dirtyRef`
  // guards against the reverse problem: while the user is actively typing
  // and a save is still debounced, disk is briefly behind local state, and
  // syncing from disk at that exact moment would overwrite in-progress
  // keystrokes with the older saved version.
  const htmlDirtyRef = useRef(false);
  const cssDirtyRef = useRef(false);
  useEffect(() => {
    if (conn.reloadToken === 0) return;
    if (!htmlPath && !cssPath) return;
    void (async () => {
      try {
        if (htmlPath && !htmlDirtyRef.current) {
          const fresh = (await readProjectFile(projectPath, htmlPath)).content;
          setHtmlText((prev) => (fresh !== prev ? fresh : prev));
        }
        if (cssPath && !cssDirtyRef.current) {
          const fresh = (await readProjectFile(projectPath, cssPath)).content;
          setCssText((prev) => (fresh !== prev ? fresh : prev));
        }
      } catch (err) {
        logger.error('[MinimalWorkspace] failed to resync files after external edit', {
          error: err,
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.reloadToken]);

  const htmlSaveTimer = useRef<number | null>(null);
  const cssSaveTimer = useRef<number | null>(null);

  // ── Instant canvas preview while typing HTML. ──
  // Patches `document.body.innerHTML` directly inside the iframe over
  // `postMessage`, bypassing the file-write → watcher → reload round trip
  // entirely for the common case (editing content inside <body>). The
  // injected select-script lands before `</head>` (see
  // `src-tauri/src/proxy/html.rs::inject_into_html`), so it survives a
  // body-only replace. If the edit also touches <head> (new <script>,
  // <link>, meta tags, etc.) a live patch can't reflect that — the code
  // below detects a changed head and skips the live patch for that
  // keystroke, falling back to the normal debounced save + full reload path,
  // which handles head changes correctly. Known limitation either way: the
  // replaced body nodes are new DOM elements, so the current selection
  // highlight box can lag until the next click — cosmetic, not a data issue.
  //
  // Requires matching `ss:previewHtml` / `ss:previewCss` handlers in
  // `src-tauri/src/proxy/select_script.html` — see chat for the patch.
  //
  // `htmlPatchAppliedRef` tracks whether the most recent attempt actually
  // patched the iframe (true) or bailed because <head> changed (false) — the
  // upcoming save's success handler reads this to decide whether it's safe
  // to arm the reload-suppression grace window. A head change still needs
  // the real reload, so we must NOT suppress it.
  const lastHeadRef = useRef<string | null>(null);
  const htmlPatchAppliedRef = useRef(false);
  const livePreviewTimer = useRef<number | null>(null);
  const postLivePreview = useCallback((fullHtml: string) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    let doc: Document;
    try {
      doc = new DOMParser().parseFromString(fullHtml, 'text/html');
    } catch {
      return;
    }
    const head = doc.head?.innerHTML ?? '';
    if (lastHeadRef.current === null) {
      lastHeadRef.current = head; // first run — nothing to compare against yet
    } else if (head !== lastHeadRef.current) {
      lastHeadRef.current = head;
      htmlPatchAppliedRef.current = false;
      return; // head changed — let the debounced save + full reload handle it
    }
    htmlPatchAppliedRef.current = true;
    iframe.contentWindow.postMessage(
      { type: 'ss:previewHtml', html: doc.body?.innerHTML ?? '' },
      '*'
    );
  }, []);

  // CSS code-editor live preview: a single override <style> tag in the
  // iframe's <head>, replaced wholesale on every keystroke (short debounce).
  // Simpler than trying to reuse the cascade panel's per-rule engine, and
  // good enough for "show me what I just typed" — precedence follows normal
  // cascade order (it's appended last, so it wins ties against the linked
  // stylesheet, same as you'd expect). The real saved file is still the
  // source of truth once persisted; this is only ever a preview.
  const cssLivePreviewTimer = useRef<number | null>(null);
  const postCssLivePreview = useCallback((css: string) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage({ type: 'ss:previewCss', css }, '*');
  }, []);

  const onHtmlChange = useCallback(
    (value: string) => {
      setHtmlText(value);
      htmlDirtyRef.current = true;

      if (livePreviewTimer.current) window.clearTimeout(livePreviewTimer.current);
      livePreviewTimer.current = window.setTimeout(() => {
        postLivePreview(value);
      }, LIVE_PREVIEW_DEBOUNCE_MS);

      if (!htmlPath) return;
      if (htmlSaveTimer.current) window.clearTimeout(htmlSaveTimer.current);
      htmlSaveTimer.current = window.setTimeout(() => {
        // Read now, not inside .then() — by the time the save resolves, a
        // later keystroke could already be mid-flight toward a different verdict.
        const patchApplied = htmlPatchAppliedRef.current;
        void saveProjectFile(projectPath, htmlPath, value)
          .then(() => {
            htmlDirtyRef.current = false;
            if (patchApplied) armSelfWriteGrace();
          })
          .catch((err) => {
            onToast('Failed to save HTML file', 'error');
            logger.error('[MinimalWorkspace] html save failed', { error: err });
          });
      }, SAVE_DEBOUNCE_MS);
    },
    [htmlPath, projectPath, onToast, postLivePreview, armSelfWriteGrace]
  );

  const onCssChange = useCallback(
    (value: string) => {
      setCssText(value);
      cssDirtyRef.current = true;

      if (cssLivePreviewTimer.current) window.clearTimeout(cssLivePreviewTimer.current);
      cssLivePreviewTimer.current = window.setTimeout(() => {
        postCssLivePreview(value);
      }, LIVE_PREVIEW_DEBOUNCE_MS);

      if (!cssPath) return;
      if (cssSaveTimer.current) window.clearTimeout(cssSaveTimer.current);
      cssSaveTimer.current = window.setTimeout(() => {
        void saveProjectFile(projectPath, cssPath, value)
          .then(() => {
            cssDirtyRef.current = false;
            armSelfWriteGrace();
          })
          .catch((err) => {
            onToast('Failed to save CSS file', 'error');
            logger.error('[MinimalWorkspace] css save failed', { error: err });
          });
      }, SAVE_DEBOUNCE_MS);
    },
    [cssPath, projectPath, onToast, postCssLivePreview, armSelfWriteGrace]
  );

  useEffect(
    () => () => {
      if (htmlSaveTimer.current) window.clearTimeout(htmlSaveTimer.current);
      if (cssSaveTimer.current) window.clearTimeout(cssSaveTimer.current);
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (livePreviewTimer.current) window.clearTimeout(livePreviewTimer.current);
      if (cssLivePreviewTimer.current) window.clearTimeout(cssLivePreviewTimer.current);
    },
    []
  );

  if (starting) {
    return <CenteredMessage text={`Starting ${projectName}…`} />;
  }
  if (startError) {
    return <CenteredMessage text={`Failed to start dev server: ${startError}`} isError />;
  }

  return (
    <div className="ss-minimal-workspace">
      {toast && (
        <div className={`ss-minimal-toast ss-minimal-toast--${toast.type ?? 'info'}`}>
          {toast.message}
        </div>
      )}

      <div className="ss-minimal-tree">
        <ElementTreePanel
          tree={elementTree.tree}
          truncated={elementTree.truncated}
          selectedId={elementTree.selectedId}
          onSelect={elementTree.selectNode}
          onHover={elementTree.hoverNode}
          projectPath={projectPath}
          selectedSignature={cssEditor.selection?.signature ?? null}
        />
      </div>

      <div className="ss-minimal-center">
        <div className="ss-minimal-preview">
          {conn.serverReady ? (
            <iframe
              ref={iframeRef}
              src={conn.currentUrl}
              className="ss-minimal-iframe"
              title="Preview"
              onLoad={conn.handleIframeLoad}
            />
          ) : (
            <CenteredMessage
              text={conn.hasError ? 'Preview server is not responding.' : 'Loading preview…'}
              isError={conn.hasError}
            />
          )}
        </div>
        <div className="ss-minimal-code">
          <div className="ss-minimal-code-pane">
            <div className="ss-minimal-code-label">{htmlPath ?? 'No HTML file found'}</div>
            <CodeOverlayEditor
              value={htmlText}
              onChange={onHtmlChange}
              lang="html"
              placeholder={filesLoading ? 'Loading…' : undefined}
            />
          </div>
          <div className="ss-minimal-code-pane">
            <div className="ss-minimal-code-label">{cssPath ?? 'No CSS file found'}</div>
            <CodeOverlayEditor
              value={cssText}
              onChange={onCssChange}
              lang="css"
              placeholder={filesLoading ? 'Loading…' : undefined}
            />
          </div>
        </div>
      </div>

      <div className="ss-minimal-css">
        {cssEditor.editMode ? (
          <CssCascadePanel
            selection={cssEditor.selection}
            rows={cssEditor.rows}
            loading={cssEditor.loading}
            bodies={cssEditor.bodies}
            overridden={cssEditor.overridden}
            onChangeBody={cssEditor.setBody}
            onDeleteRule={(key) => void cssEditor.deleteRule(key)}
            onWrapRule={(key, at) => void cssEditor.wrapRule(key, at)}
            onRenameRule={(key, sel) => void cssEditor.renameSelector(key, sel)}
            onRenameAtRule={(key, m) => void cssEditor.renameAtRule(key, m)}
            onAddSelector={(sel) => void cssEditor.addSelector(sel)}
            selectorSuggestions={cssEditor.classSuggestions.map((c) => `.${c}`)}
            existingSelectors={cssEditor.existingSelectors}
            variables={cssEditor.variableSuggestions}
            animations={cssEditor.animationSuggestions}
            justCreatedKey={cssEditor.justCreatedKey}
            settings={elementSettings}
            variablesState={cssVariables}
            animationsState={cssAnimations}
            onClose={() => {
              /* No-op: this shell has no separate edit-mode toggle to close into. */
            }}
            pinned
          />
        ) : (
          <CenteredMessage text="Select an element in the preview to edit its styles." />
        )}
      </div>
    </div>
  );
}

function CenteredMessage({ text, isError }: { text: string; isError?: boolean }) {
  return (
    <div className={`ss-minimal-centered${isError ? ' ss-minimal-centered--error' : ''}`}>
      {text}
    </div>
  );
}
