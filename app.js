/* app.js — FRC Fantasy Draft Board application logic
   Pulls EPA from Statbotics API and OPR from The Blue Alliance API.
   All state persisted to localStorage. No build tools required. */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const STATBOTICS_BASE = 'https://api.statbotics.io/v3';
const TBA_BASE        = 'https://www.thebluealliance.com/api/v3';
const LS_SETTINGS     = 'frc_draft_settings';
const LS_LISTS        = 'frc_draft_lists';
const LS_ACTIVE       = 'frc_draft_active';

// ─── App State ────────────────────────────────────────────────────────────────
let state = {
  teams: [],           // [{num, name, epa, opr, auto, teleop, endgame, score, notes, picked, pick1, pick2}]
  savedLists: {},      // {name: serialized list}
  activeListName: null,
  sortCol: 'score',
  sortAsc: false,
  doublePick: false,
  showPicked: true,
  searchQuery: '',
  weights: { epa: 60, opr: 40, auto: 20, endgame: 15 },
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const sidebar        = $('sidebar');
const sidebarBackdrop= $('sidebar-backdrop');
const mainWrapper    = $('main-wrapper');
const teamList       = $('team-list');
const emptyState     = $('empty-state');
const tableHeader    = $('table-header');
const statsBar       = $('stats-bar');
const loadingOverlay = $('loading-overlay');
const loadingText    = $('loading-text');
const toast          = $('toast');
const eventBadge     = $('event-badge');
const currentListName= $('current-list-name');
const savedListsCont = $('saved-lists-container');

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadSavedLists();
  bindEvents();
  renderSavedLists();

  // Restore last active list if any
  const active = localStorage.getItem(LS_ACTIVE);
  if (active && state.savedLists[active]) {
    loadList(active);
  }

  // Wire sortable
  initSortable();
});

// ─── Settings Persistence ─────────────────────────────────────────────────────
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
    if (s.tbaKey)    $('tba-key').value    = s.tbaKey;
    if (s.eventKey)  $('event-key').value  = s.eventKey;
    if (s.year)      $('year-select').value = s.year;
    if (s.weights)   Object.assign(state.weights, s.weights);
  } catch {}

  // Apply weights to sliders
  $('w-epa').value      = state.weights.epa;
  $('w-opr').value      = state.weights.opr;
  $('w-auto').value     = state.weights.auto;
  $('w-endgame').value  = state.weights.endgame;
  $('w-epa-val').textContent     = state.weights.epa;
  $('w-opr-val').textContent     = state.weights.opr;
  $('w-auto-val').textContent    = state.weights.auto;
  $('w-endgame-val').textContent = state.weights.endgame;
}

function saveSettings() {
  localStorage.setItem(LS_SETTINGS, JSON.stringify({
    tbaKey:   $('tba-key').value.trim(),
    eventKey: $('event-key').value.trim(),
    year:     $('year-select').value,
    weights:  state.weights,
  }));
}

// ─── Saved Lists ──────────────────────────────────────────────────────────────
function loadSavedLists() {
  try {
    state.savedLists = JSON.parse(localStorage.getItem(LS_LISTS) || '{}');
  } catch { state.savedLists = {}; }
}

function persistLists() {
  localStorage.setItem(LS_LISTS, JSON.stringify(state.savedLists));
}

function saveCurrentList(name) {
  state.savedLists[name] = state.teams.map(t => ({
    num: t.num, name: t.name,
    epa: t.epa, opr: t.opr,
    auto: t.auto, teleop: t.teleop, endgame: t.endgame,
    score: t.score,
    notes: t.notes,
    picked: t.picked,
    pick1: t.pick1,
    pick2: t.pick2,
  }));
  persistLists();
  state.activeListName = name;
  localStorage.setItem(LS_ACTIVE, name);
  currentListName.textContent = name;
  renderSavedLists();
  showToast(`✓ Saved "${name}"`, 'success');
}

function loadList(name) {
  const data = state.savedLists[name];
  if (!data) return;
  state.teams = data.map(t => ({ ...t }));
  state.activeListName = name;
  localStorage.setItem(LS_ACTIVE, name);
  currentListName.textContent = name;
  renderTeams();
  updateStats();
  showUI();
  renderSavedLists();
}

