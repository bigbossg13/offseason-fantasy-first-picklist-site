/* app.js — FRC Fantasy Draft Board application logic.
   Pulls EPA data from Statbotics API and OPR from The Blue Alliance API.
   All state is persisted to localStorage. No build tools or npm required.
   Works as a fully static site on GitHub Pages. */

'use strict';

// ─── API Base URLs ────────────────────────────────────────────────────────────
const STATBOTICS_BASE = 'https://api.statbotics.io/v3';
const TBA_BASE        = 'https://www.thebluealliance.com/api/v3';

// ─── localStorage keys ───────────────────────────────────────────────────────
const LS_SETTINGS = 'frc_draft_settings';
const LS_LISTS    = 'frc_draft_lists';
const LS_ACTIVE   = 'frc_draft_active';

// ─── App State ────────────────────────────────────────────────────────────────
let state = {
  teams: [],          // [{num, name, epa, opr, auto, teleop, endgame, notes, picked, pick1, pick2}]
  savedLists: {},     // { listName: [teamData, ...] }
  activeListName: null,
  sortCol: 'epa',
  sortAsc: false,
  doublePick: false,
  showPicked: true,
  searchQuery: '',
};

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls)  e.className   = cls;
  if (text) e.textContent = text;
  return e;
};

// ─── Cached DOM refs ──────────────────────────────────────────────────────────
let sidebar, mainContent, picklistTable, picklistBody,
    emptyState, loadingOverlay, loadingText, toast, eventBadge,
    filterMeta, savedListsCont, errorBanner, errorMsg;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Cache DOM refs
  sidebar         = $('sidebar');
  mainContent     = $('mainContent');
  picklistTable   = $('picklistTable');
  picklistBody    = $('picklistBody');
  emptyState      = $('emptyState');
  loadingOverlay  = $('loadingOverlay');
  loadingText     = $('loadingText');
  toast           = $('toast');
  eventBadge      = $('eventBadge');
  filterMeta      = $('filterMeta');
  savedListsCont  = $('savedListsContainer');
  errorBanner     = $('errorBanner');
  errorMsg        = $('errorMessage');

  loadSettings();
  loadSavedLists();
  bindEvents();
  renderSavedLists();

  // Restore last active list — skip if it has no EPA data (stale/corrupt)
  const active = localStorage.getItem(LS_ACTIVE);
  if (active && state.savedLists[active]) {
    const saved = state.savedLists[active];
    const hasEpa = saved.some(t => t.epa != null);
    if (hasEpa) {
      loadList(active);
    } else {
      // Stale list with no data — clear active pointer but keep the save
      localStorage.removeItem(LS_ACTIVE);
    }
  }

  // Initialise sortable on empty tbody (will re-init after data loads)
  initSortable();

  // On wide screens, open sidebar by default
  if (window.innerWidth >= 900) openSidebar();
});

// ─── Settings Persistence ─────────────────────────────────────────────────────
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
    if (s.tbaKey)   $('tbaKeyInput').value   = s.tbaKey;
    if (s.eventKey) $('eventKeyInput').value = s.eventKey;
    if (s.year)     $('yearSelect').value    = s.year;
  } catch (_) { /* ignore */ }
}

function saveSettings() {
  localStorage.setItem(LS_SETTINGS, JSON.stringify({
    tbaKey:   $('tbaKeyInput').value.trim(),
    eventKey: $('eventKeyInput').value.trim(),
    year:     $('yearSelect').value,
  }));
}

// ─── Saved Lists Persistence ──────────────────────────────────────────────────
function loadSavedLists() {
  try {
    state.savedLists = JSON.parse(localStorage.getItem(LS_LISTS) || '{}');
  } catch (_) { state.savedLists = {}; }
}

function persistLists() {
  localStorage.setItem(LS_LISTS, JSON.stringify(state.savedLists));
}

function saveCurrentList(name) {
  if (!state.teams.length) {
    showToast('Nothing to save — generate a list first.', 'error');
    return false;
  }
  state.savedLists[name] = state.teams.map(t => ({ ...t }));
  persistLists();
  state.activeListName = name;
  localStorage.setItem(LS_ACTIVE, name);
  renderSavedLists();
  showToast(`✓ Saved "${name}"`, 'success');
  return true;
}

