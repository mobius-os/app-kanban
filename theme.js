export const CSS = `
  * { box-sizing: border-box; }
  ::selection { background: color-mix(in srgb, var(--accent) 28%, transparent); color: var(--text); }
  .kb-root {
    --kb-danger: color-mix(in srgb, #ef4444 55%, var(--text));
    --kb-warning: color-mix(in srgb, #f59e0b 52%, var(--text));
    --kb-success: color-mix(in srgb, #10b981 55%, var(--text));
    --kb-label-red: color-mix(in srgb, #ef4444 55%, var(--text));
    --kb-label-amber: color-mix(in srgb, #f59e0b 52%, var(--text));
    --kb-label-green: color-mix(in srgb, #10b981 55%, var(--text));
    --kb-label-blue: color-mix(in srgb, #3b82f6 55%, var(--text));
    --kb-label-purple: color-mix(in srgb, #8b5cf6 55%, var(--text));
    --kb-label-pink: color-mix(in srgb, #ec4899 55%, var(--text));
    min-height: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    color: var(--text);
    background: var(--bg);
    font-family: var(--font);
    overflow: hidden;
  }
  .kb-root :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .kb-root button, .kb-root input, .kb-root textarea { -webkit-tap-highlight-color: transparent; }
  .kb-root button { transition: background 120ms ease-out, border-color 120ms ease-out, color 120ms ease-out, transform 120ms ease-out, filter 120ms ease-out; }
  .kb-header {
    flex: 0 0 auto;
    min-height: 64px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px 8px;
    width: 100%;
  }
  .kb-board-header { white-space: nowrap; }
  .kb-header-spacer { flex: 1 1 auto; min-width: 0; }
  .kb-title-wrap { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .kb-title {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.01em;
    border: none;
    background: transparent;
    color: var(--text);
    font-family: var(--font);
    padding: 2px 4px;
    margin: -2px -4px;
    border-radius: 8px;
    width: 100%;
    min-width: 0;
    min-height: 44px;
  }
  .kb-title:focus { outline: none; }
  .kb-title:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; }
  .kb-title[readonly], .kb-col-name[readonly], .kb-input[readonly] { cursor: default; }
  .kb-title-static { margin: 0; font-size: 17px; line-height: 1.25; font-weight: 700; letter-spacing: -0.01em; }
  .kb-sub { font-size: 12px; line-height: 1.25; color: var(--muted); }
  .kb-home-heading { min-width: 0; flex: 1; display: flex; align-items: baseline; gap: 8px; }
  .kb-switcher-wrap { position: relative; min-width: 0; flex: 0 1 auto; }
  .kb-switcher-button {
    min-width: 0;
    min-height: 44px;
    max-width: min(52vw, 440px);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: none;
    border-radius: 10px;
    padding: 7px 9px;
    background: transparent;
    color: var(--text);
    font-family: var(--font);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.01em;
    cursor: pointer;
  }
  .kb-switcher-button > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kb-switcher-button > svg { width: 15px; height: 15px; flex: 0 0 auto; color: var(--muted); }
  .kb-switcher-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; }
  .kb-switcher-panel { gap: 10px; }
  .kb-switcher-title { font-size: 16px; font-weight: 650; background: var(--bg); }
  .kb-switcher-rows { display: flex; flex-direction: column; gap: 2px; }
  .kb-switcher-row {
    width: 100%;
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: 10px;
    border: none;
    border-radius: 10px;
    padding: 7px 10px;
    background: transparent;
    color: var(--text);
    font-family: var(--font);
    text-align: left;
    cursor: pointer;
  }
  .kb-switcher-row.kb-current { background: var(--surface-2); }
  .kb-switcher-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .kb-switcher-row > svg { width: 18px; height: 18px; flex: 0 0 auto; color: var(--accent); }
  .kb-switcher-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .kb-switcher-row-title { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kb-switcher-row-meta { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--muted); }
  .kb-shared-tag { padding: 1px 6px; border-radius: 999px; background: var(--bg); color: var(--muted); }
  .kb-switcher-new { margin-top: 2px; color: var(--muted); }
  .kb-switcher-new > svg { color: currentColor; }
  .kb-divider {
    width: calc(100% - 32px);
    margin: 0 auto;
    border-bottom: 1px solid var(--border);
  }
  .kb-board {
    flex: 1;
    display: flex;
    gap: 12px;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 14px 16px 18px;
    scroll-snap-type: x proximity;
    width: 100%;
    align-items: flex-start;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .kb-filterbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 16px 0;
  }
  .kb-filter-input { flex: 1 1 220px; min-width: 120px; }
  .kb-filter-labels { display: flex; align-items: center; gap: 2px; overflow-x: auto; flex: 0 1 auto; }
  .kb-filter-dot-btn {
    width: 44px;
    height: 44px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 12px;
    color: var(--muted);
    background: transparent;
    cursor: pointer;
  }
  .kb-filter-dot-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .kb-filter-dot-btn.kb-on { background: var(--surface-2); box-shadow: inset 0 0 0 2px var(--accent); }
  .kb-filter-dot { width: 16px; height: 16px; border-radius: 999px; display: block; }
  .kb-filter-dot.kb-none { background: var(--surface-2); border: 1px solid var(--border); position: relative; }
  .kb-filter-dot.kb-none::after {
    content: '';
    position: absolute;
    left: 7px;
    top: 1px;
    height: 12px;
    border-left: 2px solid var(--muted);
    transform: rotate(45deg);
  }
  .kb-col {
    flex: 0 0 auto;
    width: 300px;
    max-height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    scroll-snap-align: start;
  }
  .kb-col.kb-drop { border-color: var(--accent); }
  .kb-col-head {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 10px 10px 8px 14px;
  }
  .kb-col-status { width: 8px; height: 8px; border-radius: 999px; flex: 0 0 auto; }
  .kb-col-name {
    font-size: 14px;
    font-weight: 600;
    border: none;
    background: transparent;
    color: var(--text);
    font-family: var(--font);
    padding: 4px 6px;
    margin: -4px -6px;
    border-radius: 8px;
    flex: 1;
    min-width: 0;
    min-height: 44px;
  }
  .kb-col-name:focus { outline: none; }
  .kb-col-name:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; }
  .kb-count {
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    background: var(--surface-2);
    border-radius: 999px;
    padding: 2px 8px;
    min-width: 24px;
    text-align: center;
  }
  .kb-iconbtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    flex: 0 0 auto;
  }
  .kb-iconbtn > svg { width: 18px; height: 18px; }
  .kb-iconbtn:focus-visible { outline: 2px solid var(--accent); }
  .kb-iconbtn:disabled { opacity: 0.3; cursor: default; background: transparent; }
  .kb-backbtn { margin-left: -8px; }
  .kb-homebtn { margin-left: -8px; }
  .kb-filter-active { color: var(--accent); background: var(--surface-2); }
  .kb-col-actions, .kb-col-reorder { display: flex; align-items: center; gap: 0; }
  .kb-col-actions { margin-right: -6px; color: var(--muted); }
  .kb-col-action { position: relative; color: var(--muted); background: transparent; }
  .kb-col-action::before {
    content: '';
    position: absolute;
    width: 36px;
    height: 36px;
    border-radius: 9px;
  }
  .kb-col-action > svg { position: relative; z-index: 1; }
  .kb-col-action > svg { width: 16px; height: 16px; }
  .kb-chevron-right > svg { transform: rotate(180deg); }
  .kb-cards {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 2px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 8px;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .kb-board::-webkit-scrollbar, .kb-cards::-webkit-scrollbar { width: 7px; height: 7px; }
  .kb-board::-webkit-scrollbar-thumb, .kb-cards::-webkit-scrollbar-thumb { background: var(--border); border-radius: 999px; }
  .kb-board::-webkit-scrollbar-track, .kb-cards::-webkit-scrollbar-track { background: transparent; }
  .kb-card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 10px 12px;
    cursor: grab;
    touch-action: pan-x pan-y;
    user-select: none;
    -webkit-user-select: none;
    box-shadow: 0 1px 2px rgba(0,0,0,0.06);
    transition: box-shadow 120ms ease-out, transform 120ms ease-out;
    min-height: 44px;
  }
  .kb-card:active { cursor: grabbing; }
  .kb-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .kb-card.kb-readonly { cursor: pointer; }
  .kb-card-title { font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; }
  .kb-label { width: 34px; height: 4px; border-radius: 2px; margin-bottom: 7px; }
  .kb-card-meta { display: flex; align-items: center; gap: 8px; margin-top: 8px; min-width: 0; }
  .kb-card-meta-spacer { flex: 1 1 auto; min-width: 0; }
  .kb-avatar {
    width: 22px;
    height: 22px;
    flex: 0 0 22px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    line-height: 1;
    font-weight: 750;
    letter-spacing: 0.01em;
  }
  .kb-due { font-size: 11px; font-weight: 600; border-radius: 999px; padding: 3px 7px; }
  .kb-due-overdue { color: var(--kb-danger); background: color-mix(in srgb, #ef4444 13%, transparent); }
  .kb-due-today { color: var(--kb-warning); background: color-mix(in srgb, #f59e0b 14%, transparent); }
  .kb-due-upcoming { color: var(--muted); background: var(--surface-2); }
  .kb-check-progress { display: flex; align-items: center; gap: 5px; color: var(--muted); font-size: 11px; font-weight: 600; }
  .kb-progress-track { width: 50px; height: 3px; border-radius: 999px; overflow: hidden; background: var(--surface-2); }
  .kb-progress-fill { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
  .kb-card.kb-lifted { opacity: 0.35; }
  .kb-ghost {
    position: fixed;
    z-index: 50;
    pointer-events: none;
    transform: rotate(2.5deg);
    box-shadow: 0 12px 32px rgba(0,0,0,0.25);
    opacity: 0.95;
  }
  .kb-gap {
    border: 1.5px dashed var(--accent);
    border-radius: 12px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .kb-addcard {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 10px 10px;
    border: none;
    background: transparent;
    color: var(--muted);
    font-family: var(--font);
    font-size: 13px;
    font-weight: 500;
    padding: 10px 8px;
    border-radius: 12px;
    cursor: pointer;
    text-align: left;
    min-height: 44px;
  }
  .kb-addcard > svg, .kb-addcol > svg, .kb-btn > svg, .kb-newtile > svg { width: 18px; height: 18px; flex: 0 0 auto; }
  .kb-addcard:focus-visible { outline: 2px solid var(--accent); }
  .kb-composer { margin: 4px 10px 10px; display: flex; flex-direction: column; gap: 8px; }
  .kb-input {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 14px;
    padding: 10px 12px;
    resize: none;
    min-height: 44px;
  }
  .kb-input::placeholder { color: color-mix(in srgb, var(--text) 70%, var(--bg)); opacity: 1; }
  .kb-input:focus { outline: none; }
  .kb-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; border-color: transparent; }
  .kb-composer-row { display: flex; gap: 8px; }
  .kb-btn {
    border: none;
    border-radius: 10px;
    font-family: var(--font);
    font-size: 13px;
    font-weight: 600;
    padding: 8px 14px;
    cursor: pointer;
    min-height: 44px;
  }
  .kb-btn-compact { min-height: 36px; padding: 6px 12px; }
  .kb-btn:disabled { opacity: 0.45; cursor: default; }
  .kb-btn-primary { background: var(--accent); color: #fff; }
  .kb-btn-quiet { background: transparent; color: var(--muted); }
  .kb-btn-danger { background: #dc2626; color: #fff; }
  .kb-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .kb-addcol {
    flex: 0 0 auto;
    width: 220px;
    border: 1.5px dashed var(--border);
    border-radius: 16px;
    background: transparent;
    color: var(--muted);
    font-family: var(--font);
    font-size: 14px;
    font-weight: 500;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 18px 12px;
    cursor: pointer;
  }
  .kb-addcol:focus-visible { outline: 2px solid var(--accent); }
  .kb-empty {
    font-size: 12.5px;
    color: var(--muted);
    text-align: center;
    padding: 10px 8px 4px;
  }
  .kb-empty-left { padding: 0; text-align: left; }
  .kb-board-empty { align-items: center; justify-content: center; }
  .kb-empty-board-state {
    min-width: min(100%, 320px);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    color: var(--muted);
    text-align: center;
  }
  .kb-empty-board-title { font-size: 15px; font-weight: 650; color: var(--text); }
  .kb-empty-board-state .kb-btn { margin-top: 8px; display: inline-flex; align-items: center; gap: 7px; }
  .kb-scrim {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.35);
    z-index: 60;
  }
  .kb-sheet {
    position: fixed;
    left: 50%;
    bottom: 0;
    transform: translateX(-50%);
    width: min(100%, 560px);
    max-height: 84%;
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 20px 20px 0 0;
    z-index: 61;
    padding: 12px 16px calc(16px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: 16px;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .kb-sheet::-webkit-scrollbar, .kb-home::-webkit-scrollbar { width: 7px; height: 7px; }
  .kb-sheet::-webkit-scrollbar-thumb, .kb-home::-webkit-scrollbar-thumb { background: var(--border); border-radius: 999px; }
  .kb-sheet::-webkit-scrollbar-track, .kb-home::-webkit-scrollbar-track { background: transparent; }
  .kb-sheet-grab { width: 40px; height: 4px; border-radius: 2px; background: var(--border); margin: 0 auto; }
  .kb-sheet-row { display: flex; align-items: center; gap: 10px; }
  .kb-sheet-row-between { justify-content: space-between; }
  .kb-sheet h3 { margin: 0; font-size: 13px; font-weight: 600; color: var(--muted); }
  .kb-field-spaced { margin-top: 8px; }
  .kb-people-list { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
  .kb-person-name { min-width: 0; font-size: 13.5px; overflow-wrap: anywhere; }
  .kb-date-input { color-scheme: light dark; }
  .kb-checklist { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .kb-check-item { display: flex; align-items: center; gap: 6px; min-height: 44px; }
  .kb-check-toggle {
    min-width: 0;
    min-height: 44px;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    font-size: 13.5px;
    overflow-wrap: anywhere;
  }
  .kb-check-toggle input { width: 20px; height: 20px; flex: 0 0 auto; accent-color: var(--accent); }
  .kb-check-toggle input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .kb-check-toggle input:disabled { cursor: default; }
  .kb-check-done { color: var(--muted); text-decoration: line-through; }
  .kb-check-add { display: flex; align-items: center; gap: 8px; }
  .kb-swatches { display: flex; flex-wrap: wrap; gap: 10px; }
  .kb-swatch {
    width: 44px; height: 44px;
    border-radius: 999px;
    border: 2px solid transparent;
    cursor: pointer;
    padding: 0;
  }
  .kb-swatch.kb-on { border-color: var(--text); }
  .kb-swatch.kb-none { background: var(--surface-2); position: relative; }
  .kb-swatch.kb-none::after {
    content: '';
    position: absolute; inset: 6px 13px;
    transform: rotate(45deg);
    border-left: 2px solid var(--muted);
  }
  .kb-swatch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .kb-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .kb-chip {
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 13px;
    border-radius: 999px;
    padding: 8px 14px;
    cursor: pointer;
    min-height: 44px;
  }
  .kb-chip.kb-on { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .kb-chip:disabled { opacity: 0.55; cursor: default; }
  .kb-chip:focus-visible { outline: 2px solid var(--accent); }
  .kb-assignee-editor { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
  .kb-assignee-suggestions .kb-chip { min-height: 44px; padding-block: 8px; }
  .kb-position-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .kb-position-actions .kb-btn { display: inline-flex; align-items: center; gap: 7px; min-height: 44px; }
  .kb-position-actions svg { width: 17px; height: 17px; }
  .kb-position-up { display: inline-flex; transform: rotate(180deg); }
  .kb-danger { color: var(--kb-danger); }
  .kb-notice { font-size: 12.5px; line-height: 1.4; text-align: center; overflow-wrap: anywhere; }
  .kb-error { color: var(--kb-danger); }
  .kb-warn { color: var(--kb-warning); }
  .kb-ok { color: var(--kb-success); }
  .kb-offline {
    font-size: 12px;
    color: var(--muted);
    background: var(--surface-2);
    border-radius: 999px;
    padding: 4px 10px;
    flex: 0 0 auto;
  }

  /* Boards home */
  .kb-home {
    flex: 1;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
    max-width: 1100px;
    width: 100%;
    margin: 0 auto;
    padding: 14px 16px 24px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 12px;
    align-content: start;
    align-items: start;
    grid-auto-rows: minmax(112px, auto);
  }
  .kb-board-tile { position: relative; width: 100%; min-height: 112px; height: 100%; }
  .kb-tile {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 12px;
    width: 100%;
    min-height: 112px;
    height: 100%;
    cursor: pointer;
    text-align: left;
    font-family: var(--font);
    color: var(--text);
    transition: border-color 120ms ease-out, background 120ms ease-out, transform 120ms ease-out;
  }
  .kb-tile:focus-visible { outline: 2px solid var(--accent); }
  .kb-tile-title { min-width: 0; font-size: 15px; line-height: 1.3; font-weight: 650; overflow-wrap: anywhere; padding-right: 36px; }
  .kb-tile-meta { min-width: 0; font-size: 12px; line-height: 1.35; color: var(--muted); margin-top: auto; }
  .kb-tile-preview { height: 18px; display: flex; align-items: flex-end; gap: 4px; }
  .kb-tile-bar { width: 5px; min-height: 3px; max-height: 18px; border-radius: 999px; background: var(--muted); opacity: 0.82; }
  .kb-tile-bar[data-status='red'] { background: #ef4444; }
  .kb-tile-bar[data-status='amber'] { background: #f59e0b; }
  .kb-tile-bar[data-status='green'] { background: #10b981; }
  .kb-tile-bar[data-status='blue'] { background: #3b82f6; }
  .kb-tile-bar[data-status='purple'] { background: #8b5cf6; }
  .kb-tile-bar[data-status='pink'] { background: #ec4899; }
  .kb-tile-del { position: absolute; z-index: 1; top: 8px; right: 8px; width: 36px; height: 36px; border-radius: 9px; }
  .kb-tile-del > svg { width: 16px; height: 16px; }
  .kb-tile-confirm { cursor: default; justify-content: center; }
  .kb-confirm-copy { min-width: 0; font-size: 13.5px; line-height: 1.35; font-weight: 600; overflow-wrap: anywhere; }
  .kb-newtile {
    border-style: dashed;
    border-width: 1.5px;
    background: transparent;
    color: var(--muted);
    align-items: center;
    justify-content: center;
    flex-direction: row;
    gap: 8px;
    font-size: 14px;
    font-weight: 500;
  }
  .kb-invite-tile { cursor: default; border-color: color-mix(in srgb, var(--accent) 58%, var(--border)); }
  .kb-invite-tile .kb-tile-title { padding-right: 0; }
  .kb-invite-tile .kb-composer-row { margin-top: auto; }
  .kb-home-empty {
    grid-column: 1 / -1;
    text-align: center;
    color: var(--muted);
    font-size: 14px;
    padding: 40px 16px 8px;
  }

  @keyframes kb-column-enter {
    from { opacity: 0; transform: translateY(6px); }
  }
  .kb-board-enter .kb-col {
    animation: kb-column-enter 160ms ease-out both;
    animation-delay: calc(var(--kb-col-index, 0) * 25ms);
  }

  @media (hover: hover) and (pointer: fine) {
    .kb-switcher-button:hover,
    .kb-iconbtn:hover,
    .kb-filter-dot-btn:hover,
    .kb-addcard:hover,
    .kb-btn-quiet:hover { background: var(--surface-2); color: var(--text); }
    .kb-switcher-row:hover { background: var(--surface-2); }
    .kb-btn-primary:hover, .kb-btn-danger:hover { filter: brightness(0.94); }
    .kb-chip:not(:disabled):hover { border-color: color-mix(in srgb, var(--accent) 62%, var(--border)); background: var(--surface-2); }
    .kb-swatch:hover { transform: scale(1.04); }
    .kb-addcol:hover { color: var(--text); border-color: var(--muted); background: color-mix(in srgb, var(--surface-2) 52%, transparent); }
    .kb-danger:hover { background: color-mix(in srgb, #ef4444 12%, transparent); color: var(--kb-danger); }
    .kb-tile:not(.kb-tile-confirm):hover { border-color: color-mix(in srgb, var(--accent) 72%, var(--border)); transform: translateY(-1px); }
    .kb-newtile:hover { color: var(--text); background: color-mix(in srgb, var(--surface-2) 52%, transparent); }
    .kb-col-action:hover { background: transparent; }
    .kb-col-action:hover::before { background: var(--surface-2); }
    .kb-card:not(.kb-ghost):not(.kb-lifted):hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 11px rgba(0,0,0,0.13);
    }
    .kb-col-actions { opacity: 0.5; transition: opacity 120ms ease-out; }
    .kb-col:hover .kb-col-actions, .kb-col:focus-within .kb-col-actions { opacity: 1; }
  }

  .kb-switcher-button:not(:disabled):active,
  .kb-switcher-row:not(:disabled):active,
  .kb-iconbtn:not(:disabled):active,
  .kb-filter-dot-btn:not(:disabled):active,
  .kb-addcard:not(:disabled):active,
  .kb-addcol:not(:disabled):active,
  .kb-btn:not(:disabled):active,
  .kb-chip:not(:disabled):active,
  .kb-swatch:not(:disabled):active { transform: scale(0.97); }
  .kb-tile:not(.kb-tile-confirm):active { transform: scale(0.99); background: var(--surface-2); }

  @media (min-width: 641px) {
    .kb-switcher-scrim { background: transparent; }
    .kb-switcher-panel {
      position: absolute;
      left: 0;
      top: calc(100% + 6px);
      bottom: auto;
      transform: none;
      width: min(360px, calc(100vw - 32px));
      max-height: min(70vh, 520px);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.18);
    }
    .kb-switcher-panel .kb-sheet-grab { display: none; }
  }

  @media (max-width: 640px) {
    .kb-col { width: min(86vw, 320px); }
    .kb-board-header .kb-offline { display: none; }
    .kb-board-header .kb-header-spacer { display: none; }
    .kb-board-header .kb-switcher-wrap { flex: 1 1 0; }
    .kb-switcher-button { width: 100%; max-width: 100%; }
    .kb-filterbar { align-items: stretch; flex-direction: column; gap: 4px; }
    .kb-filter-input { flex-basis: auto; }
    .kb-filter-labels { width: 100%; gap: 0; }
  }

  @media (max-width: 479px) {
    .kb-col-reorder { display: flex; }
    .kb-col-reorder .kb-col-action { width: 36px; height: 36px; }
    .kb-col-head { padding-right: 8px; }
  }

  @media (min-width: 1024px) {
    .kb-header { padding-left: 20px; padding-right: 20px; }
    .kb-divider { width: calc(100% - 40px); }
    .kb-board { padding-left: 20px; padding-right: 20px; }
    .kb-filterbar { padding-left: 20px; padding-right: 20px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .kb-board-enter .kb-col { animation: none; }
    .kb-card, .kb-tile, .kb-col-actions, .kb-root button { transition: none; }
  }
`