function deleteList(name) {
  delete state.savedLists[name];
  persistLists();
  if (state.activeListName === name) {
    state.activeListName = null;
    localStorage.removeItem(LS_ACTIVE);
    currentListName.textContent = 'Unsaved List';
  }
  renderSavedLists();
  showToast(`Deleted "${name}"`, 'info');
}

function renderSavedLists() {
  const names = Object.keys(state.savedLists);
  savedListsCont.innerHTML = '';
  if (!names.length) {
    savedListsCont.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:4px 0">No saved lists yet</div>';
    return;
  }
  names.forEach(name => {
    const item = document.createElement('div');
    item.className = 'saved-list-item' + (name === state.activeListName ? ' active-list' : '');
    item.innerHTML = `
      <span class="saved-list-name" title="${esc(name)}">${esc(name)}</span>
      <span class="saved-list-meta">${state.savedLists[name].length} teams</span>
      <button class="saved-list-delete" title="Delete list" aria-label="Delete ${esc(name)}">✕</button>
    `;
    item.querySelector('.saved-list-name').addEventListener('click', () => {
      loadList(name);
      closeSidebar();
    });
    item.querySelector('.saved-list-delete').addEventListener('click', e => {
      e.stopPropagation();
      if (confirm(`Delete list "${name}"?`)) deleteList(name);
    });
    savedListsCont.appendChild(item);
  });
}

// ─── API Fetching ─────────────────────────────────────────────────────────────
async function fetchData() {
  const tbaKey   = $('tba-key').value.trim();
  const eventKey = $('event-key').value.trim();
  const year     = $('year-select').value;

  showLoading('Fetching Statbotics EPA data…');

  let epaMap = {};
  let oprMap = {};

  try {
    // ── Statbotics ──
    let sbUrl;
    if (eventKey) {
      sbUrl = `${STATBOTICS_BASE}/team_events?event=${encodeURIComponent(eventKey)}&limit=500`;
    } else {
      sbUrl = `${STATBOTICS_BASE}/teams?limit=500&offseason=false`;
    }

    const sbResp = await fetch(sbUrl);
    if (!sbResp.ok) throw new Error(`Statbotics error: ${sbResp.status}`);
    const sbData = await sbResp.json();

    if (eventKey) {
      // team_events format
      sbData.forEach(te => {
        const num  = te.team;
        const epa  = te.epa?.total_points?.mean  ?? null;
        const auto = te.epa?.auto?.mean           ?? null;
        const tele = te.epa?.teleop?.mean         ?? null;
        const end  = te.epa?.endgame?.mean        ?? null;
        epaMap[num] = { epa, auto, teleop: tele, endgame: end, name: te.team_name || `Team ${num}` };
      });
    } else {
      // teams format
      sbData.forEach(t => {
        const num  = t.team;
        const epa  = t.epa?.total_points?.mean  ?? null;
        const auto = t.epa?.auto?.mean           ?? null;
        const tele = t.epa?.teleop?.mean         ?? null;
        const end  = t.epa?.endgame?.mean        ?? null;
        epaMap[num] = { epa, auto, teleop: tele, endgame: end, name: t.nickname || `Team ${num}` };
      });
    }

    // ── TBA OPR (optional) ──
    if (eventKey && tbaKey) {
      loadingText.textContent = 'Fetching TBA OPR data…';
      try {
        const tbaResp = await fetch(`${TBA_BASE}/event/${encodeURIComponent(eventKey)}/oprs`, {
          headers: { 'X-TBA-Auth-Key': tbaKey },
        });
        if (tbaResp.ok) {
          const tbaData = await tbaResp.json();
          const oprs = tbaData.oprs || {};
          Object.entries(oprs).forEach(([key, val]) => {
            // TBA team keys look like "frc254"
            const num = parseInt(key.replace('frc', ''), 10);
            oprMap[num] = val;
          });
        } else if (tbaResp.status === 401) {
          showToast('TBA API key invalid — OPR skipped', 'error');
        } else {
          showToast(`TBA returned ${tbaResp.status} — OPR skipped`, 'info');
        }
      } catch (e) {
        showToast('Could not reach TBA API — OPR skipped', 'info');
      }
    } else if (eventKey && !tbaKey) {
      showToast('No TBA key — OPR data skipped', 'info');
    }

    // ── Build team list ──
    const teams = Object.entries(epaMap).map(([num, d]) => {
      const opr = oprMap[num] ?? null;
      return {
        num:     parseInt(num, 10),
        name:    d.name,
        epa:     d.epa,
        auto:    d.auto,
        teleop:  d.teleop,
        endgame: d.endgame,
        opr:     opr,
        score:   0,
        notes:   '',
        picked:  false,
        pick1:   false,
        pick2:   false,
      };
    });

    if (!teams.length) {
      hideLoading();
      showToast('No teams found — check event key', 'error');
      return;
    }

    // Calculate composite scores and sort
    calcScores(teams);
    teams.sort((a, b) => b.score - a.score);

    state.teams = teams;
    state.activeListName = null;
    currentListName.textContent = 'Unsaved List';
    localStorage.removeItem(LS_ACTIVE);

    // Update event badge
    if (eventKey) {
      eventBadge.textContent = eventKey.toUpperCase();
      eventBadge.style.display = '';
    } else {
      eventBadge.style.display = 'none';
    }

    hideLoading();
    renderTeams();
    updateStats();
    showUI();
    renderSavedLists();
    showToast(`Loaded ${teams.length} teams`, 'success');

  } catch (err) {
    hideLoading();
    console.error(err);
    showToast(`Error: ${err.message}`, 'error');
  }
}