function loadList(name) {
  const data = state.savedLists[name];
  if (!data) return;
  state.teams = data.map(t => ({ ...t }));
  state.activeListName = name;
  localStorage.setItem(LS_ACTIVE, name);
  showUI(name);   // must come before renderTeams so statsBar exists
  renderTeams();
  renderSavedLists();
}

function deleteList(name) {
  delete state.savedLists[name];
  persistLists();
  if (state.activeListName === name) {
    state.activeListName = null;
    localStorage.removeItem(LS_ACTIVE);
  }
  renderSavedLists();
  showToast(`Deleted "${name}"`, 'info');
}

function renderSavedLists() {
  const names = Object.keys(state.savedLists);
  savedListsCont.innerHTML = '';

  if (!names.length) {
    savedListsCont.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:6px 0">No saved lists yet.</div>';
    return;
  }

  names.forEach(name => {
    const div = el('div', 'saved-list-item' + (name === state.activeListName ? ' active-list' : ''));

    const nameSpan = el('span', 'saved-list-name', name);
    nameSpan.title = name;
    nameSpan.addEventListener('click', () => {
      loadList(name);
      closeSidebar();
    });

    const meta = el('span', 'saved-list-meta', `${state.savedLists[name].length} teams`);

    const del = el('button', 'saved-list-delete', '✕');
    del.title = `Delete "${name}"`;
    del.setAttribute('aria-label', `Delete list ${name}`);
    del.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm(`Delete list "${name}"?`)) deleteList(name);
    });

    div.appendChild(nameSpan);
    div.appendChild(meta);
    div.appendChild(del);
    savedListsCont.appendChild(div);
  });
}

// ─── Auto-save helper ─────────────────────────────────────────────────────────
function autoSave() {
  if (state.activeListName) {
    state.savedLists[state.activeListName] = state.teams.map(t => ({ ...t }));
    persistLists();
  }
}

