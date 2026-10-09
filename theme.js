export const CSS = `
.kb-recovery { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 16px; color: var(--muted); font-size: 12px; }
.kb-recovery .kb-btn { min-height: 44px; }

  * { box-sizing: border-box; }
  /* Like the Möbius shell, Kanban keeps scrollbars out of the interface:
     wheel, trackpad, touch, and keyboard scrolling all still work. A styled
     scrollbar would also make Chromium on Android draw a permanent track. */
  * { scrollbar-width: none; }
  *::-webkit-scrollbar { display: none; }
  ::selection { background: color-mix(in srgb, var(--accent) 28%, transparent); color: var(--text); }
  /* Phone menus render in document.body, outside .kb-root, and need the same colours. */
  .kb-root, .kb-popover-menu.is-sheet {
    --kb-danger: color-mix(in srgb, #ef4444 55%, var(--text));
    --kb-warning: color-mix(in srgb, #f59e0b 52%, var(--text));
    --kb-success: color-mix(in srgb, #10b981 55%, var(--text));
    --kb-label-red: color-mix(in srgb, #ef4444 55%, var(--text));
    --kb-label-amber: color-mix(in srgb, #f59e0b 52%, var(--text));
    --kb-label-green: color-mix(in srgb, #10b981 55%, var(--text));
    --kb-label-blue: color-mix(in srgb, #3b82f6 55%, var(--text));
    --kb-label-purple: color-mix(in srgb, #8b5cf6 55%, var(--text));
    --kb-label-pink: color-mix(in srgb, #ec4899 55%, var(--text));
  }
  .kb-root {
    min-height: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    color: var(--text);
    background: var(--bg);
    font-family: var(--font);
    overflow: hidden;
  }
  .kb-loading {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 24px;
    color: var(--muted);
    font-size: 13px;
    font-weight: 600;
  }
  .kb-loading-spinner {
    width: 22px;
    height: 22px;
    flex: 0 0 auto;
    border: 2px solid color-mix(in srgb, var(--accent) 22%, transparent);
    border-top-color: var(--accent);
    border-radius: 999px;
    animation: kb-loading-spin 700ms linear infinite;
  }
  @keyframes kb-loading-spin { to { transform: rotate(360deg); } }
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
  .kb-presence {
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    border: none;
    border-radius: 12px;
    padding: 5px 8px;
    background: transparent;
    color: var(--muted);
    font: 600 12px/1 var(--font);
    cursor: pointer;
  }
  .kb-presence-stack { display: inline-flex; align-items: center; padding-left: 6px; }
  .kb-member-avatar {
    position: relative;
    width: 36px;
    height: 36px;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 2px solid var(--surface);
    border-radius: 999px;
    font-size: 11px;
    font-weight: 750;
    letter-spacing: -0.02em;
  }
  .kb-avatar-photo { width: 100%; height: 100%; object-fit: cover; border-radius: inherit; display: block; }
  .kb-member-avatar-small { width: 30px; height: 30px; margin-left: -6px; font-size: 10px; }
  .kb-presence-dot {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 10px;
    height: 10px;
    border: 2px solid var(--surface);
    border-radius: 999px;
    background: #22c55e;
  }
  .kb-presence-more {
    width: 30px;
    height: 30px;
    margin-left: -6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 2px solid var(--surface);
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 10px;
    font-weight: 700;
  }
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
  .kb-switcher-row.kb-switcher-all { display: none; color: var(--muted); }
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
    gap: 20px;
    min-height: 0;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 20px 16px 18px;
    scroll-padding-inline: 16px;
    width: 100%;
    align-items: flex-start;
  }
  .kb-filterbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 16px 0;
    flex-wrap: wrap;
  }
  .kb-filter-input { flex: 1 1 220px; min-width: 120px; }
  .kb-filter-label-btn { display: inline-flex; align-items: center; gap: 7px; flex: 0 0 auto; min-height: 44px; padding: 0 11px; border: 1px solid var(--border); border-radius: 10px; background: transparent; color: var(--muted); font: 550 12px var(--font); cursor: pointer; }
  .kb-filter-label-btn .kb-filter-dot { width: 10px; height: 10px; }
  .kb-filter-label-btn.kb-on { background: var(--surface-2); border-color: var(--accent); color: var(--text); }
  .kb-field-label { font-size: 12px; font-weight: 600; color: var(--muted); }
  .kb-join-cancel { align-self: flex-start; }
  .kb-load-error { width: min(100% - 32px, 680px); margin: 20px auto; padding: 16px; border: 1px solid var(--border); border-radius: 12px; }
  .kb-load-error h2 { font-size: 18px; margin: 0 0 8px; }
  .kb-load-error p { color: var(--muted); font-size: 14px; line-height: 1.5; }

  .kb-filter-labels { display: flex; align-items: center; gap: 6px; overflow-x: auto; flex: 0 1 auto; }
  .kb-filter-label-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .kb-filter-dot { width: 16px; height: 16px; border-radius: 999px; display: block; }
  .kb-filter-dot.kb-none { background: var(--surface-2); border: 1px solid var(--border); position: relative; }
  .kb-col {
    flex: 0 0 auto;
    width: 320px;
    max-height: 100%;
    display: flex;
    flex-direction: column;
    background: color-mix(in srgb, var(--surface) 55%, var(--bg));
    border: 1px solid transparent;
    border-radius: 16px;
  }
  .kb-col.kb-drop { border-color: var(--accent); }
  .kb-col-head {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px 6px 14px;
  }
  .kb-col-status { width: 7px; height: 7px; margin-right: 4px; border-radius: 999px; flex: 0 0 auto; }
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
  .kb-cards {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 2px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 8px;
  }
  /* Board cards: the full title, two lines of description, one attachment,
     then the details row. Each part is left out when the card has none. */
  .kb-card {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--surface);
    border: 1px solid color-mix(in srgb, var(--text) 9%, transparent);
    border-radius: 12px;
    padding: 11px 14px 10px;
    cursor: grab;
    touch-action: pan-x pan-y;
    user-select: none;
    -webkit-user-select: none;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
    transition: box-shadow 120ms ease-out, transform 120ms ease-out;
    min-height: 44px;
  }
  .kb-card:active { cursor: grabbing; }
  .kb-card-open { position: absolute; inset: 0; z-index: 1; width: 100%; border: 0; border-radius: inherit; background: transparent; cursor: pointer; }
  /* Your cards carry a purple edge and a purple ring around your avatar. */
  .kb-card.is-mine::before { content: ""; position: absolute; left: -1px; top: 10px; bottom: 10px; width: 3px; border-radius: 0 3px 3px 0; background: var(--accent); }
  .kb-card.is-mine .kb-avatar { box-shadow: 0 0 0 2px var(--surface), 0 0 0 3.5px var(--accent); }
  /* A card someone else changed since you last looked. */
  .kb-card-new { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: var(--accent); vertical-align: 1.5px; }
  .kb-card-open:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .kb-card.kb-readonly { cursor: pointer; }
  .kb-card-title { font-size: 14.5px; font-weight: 620; line-height: 1.35; letter-spacing: -0.012em; overflow-wrap: anywhere; pointer-events: none; }
  .kb-card-notes { margin-top: -4px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; color: var(--muted); font-size: 12.5px; line-height: 1.45; overflow-wrap: anywhere; pointer-events: none; }
  /* Screenshots are the usual picture, so the crop keeps their top. */
  .kb-card-picture { display: block; width: 100%; height: 120px; object-fit: cover; object-position: top center; border: 1px solid color-mix(in srgb, var(--text) 8%, transparent); border-radius: 8px; background: var(--surface-2); pointer-events: none; }
  .kb-card-file { min-width: 0; display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; background: var(--surface-2); color: var(--muted); font-size: 12.5px; pointer-events: none; }
  .kb-card-file-badge { flex: 0 0 auto; padding: 2px 5px; border-radius: 4px; background: color-mix(in srgb, var(--text) 10%, transparent); color: var(--text); font-size: 10px; font-weight: 750; letter-spacing: 0.02em; }
  .kb-card-file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kb-card-title a { position: relative; z-index: 2; pointer-events: auto; color: var(--accent); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
  .kb-card-meta { min-width: 0; min-height: 22px; display: flex; align-items: center; gap: 9px; overflow: hidden; }
  .kb-card-count { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 3px; color: var(--muted); font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .kb-card-count > svg { width: 13px; height: 13px; }
  .kb-card-count.is-complete { color: var(--kb-success); }
  /* A label is a tinted chip with a dot and, when the board names it, its name. */
  .kb-card-label { min-width: 0; flex: 0 1 auto; display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px 1px 6px; overflow: hidden; border-radius: 6px; background: color-mix(in srgb, var(--kb-lc) 15%, transparent); color: var(--kb-lc); font-size: 11.5px; font-weight: 600; line-height: 18px; white-space: nowrap; text-overflow: ellipsis; }
  .kb-card-label::before { content: ""; width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: currentColor; }
  .kb-card-label:empty { width: 20px; height: 20px; flex: 0 0 20px; padding: 0; justify-content: center; border-radius: 50%; }
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
  /* A secondary action with a stable home at the base of every column. */
  .kb-addcard {
    width: calc(100% - 20px);
    margin: 8px 10px 12px;
    padding: 10px 11px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: transparent;
    color: var(--muted);
    font-weight: 600;
  }
  .kb-addcard:hover { border-color: color-mix(in srgb, var(--accent) 44%, var(--border)); background: color-mix(in srgb, var(--accent) 6%, transparent); color: var(--text); }
  .kb-addcard > svg, .kb-addcol > svg, .kb-btn > svg, .kb-newtile > svg { width: 18px; height: 18px; flex: 0 0 auto; }
  .kb-addcard:focus-visible { outline: 2px solid var(--accent); }
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
  .kb-col-confirm {
    margin: 4px 10px 10px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: color-mix(in srgb, var(--danger) 9%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--danger) 34%, var(--border));
    border-radius: 12px;
  }
  .kb-col-confirm-copy { font-size: 13px; line-height: 1.45; color: var(--text); }
  .kb-col-confirm-copy strong { font-weight: 650; }
  .kb-col-confirm-actions { display: flex; gap: 8px; }
  .kb-col-confirm-actions .kb-btn { flex: 1; }
  .kb-col-confirm-actions .kb-btn-quiet { background: var(--surface-2); color: var(--text); }
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
  .kb-btn-compact { min-height: 44px; padding: 6px 12px; }
  .kb-btn:disabled { opacity: 0.45; cursor: default; }
  .kb-btn-primary { background: var(--accent); color: var(--accent-fg); }
  .kb-btn-quiet { background: transparent; color: var(--muted); }
  .kb-btn-danger { background: var(--danger); color: var(--accent-fg); }
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
  .kb-board-skeleton { overflow: hidden; pointer-events: none; }
  .kb-board-skeleton-header { pointer-events: none; }
  .kb-board-skeleton-icon,
  .kb-board-skeleton-header-title,
  .kb-board-skeleton-nav-pill,
  .kb-board-skeleton-line,
  .kb-board-skeleton-count,
  .kb-board-skeleton-actions,
  .kb-board-skeleton-dot,
  .kb-board-skeleton-card,
  .kb-board-skeleton-add {
    display: block;
    background: color-mix(in srgb, var(--surface-2) 78%, var(--border));
    animation: kb-board-skeleton-pulse 1.25s ease-in-out infinite alternate;
  }
  .kb-board-skeleton-icon { width: 44px; height: 44px; flex: 0 0 44px; border-radius: 8px; }
  .kb-board-skeleton-header-title { width: min(210px, 34vw); height: 24px; border-radius: 8px; }
  .kb-board-skeleton-nav-pill { width: 112px; height: 44px; flex: 0 0 112px; border-radius: 10px; }
  .kb-board-skeleton-col {
    flex: 0 0 336px;
    width: 336px;
    display: flex;
    flex-direction: column;
    padding-bottom: 8px;
    border: 1px solid transparent;
    border-radius: 14px;
    background: color-mix(in srgb, var(--surface-2) 72%, var(--bg));
  }
  .kb-board-skeleton-col-head { flex-wrap: nowrap; }
  .kb-board-skeleton-dot { width: 7px; height: 7px; margin-right: 4px; flex: 0 0 7px; border-radius: 999px; }
  .kb-board-skeleton-line { width: 42%; height: 14px; flex: 1 1 auto; border-radius: 999px; }
  .kb-board-skeleton-count { width: 30px; height: 22px; flex: 0 0 30px; border-radius: 999px; }
  .kb-board-skeleton-actions { width: 72px; height: 44px; flex: 0 0 72px; border-radius: 8px; }
  .kb-board-skeleton-cards { flex: 0 1 auto; overflow: hidden; }
  .kb-board-skeleton-card { width: 100%; height: 92px; flex: 0 0 auto; border-radius: 11px; }
  .kb-board-skeleton-card-short { height: 68px; }
  .kb-board-skeleton-col:nth-of-type(2) .kb-board-skeleton-card:nth-child(1) { height: 72px; }
  .kb-board-skeleton-col:nth-of-type(3) .kb-board-skeleton-card:nth-child(2) { height: 112px; }
  .kb-board-skeleton-add { height: 44px; margin: 4px 10px 0; border-radius: 8px; }
  @keyframes kb-board-skeleton-pulse {
    from { opacity: 0.5; }
    to { opacity: 0.92; }
  }
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
    background: rgba(0,0,0,0.6);
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
  }
  .kb-sheet-grab { width: 40px; height: 4px; border-radius: 2px; background: var(--border); margin: 0 auto; }
  .kb-sheet-row { display: flex; align-items: center; gap: 10px; }
  .kb-sheet-row-between { justify-content: space-between; }
  .kb-inline-field { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .kb-inline-field .kb-input { flex: 1 1 auto; min-width: 0; }
  .kb-inline-field .kb-btn { flex: 0 0 auto; }
  .kb-sheet h3 { margin: 0; font-size: 13px; font-weight: 600; color: var(--muted); }
  .kb-image-loading { background: color-mix(in srgb, var(--muted) 13%, var(--surface-2)); }
  .kb-image-missing { position: relative; }
  .kb-image-missing::after {
    content: 'Unavailable';
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--muted);
    font-size: 11px;
  }
  .kb-attachment-error { margin: 0; color: var(--danger); font-size: 12px; line-height: 1.45; }
  .kb-visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .kb-field-spaced { margin-top: 8px; }
  .kb-detail-field { position: relative; min-width: 0; flex: 0 0 auto; }
  .kb-editable-field { cursor: text; border-radius: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .kb-editable-field:hover { background: color-mix(in srgb, var(--surface-2) 68%, transparent); }
  .kb-editable-field:focus { outline: 2px solid var(--accent); outline-offset: 2px; }
  .kb-editable-field[data-empty="true"]::before { content: attr(data-placeholder); color: var(--muted); pointer-events: none; }
  .kb-title-display {
    display: block;
    width: 100%;
    min-height: 44px;
    padding: 8px 2px;
    border: 0;
    background: transparent;
    text-align: left;
    font-family: var(--font);
    color: var(--text);
    font-size: 20px;
    font-weight: 700;
    line-height: 1.25;
    letter-spacing: -0.02em;
    overflow-wrap: anywhere;
  }
  .kb-notes-display {
    flex: 0 0 auto;
    max-height: none;
    min-height: 68px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--surface-2);
    color: var(--text);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .kb-notes-display a { position: relative; z-index: 2; pointer-events: auto; color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
  .kb-notes-empty { color: var(--muted); }
  .kb-pr-line { min-height: 44px; display: flex; align-items: center; gap: 10px; }
  .kb-section-line { min-height: 40px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .kb-pr-icon { width: 16px; height: 16px; flex: 0 0 auto; color: var(--muted); }
  .kb-pr-link { flex: 1 1 auto; min-width: 0; min-height: 44px; display: flex; flex-direction: column; justify-content: center; gap: 1px; color: var(--text); text-decoration: none; }
  .kb-pr-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 560; }
  .kb-pr-ref { color: var(--muted); font-size: 12px; }
  .kb-pr-link:hover .kb-pr-name { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
  /* Small icon buttons inside a card section (pull request refresh, add, and
     edit) share one size and one right edge. On touch screens the hit area
     still reaches 44px around the 32px button. */
  .kb-section-head-actions { display: flex; align-items: center; gap: 2px; margin: -6px 0 -6px auto; }
  .kb-iconbtn.kb-section-icon { position: relative; width: 32px; height: 32px; min-height: 32px; flex: 0 0 32px; padding: 0; border-radius: 8px; }
  .kb-iconbtn.kb-section-icon > svg { width: 16px; height: 16px; }
  @media (pointer: coarse) { .kb-iconbtn.kb-section-icon::after { content: ""; position: absolute; inset: -6px; } }
  /* With a mouse, the pencil appears on the line you point at; touch screens always show it. */
  @media (hover: hover) {
    .kb-pr-edit { opacity: 0; transition: opacity 0.15s ease; }
    .kb-pr-line:hover .kb-pr-edit, .kb-pr-edit:focus-visible { opacity: 1; }
  }
  /* The link field and its buttons are one height with one corner radius. */
  .kb-pr-editor { display: flex; align-items: center; gap: 8px; }
  .kb-pr-editor .kb-input { min-width: 0; flex: 1 1 auto; height: 40px; min-height: 40px; padding-block: 0; border-radius: 10px; font-size: 15px; }
  .kb-pr-editor .kb-btn { height: 40px; min-height: 40px; padding: 0 14px; border-radius: 10px; }
  @media (max-width: 640px) {
    .kb-pr-editor .kb-input, .kb-pr-editor .kb-btn { height: 44px; min-height: 44px; }
    .kb-pr-editor .kb-input { font-size: 16px; }
  }
  .kb-pr-status { flex: 0 0 auto; padding: 3px 7px; border-radius: 999px; font-size: 11px; font-weight: 650; }
  .kb-pr-status-open { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
  .kb-pr-status-draft { background: var(--surface-2); color: var(--muted); }
  .kb-pr-status-unknown { border: 1px dashed var(--border); color: var(--muted); }
  .kb-pr-status-merged { background: color-mix(in srgb, #38b875 18%, transparent); color: #319867; }
  .kb-pr-status-closed { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger); }
  .kb-pr-hint { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.4; }
  .kb-card-sheet {
    top: clamp(56px, 9dvh, 104px);
    bottom: auto;
    max-height: calc(100dvh - clamp(72px, 11dvh, 120px));
    border-bottom: 1px solid var(--border);
    border-radius: 20px;
    scroll-behavior: smooth;
    overscroll-behavior: contain;
  }
  /* Strengthen hierarchy without changing status colours or mobile board navigation. */
  .kb-root { letter-spacing: -0.005em; }
  .kb-header { min-height: 72px; padding: 14px 20px 10px; gap: 10px; }
  .kb-title, .kb-switcher-button { font-size: 21px; font-weight: 650; letter-spacing: -0.035em; }
  .kb-title-static { font-size: 19px; font-weight: 650; letter-spacing: -0.03em; }
  .kb-sub { margin-top: 2px; font-size: 14px; line-height: 1.4; }
  .kb-divider { width: calc(100% - 40px); }
  .kb-filterbar { padding: 10px 20px 0; gap: 7px; }
  .kb-filter-label-btn { border-radius: 8px; font-weight: 600; }
  .kb-board { gap: 16px; padding: 18px 20px 22px; scroll-padding-inline: 20px; }
  .kb-col { width: 336px; border-radius: 16px; background: color-mix(in srgb, var(--surface-2) 32%, var(--bg)); }
  .kb-col-head { gap: 6px; padding: 8px 12px 8px 15px; }
  .kb-col-name { font-size: 15px; font-weight: 650; letter-spacing: -0.015em; }
  .kb-count { padding: 3px 7px; font-size: 14px; font-weight: 650; background: color-mix(in srgb, var(--surface) 68%, var(--surface-2)); }
  .kb-cards { gap: 9px; padding: 3px 10px 8px; }
  .kb-btn { border-radius: 8px; font-weight: 650; letter-spacing: -0.01em; }
  .kb-iconbtn { border-radius: 8px; }
  .kb-iconbtn:hover { background: var(--surface-2); color: var(--text); }
  .kb-addcol { width: 230px; border-radius: 14px; border-style: solid; border-width: 1px; background: color-mix(in srgb, var(--surface-2) 45%, transparent); font-weight: 600; }
  .kb-addcol:hover { border-color: var(--accent); color: var(--text); background: color-mix(in srgb, var(--accent) 7%, var(--surface-2)); }
  @media (max-width: 640px) {
    .kb-header { min-height: 64px; padding: 10px 16px 7px; }
    .kb-title, .kb-switcher-button { font-size: 18px; }
    .kb-divider { width: calc(100% - 32px); }
    .kb-filterbar { padding-inline: 16px; }
    .kb-board { gap: 12px; padding: 14px 16px 18px; scroll-padding-inline: 16px; }
    .kb-board-skeleton-col { flex-basis: min(336px, calc(100vw - 32px)); width: min(336px, calc(100vw - 32px)); }
    .kb-board-skeleton-header-title { width: min(160px, 38vw); }
    .kb-card:hover { transform: none; box-shadow: 0 1px 2px color-mix(in srgb, var(--text) 5%, transparent); }
  }

  @media (prefers-reduced-motion: reduce) {
    .kb-card-sheet { scroll-behavior: auto; }
  }
  .kb-card-toolbar { position: relative; min-height: 44px; display: flex; align-items: center; gap: 8px; }
  .kb-card-sheet .kb-card-toolbar .kb-assignee-picker { flex: 0 0 auto; margin: 0; }
  .kb-card-toolbar .kb-assignee-trigger,
  .kb-label-trigger {
    width: auto;
    max-width: 100%;
    min-height: 40px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 4px 11px 4px 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg);
    color: var(--text);
    font: 600 13px/1.2 var(--font);
    cursor: pointer;
  }
  .kb-card-toolbar .kb-assignee-trigger .kb-assignee-avatar { width: 100%; height: 100%; flex-basis: 100%; border: 0; font-size: 14px; }
  .kb-card-toolbar .kb-assignee-trigger { overflow: hidden; }
  .kb-card-toolbar .kb-assignee-trigger:disabled, .kb-label-trigger:disabled { cursor: default; }
  .kb-card-toolbar-title { flex: 1 1 auto; min-width: 0; font-size: 19px; font-weight: 650; line-height: 1.2; letter-spacing: -0.015em; }
  /* A saved card names the list it sits in; only a draft is a "New card". */
  .kb-card-danger-zone { border-top: 1px solid var(--border); padding-top: 16px; }
  .kb-delete-card {
    width: 100%;
    min-height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .kb-people-list { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
  .kb-person-row { min-height: 52px; display: flex; align-items: center; gap: 10px; }
  .kb-person-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
  .kb-person-name { min-width: 0; font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; }
  .kb-person-meta { color: var(--muted); font-size: 11.5px; line-height: 1.3; overflow-wrap: anywhere; }
  .kb-person-row .kb-btn { flex: 0 0 auto; }
  .kb-invite-notice { margin-top: 8px; text-align: left; }
  .kb-checklist { display: flex; flex-direction: column; gap: 6px; }
  .kb-check-item { display: flex; align-items: center; gap: 6px; min-height: 44px; padding-left: 8px; border-radius: 9px; }
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
  .kb-check-toggle input[type="checkbox"] { width: 20px; height: 20px; flex: 0 0 auto; accent-color: var(--accent); }
  .kb-check-toggle input[type="checkbox"]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .kb-check-toggle input[type="checkbox"]:disabled { cursor: default; }
  .kb-check-done { color: var(--muted); text-decoration: line-through; }
  .kb-check-add { display: flex; align-items: center; gap: 8px; }
  .kb-check-add .kb-input { background: transparent; }
  .kb-swatches { display: flex; flex-wrap: wrap; gap: 10px; }
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
  .kb-assignee-picker { position: relative; min-width: 0; margin-top: 8px; }
  .kb-assignee-trigger {
    width: 100%;
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 9px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg);
    color: var(--text);
    font: 550 13px/1.2 var(--font);
    text-align: left;
    cursor: pointer;
  }
  .kb-assignee-trigger:disabled { cursor: default; opacity: 1; }
  .kb-assignee-trigger > svg { width: 15px; height: 15px; flex: 0 0 auto; color: var(--muted); }
  .kb-assignee-trigger-label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kb-assignee-trigger-label.is-empty { color: var(--muted); font-weight: 500; }
  .kb-assignee-avatar,
  .kb-assignee-option-icon {
    width: 28px;
    height: 28px;
    flex: 0 0 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    font-size: 9px;
    font-weight: 750;
    letter-spacing: -0.01em;
  }
  .kb-assignee-avatar-empty { background: var(--surface-2); color: var(--muted); }
  .kb-assignee-avatar-empty > svg,
  .kb-assignee-option-icon > svg { width: 15px; height: 15px; }
  .kb-assignee-backdrop { position: fixed; inset: 0; z-index: 79; border: 0; background: transparent; cursor: default; }
  .kb-assignee-menu {
    position: fixed;
    z-index: 80;
    width: min(320px, calc(100vw - 32px));
    max-height: min(420px, 58dvh);
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 8px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 13px;
    background: var(--surface);
    box-shadow: 0 14px 38px rgba(0,0,0,0.2);
  }
  .kb-assignee-mobile-head { display: none; }
  .kb-assignee-search {
    min-height: 40px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border-radius: 9px;
    background: var(--surface-2);
    color: var(--muted);
  }
  .kb-assignee-search > svg { width: 17px; height: 17px; flex: 0 0 auto; }
  .kb-assignee-search > input {
    width: 100%;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text);
    font: 500 13px/1.2 var(--font);
  }
  .kb-assignee-search > input::placeholder { color: var(--muted); opacity: 1; }
  .kb-assignee-search:focus-within { box-shadow: 0 0 0 2px var(--accent); }
  .kb-assignee-options { min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  .kb-assignee-option {
    width: 100%;
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 8px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: var(--text);
    font-family: var(--font);
    text-align: left;
    cursor: pointer;
  }
  .kb-assignee-option > .kb-member-avatar-small { width: 28px; height: 28px; margin-left: 0; border-width: 1px; }
  .kb-assignee-option > svg { width: 17px; height: 17px; flex: 0 0 auto; color: var(--accent); }
  .kb-assignee-option-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
  .kb-assignee-option-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
  .kb-assignee-option-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11px; }
  .kb-assignee-option-icon { background: color-mix(in srgb, var(--accent) 15%, var(--surface-2)); color: var(--accent); }
  .kb-assignee-option:focus-visible,
  .kb-assignee-mobile-head .kb-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .kb-assignee-me { margin-bottom: 4px; border-bottom: 1px solid var(--border); border-radius: 9px 9px 3px 3px; padding-bottom: 10px; }
  .kb-assignee-empty { padding: 18px 10px; color: var(--muted); font-size: 12.5px; text-align: center; }
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
    max-width: 1100px;
    width: 100%;
    margin: 0 auto;
    padding: 14px 16px 24px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
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
  .kb-tile-del { position: absolute; z-index: 1; top: 4px; right: 4px; width: 44px; height: 44px; border-radius: 9px; }
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
  .kb-join-tile .kb-tile-title { padding-right: 0; }
  .kb-join-open { cursor: default; gap: 6px; }
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
    .kb-filter-label-btn:hover,
    .kb-addcard:hover,
    .kb-btn-quiet:hover { background: var(--surface-2); color: var(--text); }
    .kb-switcher-row:hover { background: var(--surface-2); }
    .kb-assignee-trigger:not(:disabled):hover,
    .kb-assignee-option:hover,
    .kb-check-item:hover { background: var(--surface-2); }
    .kb-btn-primary:hover, .kb-card-toolbar-done:hover, .kb-btn-danger:hover { filter: brightness(0.94); }
    .kb-chip:not(:disabled):hover { border-color: color-mix(in srgb, var(--accent) 62%, var(--border)); background: var(--surface-2); }
    .kb-addcol:hover { color: var(--text); border-color: var(--muted); background: color-mix(in srgb, var(--surface-2) 52%, transparent); }
    .kb-danger:hover { background: color-mix(in srgb, #ef4444 12%, transparent); color: var(--kb-danger); }
    .kb-tile:not(.kb-tile-confirm):hover { border-color: color-mix(in srgb, var(--accent) 72%, var(--border)); transform: translateY(-1px); }
    .kb-newtile:hover { color: var(--text); background: color-mix(in srgb, var(--surface-2) 52%, transparent); }
    .kb-card:not(.kb-ghost):not(.kb-lifted):hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 11px rgba(0,0,0,0.13);
    }
  }

  .kb-switcher-button:not(:disabled):active,
  .kb-switcher-row:not(:disabled):active,
  .kb-presence:not(:disabled):active,
  .kb-iconbtn:not(:disabled):active,
  .kb-filter-label-btn:not(:disabled):active,
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
    .kb-swatches { flex-wrap: nowrap; gap: 4px; overflow-x: auto; padding-block: 2px; }
    .kb-input, .kb-col-name { font-size: 16px; }
    .kb-sheet {
      top: max(8px, env(safe-area-inset-top));
      bottom: auto;
      width: calc(100% - 16px);
      max-height: calc(100dvh - max(16px, env(safe-area-inset-top)));
      border: 1px solid var(--border);
      border-radius: 16px;
      padding-bottom: max(16px, env(safe-area-inset-bottom));
      overscroll-behavior: contain;
      scroll-padding-bottom: 96px;
    }
  .kb-card-sheet { gap: 12px; }
    .kb-card-sheet > * { flex: 0 0 auto; min-height: 0; }
    .kb-card-sheet .kb-field-spaced,
    .kb-card-sheet .kb-assignee-picker { margin-top: 6px; }
    .kb-card-sheet .kb-swatches { padding-bottom: 2px; }
    .kb-assignee-backdrop { background: rgba(0,0,0,0.24); }
    .kb-assignee-menu {
      position: fixed;
      inset: auto 8px max(8px, env(safe-area-inset-bottom));
      width: auto;
      max-height: min(72dvh, 520px);
      z-index: 90;
      border-radius: 16px;
      padding: 10px;
    }
    .kb-assignee-mobile-head { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 2px 2px 8px; }
    .kb-assignee-mobile-head > strong { font-size: 14px; font-weight: 700; }
    .kb-assignee-mobile-head .kb-btn { min-height: 40px; padding-inline: 10px; }
    .kb-assignee-search { min-height: 44px; }
    .kb-assignee-search > input { font-size: 16px; }
    .kb-assignee-option { min-height: 48px; }
    .kb-board-header .kb-header-spacer { display: none; }
    .kb-board-header .kb-switcher-wrap { flex: 1 1 0; }
    .kb-presence { padding-inline: 3px; }
    .kb-presence-label { display: none; }
    .kb-switcher-button { width: 100%; max-width: 100%; }
    .kb-filterbar { align-items: stretch; flex-direction: column; gap: 4px; }
    .kb-filter-input { flex-basis: auto; }
    .kb-filter-labels { width: 100%; gap: 6px; padding-block: 4px; }
  }

  .kb-check-text { min-width: 0; padding: 4px 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; overflow-wrap: anywhere; cursor: text; }
  .kb-check-text:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
  .kb-check-text a { color: var(--accent); font-weight: 550; text-decoration: none; }
  .kb-check-text a:hover { text-decoration: underline; text-underline-offset: 2px; }
  .kb-check-edit { min-width: 0; min-height: 40px; flex: 1; }
  .kb-lightbox-scrim { z-index: 70; background: rgba(0,0,0,.72); }
  .kb-lightbox { position: fixed; inset: 6vh 6vw; z-index: 71; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
  .kb-lightbox-image { max-width: 100%; max-height: 82vh; object-fit: contain; border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.35); }
  .kb-lightbox-close { align-self: flex-end; }
  .kb-lightbox-caption { color: white; font-size: 12px; }

  @media (max-width: 479px) {
    .kb-col-head { padding-right: 8px; }
  }

  .kb-list-nav, .kb-list-bar { display: none; }
  .kb-clear-filters { flex: 0 0 auto; white-space: nowrap; }
  .kb-home-header { width: min(100%, 1100px); margin-inline: auto; }
  .kb-home-header + .kb-divider { max-width: 1068px; }
  .kb-count { font-variant-numeric: tabular-nums; }
  /* Phones: one header row, then the list tabs, then one list filling the
     screen. The tab of the list in view is that list's header and carries its
     add and menu buttons, so a list has no header or Add card bar of its own. */
  @media (max-width: 640px) {
    .kb-board-header { min-height: 48px; padding: 2px 6px 2px 10px; gap: 4px; flex-wrap: wrap; row-gap: 0; }
    .kb-board-header .kb-homebtn,
    .kb-board-header .kb-view-switch,
    .kb-board-header .kb-filter-toggle,
    .kb-board-header .kb-presence ~ .kb-share-btn { display: none; }
    .kb-switcher-row.kb-switcher-all { display: flex; }
    .kb-board-header .kb-show-chip { display: inline-flex; }
    /* Sync messages take a slim line under the header, only while there is one. */
    .kb-board-header .kb-status-live:not(:empty) { order: 20; flex: 1 0 100%; display: flex; flex-wrap: wrap; gap: 6px; padding: 0 4px 6px; }
    .kb-board-header ~ .kb-divider, .kb-filterbar { display: none; }
    .kb-list-nav { display: flex; gap: 2px; flex: 0 0 auto; overflow-x: auto; }
    .kb-list-jump {
      display: inline-flex; align-items: center; gap: 7px; flex: 0 0 auto;
      min-height: 44px; padding: 0 10px; border: 0; border-bottom: 2px solid transparent;
      border-radius: 0; background: transparent; color: var(--muted);
      font: 600 13.5px/1.3 var(--font); cursor: pointer;
    }
    .kb-list-jump[aria-current="true"] { color: var(--text); border-bottom-color: var(--text); }
    .kb-list-jump[aria-current="true"] .kb-list-jump-count { color: var(--text); }
    .kb-list-jump-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kb-list-jump-count { color: var(--muted); font-variant-numeric: tabular-nums; }
    .kb-list-bar { display: flex; align-items: center; padding-right: 2px; border-bottom: 1px solid var(--border); }
    /* The fade at the edge says more tabs scroll into view. */
    .kb-list-bar .kb-list-nav {
      flex: 1 1 0; min-width: 0; padding-left: 6px;
      -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 24px), transparent);
      mask-image: linear-gradient(90deg, #000 calc(100% - 24px), transparent);
    }
    /* The list menu's negative margin lines it up in a desktop list header; beside the tabs it would push the row off the screen. */
    .kb-list-bar-menu { flex: none; }
    .kb-list-bar-menu .kb-col-menu { margin: 0; }
    .kb-list-bar-add, .kb-list-bar-menu .kb-menu-trigger { width: 40px; height: 44px; }
    .kb-col:not(.is-renaming) > .kb-col-head { display: none; }
    .kb-col-head { flex-wrap: wrap; }
    .kb-col-name { flex-basis: calc(100% - 180px); }
    .kb-addcard { display: none; }
    /* Each list spans the screen; the tabs jump between them. */
    .kb-board { gap: 16px; padding: 8px 16px 12px; scroll-padding-inline: 16px; }
    .kb-col { width: calc(100vw - 32px); background: transparent; border-radius: 0; }
    .kb-col.kb-col-folded { background: color-mix(in srgb, var(--surface-2) 32%, var(--bg)); border-radius: 14px; }
    .kb-col > .kb-cards { padding: 0 0 8px; gap: 6px; }
    .kb-card { gap: 6px; padding: 10px 12px 9px; }
    .kb-card-title { font-size: 15px; }
    .kb-card-notes { margin-top: -2px; }
    .kb-card-picture { height: 96px; }
    /* A person who is the card's only detail sits beside the title. */
    .kb-card.is-person-only .kb-card-meta { position: absolute; top: 9px; right: 10px; min-height: 0; }
    .kb-card.is-person-only .kb-card-title { padding-right: 30px; }
    .kb-clear-filters { align-self: flex-start; }
  }

  @media (min-width: 1024px) {
    .kb-header { padding-left: 20px; padding-right: 20px; }
    .kb-divider { width: calc(100% - 40px); }
    .kb-board { padding-left: 20px; padding-right: 20px; }
    .kb-filterbar { padding-left: 20px; padding-right: 20px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .kb-mini-spinner { animation: none; }
    .kb-saved, .kb-show-more > svg, .kb-fold-chevron, .kb-section-progress > span { transition: none; }
    .kb-board-enter .kb-col { animation: none; }
    .kb-loading-spinner { animation: none; }
    .kb-board-skeleton-icon,
    .kb-board-skeleton-header-title,
    .kb-board-skeleton-nav-pill,
    .kb-board-skeleton-line,
    .kb-board-skeleton-count,
    .kb-board-skeleton-actions,
    .kb-board-skeleton-dot,
    .kb-board-skeleton-card,
    .kb-board-skeleton-add { animation: none; }
    .kb-card, .kb-tile, .kb-col-actions, .kb-root button { transition: none; }
  }

  /* Board refresh: quieter lanes, clearer cards, safer destructive actions. */

  /* Cards lift on hover only where motion is welcome. */
  @media (hover: hover) and (prefers-reduced-motion: no-preference) {
    .kb-card:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--text) 18%, transparent); box-shadow: 0 8px 20px -8px rgba(0, 0, 0, 0.45); }
  }


  /* Filled buttons keep white labels at AA contrast on the platform accent. */
  .kb-btn-primary, .kb-card-toolbar-done { background: color-mix(in srgb, var(--accent) 78%, #000); color: #fff; }
  .kb-btn-danger { background: color-mix(in srgb, var(--danger) 78%, #000); color: #fff; }

  /* Card sheet. */
  .kb-notes-display.kb-notes-empty { min-height: 44px; display: flex; align-items: center; color: var(--muted); }
  .kb-delete-card {
    width: auto;
    min-height: 44px;
    padding-inline: 14px;
    border: 1px solid color-mix(in srgb, var(--kb-danger) 35%, transparent);
    background: transparent;
    color: var(--kb-danger);
  }
  .kb-card-danger-zone { display: flex; }
  .kb-card-delete-confirm { margin: 0; }
  .kb-status-live { display: contents; }

  /* Desktop: sharing opens as a centred dialog, not a phone sheet. */
  @media (min-width: 641px) {
    .kb-sheet:not(.kb-card-sheet):not(.kb-switcher-panel) {
      top: 50%;
      bottom: auto;
      transform: translate(-50%, -50%);
      border: 1px solid var(--border);
      border-radius: 20px;
      max-height: min(84dvh, 720px);
      padding-bottom: 20px;
      box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.55);
    }
    .kb-sheet:not(.kb-card-sheet):not(.kb-switcher-panel) > .kb-sheet-grab { display: none; }
  }
  @media (max-width: 640px) {
    .kb-delete-card { width: 100%; }
  }

  /* All / Mine / Unassigned: a personal lens on the board, never board data. */
  .kb-view-switch {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    border-radius: 11px;
    background: var(--surface-2);
  }
  .kb-view-option {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 34px;
    padding: 0 11px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--muted);
    font: 600 13px var(--font);
    cursor: pointer;
  }
  .kb-view-option:hover { color: var(--text); }
  .kb-view-option[aria-pressed="true"] {
    background: var(--bg);
    color: var(--text);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12), 0 0 0 1px var(--border);
  }
  .kb-view-count {
    min-width: 20px;
    padding: 0 6px;
    border-radius: 99px;
    background: color-mix(in srgb, var(--muted) 16%, transparent);
    font-size: 11.5px;
    line-height: 18px;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .kb-view-option[aria-pressed="true"] .kb-view-count {
    background: color-mix(in srgb, var(--muted) 24%, transparent);
    color: var(--text);
  }
  /* Purple means you: your cards, and cards changed since you last looked. */
  .kb-view-option.is-you .kb-view-count {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent);
  }
  /* Phones show this chip instead of the view switch and filter button; it
     opens both in one sheet. */
  .kb-show-chip { display: none; position: relative; align-items: center; gap: 6px; flex: 0 0 auto; height: 34px; padding: 0 9px 0 12px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text); font: 620 13.5px var(--font); cursor: pointer; }
  .kb-show-chip::after { content: ""; position: absolute; inset: -5px 0; }
  .kb-show-chip > svg { width: 14px; height: 14px; color: var(--muted); }
  .kb-show-count { color: var(--muted); font-variant-numeric: tabular-nums; }
  .kb-show-chip.is-you .kb-show-count { color: var(--accent); }
  .kb-show-chip.is-filtered { border-color: color-mix(in srgb, var(--text) 38%, var(--border)); }
  .kb-show-dot { position: absolute; top: -2px; right: -1px; width: 9px; height: 9px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--bg); }
  .kb-show-sheet { gap: 12px; }
  .kb-show-sheet .kb-view-switch { display: flex; flex-direction: column; align-items: stretch; gap: 2px; padding: 0; background: transparent; }
  .kb-show-sheet .kb-view-option { justify-content: space-between; min-height: 46px; padding: 0 12px; font-size: 15px; font-weight: 560; }
  .kb-show-sheet .kb-view-option[aria-pressed="true"] { background: var(--surface-2); box-shadow: none; }
  .kb-show-sheet .kb-filter-input { flex: 0 0 auto; }
  .kb-show-sheet .kb-filter-labels { flex-wrap: wrap; overflow: visible; }
  .kb-view-note { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 16px; padding: 10px 20px 0; color: var(--muted); font-size: 13px; line-height: 1.4; }
  .kb-view-note .kb-quiet-action { color: var(--accent); }
  @media (max-width: 640px) { .kb-view-note { padding-inline: 16px; } }

  .kb-activity-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .kb-activity-item { display: flex; align-items: flex-start; gap: 10px; padding: 7px 0; font-size: 13.5px; }
  .kb-activity-item + .kb-activity-item { border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
  .kb-activity-dot { flex: 0 0 8px; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: var(--muted); }
  .kb-activity-item.is-added .kb-activity-dot { background: var(--kb-success); }
  .kb-activity-item.is-removed .kb-activity-dot { background: var(--kb-danger); }
  .kb-activity-item.is-changed .kb-activity-dot { background: var(--accent); }
  .kb-activity-item.is-observed .kb-activity-dot { background: transparent; border: 2px solid var(--kb-warning); }
  .kb-activity-copy { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; overflow-wrap: anywhere; }
  .kb-activity-copy small { color: var(--muted); font-size: 12px; }
  .kb-activity-restore { flex: 0 0 auto; min-height: 36px; padding-inline: 10px; white-space: nowrap; }

  .kb-undo-toast {
    position: fixed;
    left: 50%;
    bottom: max(20px, env(safe-area-inset-bottom));
    z-index: 95;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 14px;
    max-width: calc(100% - 32px);
    padding: 8px 8px 8px 16px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--text) 92%, var(--bg));
    color: var(--bg);
    font-size: 13.5px;
    box-shadow: 0 12px 32px -12px rgba(0, 0, 0, 0.45);
  }
  .kb-undo-toast > span { min-width: 0; overflow-wrap: anywhere; }
  .kb-undo-action {
    flex: 0 0 auto;
    min-height: 36px;
    padding: 0 12px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: color-mix(in srgb, var(--accent) 70%, var(--bg));
    font: 650 13.5px var(--font);
    cursor: pointer;
  }
  .kb-undo-action:hover { background: color-mix(in srgb, var(--bg) 14%, transparent); }
  @keyframes kb-toast-in { from { opacity: 0; transform: translate(-50%, 8px); } }
  @media (prefers-reduced-motion: no-preference) { .kb-undo-toast { animation: kb-toast-in 160ms ease-out; } }

  /* ---- Card sheet: status pill, details row, sections (ui/CardParts.jsx) ---- */
  .kb-card-sheet { gap: 0; padding: 14px 22px 18px; width: min(calc(100% - 24px), 600px); }
  .kb-card-sheet.is-dropping { outline: 2px dashed var(--accent); outline-offset: -6px; }
  .kb-card-toolbar { gap: 8px; margin-bottom: 2px; }
  .kb-card-toolbar-spacer { flex: 1 1 auto; }
  .kb-card-close { width: 44px; height: 44px; flex: 0 0 44px; color: var(--muted); }
  .kb-card-close > svg { width: 20px; height: 20px; }
  .kb-saved { min-width: 70px; display: inline-flex; align-items: center; justify-content: flex-end; gap: 4px; color: var(--muted); font-size: 12.5px; font-weight: 600; opacity: 0; transition: opacity 0.25s ease; }
  .kb-saved.is-visible { opacity: 1; }
  .kb-saved > svg { width: 14px; height: 14px; color: var(--kb-success); }
  .kb-status-pill-wrap, .kb-chip-wrap { position: relative; min-width: 0; }
  .kb-status-pill {
    min-height: 44px;
    max-width: 100%;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px 0 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text);
    font: 650 14px/1 var(--font);
    cursor: pointer;
  }
  .kb-status-pill:hover:not(:disabled), .kb-detail-chip:hover:not(:disabled) { border-color: color-mix(in srgb, var(--text) 26%, var(--border)); }
  .kb-status-pill:disabled, .kb-detail-chip:disabled { cursor: default; }
  .kb-status-pill > svg { width: 15px; height: 15px; color: var(--muted); }
  .kb-status-dot { width: 9px; height: 9px; flex: 0 0 9px; border-radius: 50%; }
  .kb-status-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kb-popover-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 70;
    min-width: 220px;
    max-height: min(60dvh, 420px);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
  }
  .kb-popover-menu > button { min-height: 44px; display: flex; align-items: center; gap: 10px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--text); font: 550 14px/1.2 var(--font); text-align: left; cursor: pointer; }
  .kb-popover-menu > button:hover, .kb-popover-menu > button:focus-visible { background: var(--surface-2); outline: none; }
  .kb-popover-menu > button > svg { width: 15px; height: 15px; margin-left: auto; color: var(--accent); }
  .kb-popover-backdrop { position: fixed; inset: 0; z-index: 89; background: rgba(0, 0, 0, 0.24); }
  .kb-popover-menu.is-sheet { position: fixed; inset: auto 8px max(8px, env(safe-area-inset-bottom)); z-index: 90; min-width: 0; max-height: min(70dvh, 480px); border-radius: 16px; padding: 8px; }
  .kb-menu-label { flex: 1 1 auto; min-width: 0; }
  .kb-menu-label.is-unnamed { color: var(--muted); }
  .kb-label-names { width: min(300px, calc(100vw - 32px)); }
  .kb-label-name-row { display: flex; align-items: center; gap: 10px; padding: 4px 10px; }
  .kb-label-name-row .kb-chip-swatch { width: 14px; height: 14px; flex: 0 0 14px; border-radius: 4px; }
  .kb-label-name-row .kb-input { min-width: 0; flex: 1 1 auto; min-height: 40px; }
  .kb-label-names-hint { margin: 4px 10px 8px; color: var(--muted); font-size: 12px; line-height: 1.4; }
  .kb-menu-meta { margin-left: auto; color: var(--muted); font-size: 12.5px; }
  .kb-menu-heading { padding: 6px 10px 4px; color: var(--muted); font-size: 13px; font-weight: 620; letter-spacing: -0.005em; }
  .kb-menu-separator { height: 1px; margin: 4px 6px; background: var(--border); }
  .kb-popover-menu > .kb-menu-danger, .kb-quiet-action.kb-menu-danger { color: var(--kb-danger, #e5484d); }
  .kb-menu-date { min-height: 44px; display: flex; align-items: center; gap: 10px; padding: 0 10px; color: var(--muted); font-size: 13px; }
  .kb-menu-date input { flex: 1 1 auto; min-width: 0; min-height: 36px; padding: 0 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); color: var(--text); font: 15px var(--font); color-scheme: light dark; }
  .kb-detail-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 2px 0 16px; }
  .kb-detail-chips > .kb-chip-wrap, .kb-detail-chips .kb-assignee-picker { margin: 0; }
  .kb-detail-chip {
    height: 36px;
    min-height: 36px;
    max-width: 100%;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 12px 0 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text);
    font: 600 13px/1 var(--font);
    white-space: nowrap;
    cursor: pointer;
  }
  .kb-detail-chip > svg { width: 14px; height: 14px; flex: 0 0 auto; }
  .kb-detail-chip.is-empty { border-style: dashed; background: transparent; color: var(--muted); font-weight: 550; }
  .kb-detail-chip.is-empty:hover:not(:disabled) { border-color: var(--accent); color: var(--text); }
  .kb-assignee-chip { padding-left: 4px; }
  .kb-chip-avatar { width: 26px; height: 26px; flex: 0 0 26px; font-size: 10px; }
  .kb-chip-swatch { width: 11px; height: 11px; flex: 0 0 11px; border-radius: 3px; }
  .kb-due-chip.is-overdue { color: var(--kb-danger); border-color: color-mix(in srgb, var(--kb-danger) 45%, var(--border)); }
  .kb-due-chip.is-soon { color: var(--kb-warning); border-color: color-mix(in srgb, var(--kb-warning) 45%, var(--border)); }
  .kb-section { min-width: 0; display: flex; flex-direction: column; gap: 8px; padding: 14px 0; border-top: 1px solid var(--border); }
  .kb-section-head { min-height: 20px; display: flex; align-items: center; gap: 8px; }
  .kb-section-head h3, .kb-section-line h3, .kb-fold-toggle h3 { margin: 0; color: var(--muted); font-size: 14px; font-weight: 620; letter-spacing: -0.005em; }
  .kb-section-count { color: var(--muted); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .kb-section-progress { flex: 0 1 120px; height: 5px; overflow: hidden; border-radius: 3px; background: var(--surface-2); }
  .kb-section-progress > span { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width 0.25s ease; }
  .kb-section-progress.is-done > span { background: var(--kb-success); }
  .kb-section-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; }
  .kb-show-more, .kb-quiet-action { min-height: 36px; display: inline-flex; align-items: center; gap: 5px; padding: 0; border: 0; background: transparent; font: 600 13px/1 var(--font); cursor: pointer; }
  .kb-show-more { color: var(--accent); }
  .kb-show-more > svg { width: 14px; height: 14px; transition: transform 0.2s ease; }
  .kb-show-more.is-expanded > svg { transform: rotate(180deg); }
  .kb-quiet-action { color: var(--muted); }
  .kb-quiet-action:hover:not(:disabled) { color: var(--text); }
  .kb-quiet-action:disabled { opacity: 0.5; cursor: default; }
  .kb-quiet-action > svg { width: 14px; height: 14px; }
  .kb-mini-spinner { width: 12px; height: 12px; flex: 0 0 12px; border: 2px solid color-mix(in srgb, var(--muted) 35%, transparent); border-top-color: var(--accent); border-radius: 50%; animation: kb-loading-spin 0.8s linear infinite; }
  .kb-description .kb-notes-display { min-height: 0; margin: 0 -10px; padding: 8px 10px; background: transparent; }
  .kb-description .kb-notes-display.kb-notes-empty, .kb-description .kb-notes-display[data-empty="true"] { color: var(--muted); }
  .kb-notes-display.is-clamped:not(:focus) { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden; padding-block: 0; margin-block: 8px; }
  .kb-notes-conflict { padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--kb-warning) 45%, var(--border)); border-radius: 10px; background: color-mix(in srgb, var(--kb-warning) 9%, transparent); }
  .kb-notes-conflict p { margin: 0 0 8px; font-size: 13px; line-height: 1.45; }
  .kb-notes-conflict-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .kb-notes-conflict-actions .kb-btn { min-height: 40px; }
  .kb-section .kb-checklist { gap: 2px; }
  .kb-check-delete { opacity: 0; transition: opacity 0.15s ease; }
  .kb-check-item:hover .kb-check-delete, .kb-check-delete:focus-visible { opacity: 1; }
  .kb-pr-section { gap: 2px; }
  .kb-attachment-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .kb-attachment-tile { position: relative; min-width: 0; margin: 0; }
  .kb-attachment-open { width: 100%; display: flex; flex-direction: column; gap: 6px; padding: 6px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); color: var(--text); text-align: left; cursor: pointer; }
  .kb-attachment-open:hover { border-color: color-mix(in srgb, var(--text) 26%, var(--border)); }
  .kb-attachment-thumb { width: 100%; height: 64px; display: block; border-radius: 7px; object-fit: cover; background: color-mix(in srgb, var(--surface) 60%, var(--surface-2)); }
  .kb-attachment-file { display: grid; place-items: center; color: var(--muted); font: 700 11px/1 var(--font); letter-spacing: 0.04em; }
  .kb-attachment-open figcaption { overflow: hidden; padding: 0 2px; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .kb-attachment-remove { position: absolute; top: 10px; right: 10px; width: 30px; height: 30px; min-height: 30px; background: color-mix(in srgb, var(--surface) 85%, transparent); opacity: 0; transition: opacity 0.15s ease; }
  .kb-attachment-tile:hover .kb-attachment-remove, .kb-attachment-remove:focus-visible { opacity: 1; }
  @media (hover: none) {
    .kb-attachment-remove { opacity: 1; }
    .kb-check-item:not(.is-editing) .kb-check-delete { display: none; }
    .kb-check-item.is-editing .kb-check-delete { opacity: 1; }
  }
  .kb-folding { gap: 4px; }
  .kb-fold-toggle { width: calc(100% + 16px); min-height: 44px; margin: -6px -8px; padding: 0 8px; display: flex; align-items: center; gap: 8px; border: 0; border-radius: 10px; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
  .kb-fold-toggle:hover { background: color-mix(in srgb, var(--surface-2) 70%, transparent); }
  .kb-fold-summary { min-width: 0; margin-left: auto; overflow: hidden; color: var(--muted); font-size: 12.5px; text-overflow: ellipsis; white-space: nowrap; }
  .kb-fold-chevron { width: 15px; height: 15px; flex: 0 0 auto; color: var(--muted); transform: rotate(-90deg); transition: transform 0.2s ease; }
  .kb-fold-toggle[aria-expanded="true"] .kb-fold-chevron { transform: none; }
  .kb-card-activity .kb-activity-list { max-height: 460px; margin-top: 8px; overflow-y: auto; overscroll-behavior: contain; }
  .kb-activity-item.is-change .kb-activity-dot { background: var(--accent); }
  .kb-activity-item.is-assignment .kb-activity-dot { background: var(--kb-success); }
  .kb-activity-copy strong { font-weight: 650; }
  .kb-activity-note { margin: 6px 0 0; color: var(--muted); font-size: 12.5px; line-height: 1.45; }
  .kb-card-sheet .kb-card-danger-zone { display: flex; align-items: center; gap: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
  .kb-card-created { margin-left: auto; color: var(--muted); font-size: 12px; white-space: nowrap; }
  .kb-card-sheet .kb-delete-card { width: auto; min-height: 40px; margin-left: -10px; padding: 0 10px; justify-content: flex-start; border: 0; background: transparent; color: var(--kb-danger); }
  .kb-card-sheet .kb-delete-card:hover { background: color-mix(in srgb, var(--kb-danger) 10%, transparent); }
  @media (max-width: 640px) {
    .kb-card-sheet { width: calc(100% - 16px); padding: 10px 16px max(16px, env(safe-area-inset-bottom)); }
    .kb-detail-chip { height: 40px; min-height: 40px; }
    .kb-attachment-tiles { gap: 6px; }
  }

  /* ---- Board: same-size cards, list menu, folded lists, list drag ---- */
  .kb-due.kb-due-tone-soon { color: var(--kb-warning); background: color-mix(in srgb, #f59e0b 14%, transparent); }
  .kb-col-head { cursor: grab; user-select: none; }
  .kb-col-head .kb-col-name { cursor: text; }
  .kb-col-menu { margin-left: auto; margin-right: -6px; }
  .kb-menu-trigger { width: 36px; height: 36px; color: var(--muted); }
  .kb-menu-trigger > svg { width: 17px; height: 17px; }
  .kb-menu-button { position: relative; }
  .kb-popover-menu.kb-menu-end:not(.is-sheet) { left: auto; right: 0; min-width: 190px; }
  .kb-popover-menu > button:disabled { opacity: 0.4; cursor: default; background: transparent; }
  .kb-popover-menu > .kb-menu-back { min-height: 40px; gap: 4px; color: var(--muted); font-weight: 600; }
  .kb-popover-menu > .kb-menu-back > svg { margin-left: 0; color: inherit; }
  .kb-col { transition: box-shadow 0.15s ease; }
  .kb-col-dragging { position: relative; z-index: 6; cursor: grabbing; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45), 0 0 0 2px var(--accent); transition: none; }
  .kb-col-drop-before { box-shadow: -8px 0 0 -5px var(--accent); }
  .kb-col-drop-after { box-shadow: 8px 0 0 -5px var(--accent); }
  .kb-col.kb-col-folded { width: 52px; flex: 0 0 52px; align-self: flex-start; padding: 0; }
  .kb-col-unfold { width: 100%; min-height: 160px; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 14px 0; border: 0; border-radius: inherit; background: transparent; color: var(--text); font: 650 14px/1 var(--font); cursor: pointer; }
  .kb-col-unfold:hover { background: color-mix(in srgb, var(--surface-2) 60%, transparent); }
  .kb-col-unfold:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .kb-col-unfold .kb-col-status { margin: 0; }
  .kb-col-folded-name { writing-mode: vertical-rl; white-space: nowrap; letter-spacing: -0.01em; }
  @media (max-width: 640px) {
    .kb-menu-trigger { width: 44px; height: 44px; }
  }

  .kb-capacity-warning { margin: 8px 20px 0; padding: 10px 14px; border: 1px solid color-mix(in srgb, var(--kb-warning) 45%, var(--border)); border-radius: 12px; background: color-mix(in srgb, var(--kb-warning) 10%, transparent); color: var(--text); font-size: 13px; line-height: 1.45; }
  .kb-capacity-warning strong { font-weight: 650; }
  @media (max-width: 640px) { .kb-capacity-warning { margin-inline: 16px; } }
`