// ─── Score Calculation ────────────────────────────────────────────────────────
function calcScores(teams) {
  const w = state.weights;
  const total = w.epa + w.opr + w.auto + w.endgame || 1;

  // Normalise each metric 0–1 across all teams
  function normArr(arr) {
    const vals  = arr.filter(v => v !== null && !isNaN(v));
    if (!vals.length) return arr.map(() => 0);
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    if (mx === mn) return arr.map(v => v === null ? 0 : 0.5);
    return arr.map(v => v === null ? 0 : (v - mn) / (mx - mn));
  }

  const epaNorm     = normArr(teams.map(t => t.epa));
  const oprNorm     = normArr(teams.map(t => t.opr));
  const autoNorm    = normArr(teams.map(t => t.auto));
  const endgameNorm = normArr(teams.map(t => t.endgame));

  teams.forEach((t, i) => {
    t.score = (
      epaNorm[i]     * w.epa      +
      oprNorm[i]     * w.opr      +
      autoNorm[i]    * w.auto     +
      endgameNorm[i] * w.endgame
    ) / total * 100;
  });
}

function recalcAndRender() {
  if (!state.teams.length) return;
  calcScores(state.teams);
  // Re-sort by score only if currently sorted by score
  if (state.sortCol === 'score') {
    state.teams.sort((a, b) => state.sortAsc ? a.score - b.score : b.score - a.score);
  }
  renderTeams();
  updateStats();
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderTeams() {
  teamList.innerHTML = '';

  const q = state.searchQuery.toLowerCase();

  state.teams.forEach((team, idx) => {
    const isMatch = !q
      || String(team.num).includes(q)
      || team.name.toLowerCase().includes(q);

    const li = document.createElement('li');
    li.className = 'team-row' +
      (team.picked  ? ' picked'  : '') +
      (team.pick1   ? ' double-picked-1' : '') +
      (team.pick2   ? ' double-picked-2' : '') +
      (!isMatch     ? ' hidden-row' : '') +
      (!state.showPicked && (team.picked || team.pick1 || team.pick2) ? ' hidden-row' : '');

    li.dataset.num = team.num;

    const fmt = v => (v === null || v === undefined) ? '<span class="no-data">—</span>' : (+v).toFixed(1);

    li.innerHTML = `
      <div class="drag-handle" title="Drag to reorder">⠿</div>
      <div class="row-rank">${idx + 1}</div>
      <div class="row-team" title="View details">
        <div>
          <div class="team-num">${team.num} <span class="picked-badge">PICKED</span><span class="pick-num-badge pick-1">P1</span><span class="pick-num-badge pick-2">P2</span></div>
          <div class="team-name">${esc(team.name)}</div>
        </div>
      </div>
      <div class="row-score row-stat">${team.score.toFixed(1)}</div>
      <div class="row-stat accent-teal">${fmt(team.epa)}</div>
      <div class="row-stat" style="color:#c9a0f8">${fmt(team.opr)}</div>
      <div class="row-stat auto-col" style="color:var(--accent-green)">${fmt(team.auto)}</div>
      <div class="row-stat teleop-col" style="color:#7eb8f7">${fmt(team.teleop)}</div>
      <div class="row-stat" style="color:var(--accent-yellow)">${fmt(team.endgame)}</div>
      <div class="row-notes-cell">
        <textarea class="notes-input" placeholder="Notes…" rows="1">${esc(team.notes)}</textarea>
      </div>
      <div class="row-actions">
        <button class="pick-btn" title="Toggle picked status">${team.picked ? 'Unpick' : 'Pick'}</button>
        <div class="dpick-wrap">
          <button class="dpick-btn p1 ${team.pick1 ? 'active' : ''}" title="Toggle Pick 1">P1</button>
          <button class="dpick-btn p2 ${team.pick2 ? 'active' : ''}" title="Toggle Pick 2">P2</button>
        </div>
      </div>
    `;

    // Notes
    const notesEl = li.querySelector('.notes-input');
    notesEl.addEventListener('input', () => {
      team.notes = notesEl.value;
      autoSave();
    });

    // Click team info → detail modal
    li.querySelector('.row-team').addEventListener('click', () => showDetailModal(team, idx + 1));

    // Single pick
    li.querySelector('.pick-btn').addEventListener('click', () => {
      team.picked = !team.picked;
      if (team.picked) { team.pick1 = false; team.pick2 = false; }
      renderTeams();
      updateStats();
      autoSave();
    });

    // Double pick P1
    li.querySelector('.dpick-btn.p1').addEventListener('click', () => {
      team.pick1 = !team.pick1;
      if (team.pick1) { team.picked = false; }
      renderTeams();
      updateStats();
      autoSave();
    });

    // Double pick P2
    li.querySelector('.dpick-btn.p2').addEventListener('click', () => {
      team.pick2 = !team.pick2;
      if (team.pick2) { team.picked = false; }
      renderTeams();
      updateStats();
      autoSave();
    });

    teamList.appendChild(li);
  });

  // Re-init sortable after re-render
  initSortable();
}

function showUI() {
  emptyState.style.display   = 'none';
  tableHeader.style.display  = '';
  statsBar.style.display     = '';
}

function updateStats() {
  const total     = state.teams.length;
  const picked    = state.teams.filter(t => t.picked || t.pick1 || t.pick2).length;
  const available = total - picked;
  const epas      = state.teams.map(t => t.epa).filter(v => v !== null);
  const avgEpa    = epas.length ? (epas.reduce((a, b) => a + b, 0) / epas.length).toFixed(1) : '—';
  const topEpa    = epas.length ? Math.max(...epas).toFixed(1) : '—';

  $('stat-total').textContent    = total;
  $('stat-picked').textContent   = picked;
  $('stat-available').textContent= available;
  $('stat-avg-epa').textContent  = avgEpa;
  $('stat-top-epa').textContent  = topEpa;
}

function autoSave() {
  if (state.activeListName) {
    state.savedLists[state.activeListName] = state.teams.map(t => ({ ...t }));
    persistLists();
  }
}

// ─── Detail Modal ─────────────────────────────────────────────────────────────
function showDetailModal(team, rank) {
  $('detail-modal-title').textContent = `Team ${team.num}`;
  const body = $('detail-modal-body');
  const fmt = v => (v === null || v === undefined) ? '—' : (+v).toFixed(2);

  body.innerHTML = `
    <div class="detail-team-header">
      <div>
        <div class="detail-team-num">${team.num}</div>
        <div class="detail-team-name">${esc(team.name)}</div>
      </div>
      <div class="detail-team-rank"># ${rank}</div>
    </div>
    <div class="detail-grid">
      <div class="detail-card">
        <div class="detail-card-label">Composite Score</div>
        <div class="detail-card-val purple">${team.score.toFixed(1)}</div>
      </div>
      <div class="detail-card">
        <div class="detail-card-label">EPA Total</div>
        <div class="detail-card-val teal">${fmt(team.epa)}</div>
      </div>
      <div class="detail-card">
        <div class="detail-card-label">OPR</div>
        <div class="detail-card-val" style="color:#c9a0f8">${fmt(team.opr)}</div>
      </div>
      <div class="detail-card">
        <div class="detail-card-label">Auto EPA</div>
        <div class="detail-card-val green">${fmt(team.auto)}</div>
      </div>
      <div class="detail-card">
        <div class="detail-card-label">Teleop EPA</div>
        <div class="detail-card-val" style="color:#7eb8f7">${fmt(team.teleop)}</div>
      </div>
      <div class="detail-card">
        <div class="detail-card-label">Endgame EPA</div>
        <div class="detail-card-val yellow">${fmt(team.endgame)}</div>
      </div>
    </div>
    ${team.notes ? `<div style="margin-top:8px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;color:var(--text-secondary)"><strong style="color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em">Notes</strong><div style="margin-top:4px">${esc(team.notes)}</div></div>` : ''}
  `;

  $('detail-modal').style.display = 'flex';
}

// ─── Sorting ──────────────────────────────────────────────────────────────────
function sortBy(col) {
  if (state.sortCol === col) {
    state.sortAsc = !state.sortAsc;
  } else {
    state.sortCol = col;
    state.sortAsc = false;
  }

  const mult = state.sortAsc ? 1 : -1;
  const key  = { team: 'num', score: 'score', epa: 'epa', opr: 'opr', auto: 'auto', teleop: 'teleop', endgame: 'endgame' }[col] || col;

  state.teams.sort((a, b) => {
    const av = a[key] ?? -Infinity;
    const bv = b[key] ?? -Infinity;
    return (av < bv ? -1 : av > bv ? 1 : 0) * mult;
  });

  // Update header arrows
  document.querySelectorAll('.sortable-col').forEach(el => {
    el.classList.remove('active-sort');
    el.querySelector('.sort-arrow').textContent = '';
  });
  const activeCol = document.querySelector(`.sortable-col[data-col="${col}"]`);
  if (activeCol) {
    activeCol.classList.add('active-sort');
    activeCol.querySelector('.sort-arrow').textContent = state.sortAsc ? '↑' : '↓';
  }

  renderTeams();
}

// ─── Sortable drag-and-drop ────────────────────────────────────────────────────
let sortableInstance = null;

function initSortable() {
  if (sortableInstance) sortableInstance.destroy();
  sortableInstance = Sortable.create(teamList, {
    animation: 150,
    handle: '.drag-handle',
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    onEnd(evt) {
      const { oldIndex, newIndex } = evt;
      if (oldIndex === newIndex) return;
      const moved = state.teams.splice(oldIndex, 1)[0];
      state.teams.splice(newIndex, 0, moved);
      renderTeams();
      autoSave();
    },
  });
}

// ─── Copy to Discord ──────────────────────────────────────────────────────────
function copyToDiscord() {
  const available = state.teams.filter(t => !t.picked && !t.pick1 && !t.pick2);
  if (!available.length) {
    showToast('No unpicked teams to copy', 'info');
    return;
  }

  const lines = available.map((t, i) => `${i + 1}. ${t.num}`).join('\n');
  const text  = `📋 **Draft Picklist**\n${lines}`;

  navigator.clipboard.writeText(text).then(() => {
    showToast('✓ Copied to clipboard!', 'success');
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity  = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('✓ Copied to clipboard!', 'success');
  });
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function openSidebar() {
  sidebar.classList.add('open');
  sidebarBackdrop.classList.add('visible');
  mainWrapper.classList.add('sidebar-open');
}

function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('visible');
  mainWrapper.classList.remove('sidebar-open');
}

function toggleSidebar() {
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
}

// ─── Modals ───────────────────────────────────────────────────────────────────
function openModal(id) { $(id).style.display = 'flex'; }
function closeModal(id) { $(id).style.display = 'none'; }

document.addEventListener('click', e => {
  const closeBtn = e.target.closest('.modal-close');
  if (closeBtn) {
    const modalId = closeBtn.dataset.modal;
    if (modalId) closeModal(modalId);
  }
  // Close modal on backdrop click
  if (e.target.classList.contains('modal-backdrop')) {
    e.target.style.display = 'none';
  }
});

// ─── Loading ──────────────────────────────────────────────────────────────────
function showLoading(msg = 'Loading…') {
  loadingText.textContent = msg;
  loadingOverlay.style.display = 'flex';
}

function hideLoading() {
  loadingOverlay.style.display = 'none';
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = '') {
  toast.textContent = msg;
  toast.className   = 'toast' + (type ? ` toast-${type}` : '');
  // force reflow
  void toast.offsetWidth;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Event Bindings ───────────────────────────────────────────────────────────
function bindEvents() {
  // Sidebar toggle
  $('sidebar-toggle').addEventListener('click', toggleSidebar);
  $('sidebar-close').addEventListener('click', closeSidebar);
  sidebarBackdrop.addEventListener('click', closeSidebar);

  // Load data
  $('load-data-btn').addEventListener('click', () => {
    saveSettings();
    fetchData();
    closeSidebar();
  });

  // Generate list (alias)
  $('generate-btn').addEventListener('click', () => {
    saveSettings();
    fetchData();
  });

  $('empty-generate-btn').addEventListener('click', () => {
    openSidebar();
  });

  // Recalculate weights
  $('recalc-btn').addEventListener('click', () => {
    state.weights.epa      = +$('w-epa').value;
    state.weights.opr      = +$('w-opr').value;
    state.weights.auto     = +$('w-auto').value;
    state.weights.endgame  = +$('w-endgame').value;
    saveSettings();
    recalcAndRender();
    showToast('Scores recalculated', 'success');
  });

  // Weight slider live update
  ['epa', 'opr', 'auto', 'endgame'].forEach(key => {
    const slider = $(`w-${key}`);
    const valEl  = $(`w-${key}-val`);
    slider.addEventListener('input', () => {
      valEl.textContent = slider.value;
      state.weights[key] = +slider.value;
    });
  });

  // Reset order
  $('reset-order-btn').addEventListener('click', () => {
    if (!state.teams.length) return;
    calcScores(state.teams);
    state.teams.sort((a, b) => b.score - a.score);
    state.sortCol = 'score';
    state.sortAsc = false;
    renderTeams();
    showToast('Order reset to score rank', 'info');
  });

  // Save list
  $('save-list-btn').addEventListener('click', () => {
    if (!state.teams.length) { showToast('Nothing to save', 'info'); return; }
    $('list-name-input').value = state.activeListName || '';
    openModal('save-modal');
    setTimeout(() => $('list-name-input').focus(), 50);
  });

  $('confirm-save-btn').addEventListener('click', () => {
    const name = $('list-name-input').value.trim();
    if (!name) { showToast('Enter a list name', 'error'); return; }
    saveCurrentList(name);
    closeModal('save-modal');
  });

  $('list-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('confirm-save-btn').click();
  });

  // New list
  $('new-list-btn').addEventListener('click', () => {
    if (state.teams.length) {
      openModal('new-list-modal');
    } else {
      clearList();
    }
  });

  $('confirm-new-list-btn').addEventListener('click', () => {
    clearList();
    closeModal('new-list-modal');
    closeSidebar();
  });

  function clearList() {
    state.teams = [];
    state.activeListName = null;
    localStorage.removeItem(LS_ACTIVE);
    currentListName.textContent = 'Unsaved List';
    teamList.innerHTML = '';
    emptyState.style.display   = '';
    tableHeader.style.display  = 'none';
    statsBar.style.display     = 'none';
    eventBadge.style.display   = 'none';
    renderSavedLists();
  }

  // Double pick mode
  $('double-pick-btn').addEventListener('click', () => {
    state.doublePick = !state.doublePick;
    document.body.classList.toggle('double-pick-mode', state.doublePick);
    $('double-pick-btn').classList.toggle('active', state.doublePick);
    showToast(state.doublePick ? 'Double-pick mode ON' : 'Double-pick mode OFF', 'info');
  });

  // Show/hide picked
  $('hide-picked-btn').addEventListener('click', () => {
    state.showPicked = !state.showPicked;
    $('hide-picked-btn').textContent = state.showPicked ? 'Hide Picked' : 'Show Picked';
    $('hide-picked-btn').classList.toggle('active', !state.showPicked);
    renderTeams();
  });

  // Copy to Discord
  $('copy-discord-btn').addEventListener('click', copyToDiscord);

  // Search
  const searchInput = $('search-input');
  const searchClear = $('search-clear');

  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value;
    searchClear.style.display = state.searchQuery ? '' : 'none';
    renderTeams();
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    state.searchQuery = '';
    searchClear.style.display = 'none';
    renderTeams();
    searchInput.focus();
  });

  // Column sort
  document.querySelectorAll('.sortable-col').forEach(col => {
    col.addEventListener('click', () => sortBy(col.dataset.col));
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop').forEach(m => {
        if (m.style.display !== 'none') m.style.display = 'none';
      });
      if (sidebar.classList.contains('open')) closeSidebar();
    }
    // Ctrl/Cmd + S → save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      $('save-list-btn').click();
    }
    // Ctrl/Cmd + F → focus search
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  // Open sidebar by default on desktop (>= 900px)
  if (window.innerWidth >= 900) {
    openSidebar();
  }
}