// ─── API Data Fetching ────────────────────────────────────────────────────────
async function fetchData() {
  const tbaKey   = $('tbaKeyInput').value.trim();
  const eventKey = $('eventKeyInput').value.trim();

  saveSettings();
  showLoading('Fetching Statbotics EPA data…');
  hideError();

  let epaMap = {};
  let oprMap = {};

  try {
    // ── Statbotics ──────────────────────────────────────────────────────────
    let sbUrl;
    if (eventKey) {
      sbUrl = `${STATBOTICS_BASE}/team_events?event=${encodeURIComponent(eventKey)}&limit=500`;
    } else {
      sbUrl = `${STATBOTICS_BASE}/teams?limit=500&offseason=false`;
    }

    const sbResp = await fetch(sbUrl);
    if (!sbResp.ok) {
      if (sbResp.status === 404 && eventKey) {
        throw new Error(`Event "${eventKey}" not found on Statbotics. Check the event key.`);
      }
      throw new Error(`Statbotics API error: ${sbResp.status} ${sbResp.statusText}`);
    }

    const sbData = await sbResp.json();
    if (!Array.isArray(sbData) || sbData.length === 0) {
      throw new Error(eventKey
        ? `No teams found for event "${eventKey}". Is the event key correct?`
        : 'No team data returned from Statbotics.');
    }

    // Log first entry so we can inspect the actual response shape
    console.log('[Statbotics] Sample entry shape:', JSON.stringify(sbData[0], null, 2));

    if (eventKey) {
      sbData.forEach(te => {
        const num = te.team;
        epaMap[num] = {
          epa:     te.epa?.total_points?.mean ?? null,
          auto:    te.epa?.auto?.mean          ?? null,
          teleop:  te.epa?.teleop?.mean        ?? null,
          endgame: te.epa?.endgame?.mean       ?? null,
          name:    te.team_name || te.name || `Team ${num}`,
        };
      });
    } else {
      // teams shape: { team, nickname, epa: { total_points, auto, teleop, endgame } }
      sbData.forEach(t => {
        const num = t.team;
        epaMap[num] = {
          epa:     t.epa?.total_points?.mean ?? null,
          auto:    t.epa?.auto?.mean          ?? null,
          teleop:  t.epa?.teleop?.mean        ?? null,
          endgame: t.epa?.endgame?.mean       ?? null,
          name:    t.nickname || t.name || `Team ${num}`,
        };
      });
    }

    // ── TBA OPR (optional, only for events with a key + TBA key) ────────────
    if (eventKey && tbaKey) {
      updateLoadingText('Fetching TBA OPR data…');
      try {
        const tbaResp = await fetch(
          `${TBA_BASE}/event/${encodeURIComponent(eventKey)}/oprs`,
          { headers: { 'X-TBA-Auth-Key': tbaKey } }
        );
        if (tbaResp.ok) {
          const tbaData = await tbaResp.json();
          const oprs = tbaData.oprs || {};
          for (const [key, val] of Object.entries(oprs)) {
            const num = parseInt(key.replace('frc', ''), 10);
            if (!isNaN(num)) oprMap[num] = val;
          }
        } else if (tbaResp.status === 401) {
          showToast('TBA API key is invalid — OPR skipped.', 'error');
        } else if (tbaResp.status === 404) {
          showToast(`Event "${eventKey}" not found on TBA — OPR skipped.`, 'info');
        } else {
          showToast(`TBA returned ${tbaResp.status} — OPR skipped.`, 'info');
        }
      } catch (tbaErr) {
        showToast('Could not reach TBA API — OPR data skipped.', 'info');
      }
    } else if (eventKey && !tbaKey) {
      showToast('No TBA API key — OPR data unavailable. Enter your key in settings.', 'info');
    }

    // ── Build team array ─────────────────────────────────────────────────────
    updateLoadingText('Sorting by EPA…');
    const teams = Object.entries(epaMap).map(([numStr, d]) => ({
      num:     parseInt(numStr, 10),
      name:    d.name,
      epa:     d.epa,
      auto:    d.auto,
      teleop:  d.teleop,
      endgame: d.endgame,
      opr:     oprMap[parseInt(numStr, 10)] ?? null,
      notes:   '',
      picked:  false,
      pick1:   false,
      pick2:   false,
    }));

    if (!teams.length) {
      hideLoading();
      showToast('No teams found — check the event key and try again.', 'error');
      return;
    }

    teams.sort((a, b) => (b.epa ?? -Infinity) - (a.epa ?? -Infinity));

    state.teams          = teams;
    state.activeListName = null;
    state.sortCol        = 'epa';
    state.sortAsc        = false;
    localStorage.removeItem(LS_ACTIVE);

    // Update event badge
    if (eventKey) {
      eventBadge.textContent   = eventKey.toUpperCase();
      eventBadge.style.display = '';
      if (tbaKey) {
        fetchEventName(eventKey, tbaKey).then(name => {
          if (name) eventBadge.textContent = `${name} (${eventKey})`;
        });
      }
    } else {
      eventBadge.style.display = 'none';
    }

    hideLoading();
    showUI(null);   // must come before renderTeams so statsBar exists
    renderTeams();
    renderSavedLists();
    showToast(`Loaded ${teams.length} teams${Object.keys(oprMap).length ? ' with OPR' : ''}`, 'success');

  } catch (err) {
    hideLoading();
    console.error('[DraftBoard] fetchData error:', err);
    showError(err.message);
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function fetchEventName(eventKey, tbaKey) {
  try {
    const resp = await fetch(`${TBA_BASE}/event/${encodeURIComponent(eventKey)}`, {
      headers: { 'X-TBA-Auth-Key': tbaKey },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.name || null;
  } catch (_) { return null; }
}

// ─── Fetch EPA for a list of team numbers ─────────────────────────────────────
async function fetchEpaForNums(nums, year) {
  // Fetch team_year for requested year; fall back to previous year if all nulls
  async function tryYear(yr) {
    return Promise.allSettled(
      nums.map(num =>
        fetch(`${STATBOTICS_BASE}/team_year/${num}/${yr}`)
          .then(r => {
            if (!r.ok) { console.warn(`[Statbotics] ${num}/${yr} → HTTP ${r.status}`); return null; }
            return r.json();
          })
          .catch(e => { console.error(`[Statbotics] ${num}/${yr} fetch error:`, e); return null; })
      )
    );
  }

  let results = await tryYear(year);
  // Log the first successful result so we can inspect the shape
  const firstResult = results.find(r => r.status === 'fulfilled' && r.value !== null);
  if (firstResult) {
    console.log('[Statbotics] Sample team_year response:', JSON.stringify(firstResult.value, null, 2));
  } else {
    console.warn('[Statbotics] All requests returned null for year', year);
  }

  const hasData = results.some(r => r.status === 'fulfilled' && r.value?.epa?.total_points?.mean != null);

  // If no data for requested year, silently try the previous year
  if (!hasData && parseInt(year, 10) > 2018) {
    const fallbackYear = parseInt(year, 10) - 1;
    updateLoadingText(`No ${year} data — trying ${fallbackYear}…`);
    results = await tryYear(fallbackYear);
    const hasFallback = results.some(r => r.status === 'fulfilled' && r.value?.epa?.total_points?.mean != null);
    if (hasFallback) {
      showToast(`No ${year} EPA data found — showing ${fallbackYear} data instead`, 'info');
    }
  }

  return results;
}

// ─── Paste-in Team List Fetch ─────────────────────────────────────────────────
async function fetchFromPastedList() {
  const raw = $('pasteTeamInput').value.trim();
  if (!raw) {
    showToast('Paste some team numbers first.', 'error');
    return;
  }

  const nums = [...new Set(
    raw.split(/[\n,;\s]+/)
       .map(s => parseInt(s.trim(), 10))
       .filter(n => !isNaN(n) && n > 0)
  )];

  if (!nums.length) {
    showToast('No valid team numbers found in the pasted text.', 'error');
    return;
  }

  await loadTeamsFromNums(nums);
}

// ─── Refresh EPA for the currently displayed list ─────────────────────────────
async function refreshEpaForCurrentList() {
  if (!state.teams.length) {
    showToast('No teams loaded to refresh.', 'info');
    return;
  }
  const nums = state.teams.map(t => t.num);
  // Preserve notes, picked state, and manual order
  const preserved = {};
  state.teams.forEach(t => { preserved[t.num] = { notes: t.notes, picked: t.picked, pick1: t.pick1, pick2: t.pick2 }; });
  await loadTeamsFromNums(nums, preserved);
}

// ─── Core: fetch + build team list from an array of team numbers ───────────────
async function loadTeamsFromNums(nums, preserve = {}) {
  const year     = $('yearSelect').value;
  const tbaKey   = $('tbaKeyInput').value.trim();
  const eventKey = $('eventKeyInput').value.trim();

  saveSettings();
  showLoading(`Fetching EPA for ${nums.length} teams…`);
  hideError();

  try {
    const sbResults = await fetchEpaForNums(nums, year);

    let oprMap = {};
    if (eventKey && tbaKey) {
      updateLoadingText('Fetching TBA OPR data…');
      try {
        const tbaResp = await fetch(
          `${TBA_BASE}/event/${encodeURIComponent(eventKey)}/oprs`,
          { headers: { 'X-TBA-Auth-Key': tbaKey } }
        );
        if (tbaResp.ok) {
          const tbaData = await tbaResp.json();
          for (const [key, val] of Object.entries(tbaData.oprs || {})) {
            const n = parseInt(key.replace('frc', ''), 10);
            if (!isNaN(n)) oprMap[n] = val;
          }
        }
      } catch (_) { /* OPR optional */ }
    }

    const teams = [];
    sbResults.forEach((result, i) => {
      const num = nums[i];
      const d   = (result.status === 'fulfilled') ? result.value : null;
      const p   = preserve[num] || {};
      teams.push({
        num,
        name:    d?.name || d?.team_name || d?.nickname || `Team ${num}`,
        epa:     d?.epa?.total_points?.mean ?? null,
        auto:    d?.epa?.auto?.mean         ?? null,
        teleop:  d?.epa?.teleop?.mean       ?? null,
        endgame: d?.epa?.endgame?.mean      ?? null,
        opr:     oprMap[num] ?? null,
        notes:   p.notes   ?? '',
        picked:  p.picked  ?? false,
        pick1:   p.pick1   ?? false,
        pick2:   p.pick2   ?? false,
      });
    });

    // Only re-sort if not preserving an existing manual order
    if (!Object.keys(preserve).length) {
      teams.sort((a, b) => (b.epa ?? -Infinity) - (a.epa ?? -Infinity));
    }

    state.teams          = teams;
    state.activeListName = null;
    state.sortCol        = 'epa';
    state.sortAsc        = false;
    localStorage.removeItem(LS_ACTIVE);

    const withData = teams.filter(t => t.epa !== null).length;
    eventBadge.textContent   = `${nums.length} teams (pasted)`;
    eventBadge.style.display = '';

    hideLoading();
    showUI(null);
    renderTeams();
    renderSavedLists();

    if (withData === 0) {
      showToast(`No EPA data found for any team. Try a different year.`, 'error');
    } else {
      showToast(`Loaded ${teams.length} teams — ${withData} with EPA data`, 'success');
    }

  } catch (err) {
    hideLoading();
    console.error('[DraftBoard] fetchFromPastedList error:', err);
    showError(err.message);
    showToast(`Error: ${err.message}`, 'error');
  }
}


// ─── Rendering ────────────────────────────────────────────────────────────────
function fmt(v, d = 1) {
  if (v === null || v === undefined || isNaN(v)) return null;
  return Number(v).toFixed(d);
}

function fmtCell(v, colorClass) {
  const s = fmt(v);
  if (s === null) return `<span class="no-data">—</span>`;
  return colorClass ? `<span style="color:${colorClass}">${s}</span>` : s;
}

function renderTeams() {
  picklistBody.innerHTML = '';

  const q = state.searchQuery.toLowerCase().trim();

  state.teams.forEach((team, idx) => {
    const isMatch  = !q || String(team.num).includes(q) || team.name.toLowerCase().includes(q);
    const isPicked = team.picked || team.pick1 || team.pick2;
    const hide     = !isMatch || (!state.showPicked && isPicked);

    const tr = document.createElement('tr');
    tr.dataset.num = team.num;
    tr.className = [
      isPicked && !team.pick1 && !team.pick2 ? 'picked' : '',
      team.pick1 ? 'double-picked-1' : '',
      team.pick2 ? 'double-picked-2' : '',
      hide ? 'hidden-row' : '',
    ].filter(Boolean).join(' ');

    tr.innerHTML = `
      <td class="col-drag"><span class="drag-handle" title="Drag to reorder">⠿</span></td>
      <td class="col-rank row-rank">${idx + 1}</td>
      <td class="col-team row-team">
        <div class="team-num">
          ${team.num}
          <span class="picked-badge">PICKED</span>
          <span class="pick1-badge">P1</span>
          <span class="pick2-badge">P2</span>
        </div>
        <div class="team-name">${esc(team.name)}</div>
      </td>
      <td class="col-epa row-stat">${fmtCell(team.epa, 'var(--accent-teal)')}</td>
      <td class="col-opr row-stat">${fmtCell(team.opr, '#c9a0f8')}</td>
      <td class="col-auto row-stat">${fmtCell(team.auto, 'var(--accent-green)')}</td>
      <td class="col-teleop row-stat">${fmtCell(team.teleop, '#7eb8f7')}</td>
      <td class="col-endgame row-stat">${fmtCell(team.endgame, 'var(--accent-yellow)')}</td>
      <td class="col-notes">
        <textarea class="notes-input" rows="1" placeholder="Notes…">${esc(team.notes)}</textarea>
      </td>
      <td class="col-actions">
        <div class="row-actions">
          <button class="pick-btn" title="${team.picked ? 'Unpick' : 'Mark as picked'}">
            ${team.picked ? '✓ Unpick' : 'Pick'}
          </button>
          <div class="dpick-wrap">
            <button class="dpick-btn p1 ${team.pick1 ? 'active' : ''}" title="Toggle Pick 1">P1</button>
            <button class="dpick-btn p2 ${team.pick2 ? 'active' : ''}" title="Toggle Pick 2">P2</button>
          </div>
        </div>
      </td>
    `;

    // Notes change
    const notesEl = tr.querySelector('.notes-input');
    notesEl.addEventListener('input', () => {
      team.notes = notesEl.value;
      autoSave();
    });

    // Click on team name → detail modal
    tr.querySelector('.row-team').addEventListener('click', () => showDetailModal(team, idx + 1));

    // Single pick toggle
    tr.querySelector('.pick-btn').addEventListener('click', () => {
      team.picked = !team.picked;
      if (team.picked) { team.pick1 = false; team.pick2 = false; }
      renderTeams();
      updateStats();
      autoSave();
    });

    // Double pick P1
    tr.querySelector('.dpick-btn.p1').addEventListener('click', () => {
      team.pick1 = !team.pick1;
      if (team.pick1) { team.picked = false; team.pick2 = false; }
      renderTeams();
      updateStats();
      autoSave();
    });

    // Double pick P2
    tr.querySelector('.dpick-btn.p2').addEventListener('click', () => {
      team.pick2 = !team.pick2;
      if (team.pick2) { team.picked = false; team.pick1 = false; }
      renderTeams();
      updateStats();
      autoSave();
    });

    picklistBody.appendChild(tr);
  });

  initSortable();
  updateStats();
  updateFilterMeta();
}

function showUI(listName) {
  emptyState.style.display    = 'none';
  picklistTable.style.display = '';
  // Show stats bar (injected into DOM after filter bar)
  ensureStatsBar();
  updateSortArrows();
}

function ensureStatsBar() {
  if ($('statsBar')) return; // already exists
  const bar = document.createElement('div');
  bar.id        = 'statsBar';
  bar.className = 'stats-bar';
  bar.innerHTML = `
    <div class="stat-pill">
      <span class="stat-pill-label">Teams</span>
      <span class="stat-pill-val" id="statTotal">0</span>
    </div>
    <div class="stat-pill">
      <span class="stat-pill-label">Picked</span>
      <span class="stat-pill-val accent-red" id="statPicked">0</span>
    </div>
    <div class="stat-pill">
      <span class="stat-pill-label">Available</span>
      <span class="stat-pill-val accent-green" id="statAvailable">0</span>
    </div>
    <div class="stat-pill">
      <span class="stat-pill-label">Avg EPA</span>
      <span class="stat-pill-val accent-teal" id="statAvgEpa">—</span>
    </div>
    <div class="stat-pill">
      <span class="stat-pill-label">Top EPA</span>
      <span class="stat-pill-val accent-purple" id="statTopEpa">—</span>
    </div>
  `;
  // Insert stats bar before the table wrapper
  const wrapper = $('tableWrapper');
  wrapper.parentNode.insertBefore(bar, wrapper);
}

function updateStats() {
  if (!$('statsBar')) return;
  const total    = state.teams.length;
  const picked   = state.teams.filter(t => t.picked || t.pick1 || t.pick2).length;
  const avail    = total - picked;
  const epas     = state.teams.map(t => t.epa).filter(v => v !== null);
  const avgEpa   = epas.length ? (epas.reduce((a, b) => a + b, 0) / epas.length).toFixed(1) : '—';
  const topEpa   = epas.length ? Math.max(...epas).toFixed(1) : '—';

  const set = (id, val) => { const e = $(id); if (e) e.textContent = val; };
  set('statTotal',     total);
  set('statPicked',    picked);
  set('statAvailable', avail);
  set('statAvgEpa',    avgEpa);
  set('statTopEpa',    topEpa);
}

function updateFilterMeta() {
  if (!filterMeta) return;
  const q        = state.searchQuery.trim();
  const total    = state.teams.length;
  const visible  = state.teams.filter(t => {
    const match = !q || String(t.num).includes(q.toLowerCase()) || t.name.toLowerCase().includes(q.toLowerCase());
    const hidden = !state.showPicked && (t.picked || t.pick1 || t.pick2);
    return match && !hidden;
  }).length;

  if (!total)    { filterMeta.textContent = 'No data loaded'; return; }
  if (q)         { filterMeta.textContent = `${visible} of ${total} teams match`; return; }
  filterMeta.textContent = `${total} teams${state.activeListName ? ` — ${state.activeListName}` : ''}`;
}

// ─── Detail Modal ─────────────────────────────────────────────────────────────
function showDetailModal(team, rank) {
  $('modalTeamTitle').textContent = `Team ${team.num}`;
  const body = $('teamModalBody');
  const f    = v => fmt(v, 2) ?? '—';

  body.innerHTML = `
    <div class="detail-team-header">
      <div>
        <div class="detail-team-num">${team.num}</div>
        <div class="detail-team-name">${esc(team.name)}</div>
      </div>
      <div class="detail-team-rank">#${rank} Overall</div>
    </div>
    <div class="detail-grid">
      <div class="detail-card">
        <div class="detail-card-label">EPA Total</div>
        <div class="detail-card-val teal">${f(team.epa)}</div>
      </div>
      <div class="detail-card">
        <div class="detail-card-label">OPR</div>
        <div class="detail-card-val" style="color:#c9a0f8">${f(team.opr)}</div>
      </div>
      <div class="detail-card">
        <div class="detail-card-label">Auto EPA</div>
        <div class="detail-card-val green">${f(team.auto)}</div>
      </div>
      <div class="detail-card">
        <div class="detail-card-label">Teleop EPA</div>
        <div class="detail-card-val" style="color:#7eb8f7">${f(team.teleop)}</div>
      </div>
      <div class="detail-card">
        <div class="detail-card-label">Endgame EPA</div>
        <div class="detail-card-val yellow">${f(team.endgame)}</div>
      </div>
    </div>
    ${team.notes ? `
      <div style="margin-top:14px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm)">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:5px">Notes</div>
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.6">${esc(team.notes)}</div>
      </div>` : ''}
  `;

  $('teamModal').style.display = 'flex';
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
  const colToField = { team: 'num', score: 'score', epa: 'epa', opr: 'opr', auto: 'auto', teleop: 'teleop', endgame: 'endgame' };
  const field = colToField[col] || col;

  state.teams.sort((a, b) => {
    const av = a[field] ?? -Infinity;
    const bv = b[field] ?? -Infinity;
    return (av < bv ? -1 : av > bv ? 1 : 0) * mult;
  });

  renderTeams();
  updateSortArrows();
}

function updateSortArrows() {
  document.querySelectorAll('.sortable').forEach(th => {
    th.classList.remove('active-sort');
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = '';
  });
  const activeEl = document.querySelector(`.sortable[data-col="${state.sortCol}"]`);
  if (activeEl) {
    activeEl.classList.add('active-sort');
    const arrow = activeEl.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = state.sortAsc ? ' ↑' : ' ↓';
  }
}

// ─── Drag-and-drop (SortableJS) ───────────────────────────────────────────────
let sortableInstance = null;

function initSortable() {
  if (sortableInstance) { sortableInstance.destroy(); sortableInstance = null; }
  if (typeof Sortable === 'undefined') return;

  sortableInstance = Sortable.create(picklistBody, {
    animation: 150,
    handle: '.drag-handle',
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    onEnd(evt) {
      const { oldIndex, newIndex } = evt;
      if (oldIndex === newIndex) return;
      // Move in state.teams to match new DOM order
      const moved = state.teams.splice(oldIndex, 1)[0];
      state.teams.splice(newIndex, 0, moved);
      // Renumber rank cells
      Array.from(picklistBody.querySelectorAll('tr')).forEach((tr, i) => {
        const rankEl = tr.querySelector('.row-rank');
        if (rankEl) rankEl.textContent = i + 1;
      });
      autoSave();
    },
  });
}

// ─── Copy to Discord ──────────────────────────────────────────────────────────
function copyToDiscord() {
  const available = state.teams.filter(t => !t.picked && !t.pick1 && !t.pick2);
  if (!available.length) {
    showToast('No unpicked teams to copy.', 'info');
    return;
  }
  const lines = available.map((t, i) => `${i + 1}. ${t.num}`).join('\n');
  const text  = `📋 **Draft Picklist**\n${lines}`;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => showToast('✓ Copied to clipboard!', 'success'))
      .catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value          = text;
  ta.style.position = 'fixed';
  ta.style.opacity  = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    showToast('✓ Copied to clipboard!', 'success');
  } catch (_) {
    showToast('Could not copy — try manually.', 'error');
  }
  document.body.removeChild(ta);
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function openSidebar() {
  sidebar.classList.add('open');
  mainContent.classList.add('sidebar-open');
}

function closeSidebar() {
  sidebar.classList.remove('open');
  mainContent.classList.remove('sidebar-open');
}

function toggleSidebar() {
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
}

// ─── Modals ───────────────────────────────────────────────────────────────────
function openModal(id)  { $(id).style.display = 'flex'; }
function closeModal(id) { $(id).style.display = 'none'; }

// ─── Loading / Error UI ───────────────────────────────────────────────────────
function showLoading(msg) {
  loadingText.textContent = msg || 'Loading…';
  loadingOverlay.style.display = 'flex';
}

function updateLoadingText(msg) {
  if (loadingText) loadingText.textContent = msg;
}

function hideLoading() {
  loadingOverlay.style.display = 'none';
}

function showError(msg) {
  if (!errorBanner || !errorMsg) return;
  errorMsg.textContent = msg;
  errorBanner.style.display = 'flex';
}

function hideError() {
  if (errorBanner) errorBanner.style.display = 'none';
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type) {
  toast.textContent = msg;
  toast.className   = 'toast' + (type ? ` toast-${type}` : '');
  void toast.offsetWidth; // force reflow for re-animation
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

// ─── Event Bindings ───────────────────────────────────────────────────────────
function bindEvents() {

  // Sidebar open/close
  $('sidebarToggleBtn').addEventListener('click', toggleSidebar);
  $('sidebarCloseBtn').addEventListener('click',  closeSidebar);

  // Load data button
  $('loadDataBtn').addEventListener('click', () => {
    closeSidebar();
    fetchData();
  });

  // Generate list (header toolbar button)
  $('generateBtn').addEventListener('click', () => fetchData());
  $('refreshEpaBtn').addEventListener('click', () => refreshEpaForCurrentList());

  // Empty-state generate button → open sidebar so user can configure
  $('emptyGenerateBtn').addEventListener('click', () => openSidebar());

  // Load from pasted team list
  $('loadFromListBtn').addEventListener('click', () => {
    closeSidebar();
    fetchFromPastedList();
  });

  // Reset order to EPA ranking
  $('resetOrderBtn').addEventListener('click', () => {
    if (!state.teams.length) return;
    state.teams.sort((a, b) => (b.epa ?? -Infinity) - (a.epa ?? -Infinity));
    state.sortCol = 'epa';
    state.sortAsc = false;
    renderTeams();
    updateSortArrows();
    showToast('Order reset to EPA ranking', 'info');
  });

  // Save list
  $('saveListBtn').addEventListener('click', () => {
    if (!state.teams.length) { showToast('Nothing to save — generate a list first.', 'info'); return; }
    // Pre-fill list name
    $('listNameInput').value = state.activeListName || '';
    openSidebar();
    $('listNameInput').focus();
    $('listNameInput').select();
  });

  // New list button in sidebar — show a confirm if we have unsaved data
  $('newListBtn').addEventListener('click', () => {
    const name = $('listNameInput').value.trim();
    if (!name) {
      showToast('Enter a list name above first.', 'error');
      $('listNameInput').focus();
      return;
    }
    if (state.savedLists[name] && !confirm(`"${name}" already exists. Overwrite?`)) return;
    saveCurrentList(name);
  });

  // Double-pick mode toggle
  $('doublePickToggle').addEventListener('click', () => {
    state.doublePick = !state.doublePick;
    document.body.classList.toggle('double-pick-mode', state.doublePick);
    $('doublePickToggle').classList.toggle('active', state.doublePick);
    $('doublePickLabel').textContent = state.doublePick ? 'ON' : 'OFF';
    showToast(`Double-pick mode ${state.doublePick ? 'enabled' : 'disabled'}`, 'info');
  });

  // Toggle show/hide picked
  $('togglePickedBtn').addEventListener('click', () => {
    state.showPicked = !state.showPicked;
    $('togglePickedBtn').textContent = state.showPicked ? 'Hide Picked' : 'Show Picked';
    $('togglePickedBtn').classList.toggle('active', !state.showPicked);
    renderTeams();
  });

  // Copy to Discord
  $('copyDiscordBtn').addEventListener('click', copyToDiscord);

  // Search
  const searchInput = $('searchInput');
  const searchClear = $('searchClearBtn');

  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value;
    searchClear.style.display = state.searchQuery ? '' : 'none';
    renderTeams();
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    state.searchQuery = '';
    searchClear.style.display = 'none';
    searchInput.focus();
    renderTeams();
  });

  // Column sort (thead th.sortable)
  document.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => {
      if (!state.teams.length) return;
      sortBy(th.dataset.col);
    });
  });

  // Team Detail Modal close
  $('teamModalClose').addEventListener('click', () => closeModal('teamModal'));

  // Error banner close
  $('errorCloseBtn').addEventListener('click', hideError);

  // Modal backdrop click to close
  document.addEventListener('click', e => {
    if (e.target.classList.contains('modal-backdrop')) {
      e.target.style.display = 'none';
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    // Escape: close any open modal or sidebar
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop').forEach(m => {
        if (m.style.display !== 'none') m.style.display = 'none';
      });
      if (sidebar.classList.contains('open')) closeSidebar();
    }
    // Ctrl/Cmd + S → save list
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      $('saveListBtn').click();
    }
    // Ctrl/Cmd + F → focus search
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      const si = $('searchInput');
      si.focus();
      si.select();
    }
  });

  // Persist TBA key on blur
  $('tbaKeyInput').addEventListener('blur',   saveSettings);
  $('eventKeyInput').addEventListener('blur', saveSettings);
  $('yearSelect').addEventListener('change',  saveSettings);
}
