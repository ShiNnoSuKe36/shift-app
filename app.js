(function () {
  'use strict';

  const STORAGE_KEY = 'shiftAppData_v1';
  const BACKEND_URL_KEY = 'shiftAppBackendUrl';
  const SKILL_OPTIONS = ['新人', '焼き', 'フライヤー', 'お弁当', '冷凍もの'];
  const COVERAGE_SKILLS = SKILL_OPTIONS.filter(s => s !== '新人');

  function isNewbie(staff) {
    return !!(staff && (staff.skills || []).includes('新人'));
  }

  const PATTERNS = {
    p1: { start: 9, end: 14.5 },
    p2: { start: 14.5, end: 20.5 },
    p3: { start: 17, end: 20.5 }
  };

  function defaultData() {
    return {
      staff: [],
      settings: { openTime: 9, closeTime: 20.5, minHeadcount: 2, requiredSkills: [] },
      availability: {},
      results: {}
    };
  }

  function mergeWithDefaults(parsed) {
    const base = defaultData();
    return Object.assign(base, parsed, {
      settings: Object.assign(base.settings, (parsed && parsed.settings) || {})
    });
  }

  function loadLocalCache() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultData();
      return mergeWithDefaults(JSON.parse(raw));
    } catch (e) {
      console.error('データ読み込みに失敗しました', e);
      return defaultData();
    }
  }

  function saveLocalCache(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error('ローカル保存に失敗しました', e);
    }
  }

  function getBackendUrl() {
    return localStorage.getItem(BACKEND_URL_KEY) || '';
  }

  function setBackendUrl(url) {
    if (url) localStorage.setItem(BACKEND_URL_KEY, url);
    else localStorage.removeItem(BACKEND_URL_KEY);
  }

  function showSyncStatus(text, isError) {
    const el = document.getElementById('backend-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? 'var(--danger)' : 'var(--muted)';
  }

  let saveChain = Promise.resolve();

  function pushToBackend(url, data) {
    const body = JSON.stringify(data);
    saveChain = saveChain.then(() =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body })
        .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); })
    ).then(() => {
      showSyncStatus('保存しました(' + new Date().toLocaleTimeString('ja-JP') + ')', false);
    }).catch(err => {
      console.error('データベースへの保存に失敗しました', err);
      showSyncStatus('保存に失敗しました。URLやネットワークを確認してください', true);
    });
    return saveChain;
  }

  function saveData(data) {
    saveLocalCache(data);
    const url = getBackendUrl();
    if (url) pushToBackend(url, data);
  }

  async function syncFromBackend(showAlertOnFail) {
    const url = getBackendUrl();
    if (!url) return;
    showSyncStatus('取得中...', false);
    try {
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      DATA = mergeWithDefaults(json);
      saveLocalCache(DATA);
      renderAllTabs();
      showSyncStatus('同期しました(' + new Date().toLocaleTimeString('ja-JP') + ')', false);
    } catch (e) {
      console.error('データベースからの取得に失敗しました', e);
      showSyncStatus('取得に失敗しました。URLやネットワークを確認してください', true);
      if (showAlertOnFail) alert('データベースからの取得に失敗しました。URLやネットワーク接続を確認してください。');
    }
  }

  let DATA = loadLocalCache();

  // ---------- utils ----------

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function currentYM() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function hoursToTimeStr(h) {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  function timeStrToHours(t) {
    const parts = String(t).split(':').map(Number);
    return parts[0] + (parts[1] || 0) / 60;
  }

  function patternLabel(key) {
    const p = PATTERNS[key];
    if (!p) return '未設定';
    return hoursToTimeStr(p.start) + '〜' + hoursToTimeStr(p.end);
  }

  function isWeekendDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return [0, 6].includes(new Date(y, m - 1, d).getDay());
  }

  function getDefaultRangeForStaffDate(staff, dateStr, settings) {
    const key = isWeekendDate(dateStr) ? staff.defaultWeekend : staff.defaultWeekday;
    const p = PATTERNS[key];
    if (!p) return { start: settings.openTime, end: settings.closeTime };
    return { start: Math.max(p.start, settings.openTime), end: Math.min(p.end, settings.closeTime) };
  }

  function getDatesInMonth(ym) {
    const [y, m] = ym.split('-').map(Number);
    const days = new Date(y, m, 0).getDate();
    const dates = [];
    for (let d = 1; d <= days; d++) {
      const dt = new Date(y, m - 1, d);
      dates.push({
        dateStr: y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'),
        day: d,
        weekday: ['日', '月', '火', '水', '木', '金', '土'][dt.getDay()],
        isWeekend: dt.getDay() === 0 || dt.getDay() === 6
      });
    }
    return dates;
  }

  function parseHourToken(tok) {
    tok = tok.trim();
    if (/^\d{1,2}:\d{2}$/.test(tok)) return timeStrToHours(tok);
    if (/^\d{1,2}(\.\d+)?$/.test(tok)) return parseFloat(tok);
    return null;
  }

  function parseAvailabilityRaw(raw, open, close) {
    const s = raw.trim();
    if (s === '') return { type: 'full', start: open, end: close, raw };
    if (s === '/' || s === '×' || s === '休' || s.toLowerCase() === 'off') {
      return { type: 'off', raw };
    }
    const norm = s.replace(/[~〜]/g, '-');
    if (norm.includes('-')) {
      const idx = norm.indexOf('-');
      const leftRaw = norm.slice(0, idx).trim();
      const rightRaw = norm.slice(idx + 1).trim();
      const start = leftRaw === '' ? open : parseHourToken(leftRaw);
      const end = rightRaw === '' ? close : parseHourToken(rightRaw);
      if (start === null || end === null || isNaN(start) || isNaN(end) || start >= end) {
        return { type: 'invalid', raw };
      }
      return { type: 'range', start, end, raw };
    }
    const v = parseHourToken(norm);
    if (v === null || isNaN(v) || v >= close) return { type: 'invalid', raw };
    return { type: 'range', start: v, end: close, raw };
  }

  // ---------- tabs ----------

  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'availability') renderAvailabilityGrid();
        if (btn.dataset.tab === 'coverage') renderCoverageForm();
        if (btn.dataset.tab === 'generate') renderGenerateResult();
      });
    });
  }

  // ---------- staff tab ----------

  let editingStaffId = null;

  function renderAvoidCheckboxes(excludeId) {
    const wrap = document.getElementById('staff-avoid-list');
    const options = DATA.staff.filter(s => s.id !== excludeId);
    if (options.length === 0) {
      wrap.innerHTML = '<span class="help-text">まだ他のスタッフがいません</span>';
      return;
    }
    wrap.innerHTML = options.map(s =>
      `<label><input type="checkbox" value="${s.id}"> ${escapeHtml(s.name)}</label>`
    ).join('');
  }

  function renderStaffTab() {
    renderAvoidCheckboxes(editingStaffId);
    const tbody = document.getElementById('staff-table-body');
    tbody.innerHTML = DATA.staff.map(s => {
      const avoidNames = (s.avoidWith || [])
        .map(id => { const t = DATA.staff.find(x => x.id === id); return t ? t.name : null; })
        .filter(Boolean).join('、');
      const skillsText = (s.skills || []).length ? (s.skills || []).map(escapeHtml).join('、') : '接客';
      const defaultText = patternLabel(s.defaultWeekday) + ' / ' + patternLabel(s.defaultWeekend);
      return `<tr>
        <td>${escapeHtml(s.name)}</td>
        <td>${(s.hourlyWage || 0).toLocaleString()}円</td>
        <td>${skillsText}</td>
        <td>${escapeHtml(avoidNames)}</td>
        <td>${escapeHtml(defaultText)}</td>
        <td>
          <button type="button" class="secondary edit-staff-btn" data-id="${s.id}">編集</button>
          <button type="button" class="secondary delete-staff-btn" data-id="${s.id}">削除</button>
        </td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('.delete-staff-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('このスタッフを削除しますか？希望入力データも削除されます。')) return;
        const id = btn.dataset.id;
        if (editingStaffId === id) cancelStaffEdit();
        DATA.staff = DATA.staff.filter(s => s.id !== id);
        DATA.staff.forEach(s => { s.avoidWith = (s.avoidWith || []).filter(x => x !== id); });
        Object.keys(DATA.availability).forEach(k => {
          if (k.startsWith(id + '__')) delete DATA.availability[k];
        });
        saveData(DATA);
        renderStaffTab();
        renderAvailabilityGrid();
        renderCoverageForm();
      });
    });
    tbody.querySelectorAll('.edit-staff-btn').forEach(btn => {
      btn.addEventListener('click', () => startStaffEdit(btn.dataset.id));
    });
  }

  function startStaffEdit(id) {
    const s = DATA.staff.find(x => x.id === id);
    if (!s) return;
    editingStaffId = id;

    document.getElementById('staff-name').value = s.name;
    document.getElementById('staff-wage').value = s.hourlyWage || 0;
    document.querySelectorAll('input[name="staff-skill"]').forEach(cb => {
      cb.checked = (s.skills || []).includes(cb.value);
    });
    renderAvoidCheckboxes(id);
    document.querySelectorAll('#staff-avoid-list input[type=checkbox]').forEach(cb => {
      cb.checked = (s.avoidWith || []).includes(cb.value);
    });
    document.getElementById('staff-default-weekday').value = s.defaultWeekday || '';
    document.getElementById('staff-default-weekend').value = s.defaultWeekend || '';

    document.getElementById('staff-submit-btn').textContent = 'スタッフを更新';
    document.getElementById('staff-cancel-btn').hidden = false;
    document.getElementById('staff-name').focus();
  }

  function cancelStaffEdit() {
    editingStaffId = null;
    document.getElementById('staff-form').reset();
    renderAvoidCheckboxes();
    document.getElementById('staff-submit-btn').textContent = 'スタッフを追加';
    document.getElementById('staff-cancel-btn').hidden = true;
  }

  function bindStaffForm() {
    document.getElementById('staff-cancel-btn').addEventListener('click', cancelStaffEdit);
    document.getElementById('staff-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = document.getElementById('staff-name').value.trim();
      if (!name) return;
      const hourlyWage = Number(document.getElementById('staff-wage').value) || 0;
      const skills = Array.from(
        document.querySelectorAll('input[name="staff-skill"]:checked')
      ).map(cb => cb.value);
      const avoidWith = Array.from(
        document.querySelectorAll('#staff-avoid-list input[type=checkbox]:checked')
      ).map(cb => cb.value);
      const defaultWeekday = document.getElementById('staff-default-weekday').value;
      const defaultWeekend = document.getElementById('staff-default-weekend').value;

      if (editingStaffId) {
        const s = DATA.staff.find(x => x.id === editingStaffId);
        if (s) {
          const oldAvoid = s.avoidWith || [];
          const removed = oldAvoid.filter(id => !avoidWith.includes(id));
          const added = avoidWith.filter(id => !oldAvoid.includes(id));
          removed.forEach(otherId => {
            const other = DATA.staff.find(x => x.id === otherId);
            if (other) other.avoidWith = (other.avoidWith || []).filter(x => x !== s.id);
          });
          added.forEach(otherId => {
            const other = DATA.staff.find(x => x.id === otherId);
            if (other) {
              other.avoidWith = other.avoidWith || [];
              if (!other.avoidWith.includes(s.id)) other.avoidWith.push(s.id);
            }
          });
          s.name = name;
          s.hourlyWage = hourlyWage;
          s.skills = skills;
          s.avoidWith = [...avoidWith];
          s.defaultWeekday = defaultWeekday;
          s.defaultWeekend = defaultWeekend;
        }
        cancelStaffEdit();
      } else {
        const id = 's' + Date.now() + Math.floor(Math.random() * 1000);
        DATA.staff.push({ id, name, hourlyWage, skills, avoidWith: [...avoidWith], defaultWeekday, defaultWeekend });
        avoidWith.forEach(otherId => {
          const other = DATA.staff.find(s => s.id === otherId);
          if (other) {
            other.avoidWith = other.avoidWith || [];
            if (!other.avoidWith.includes(id)) other.avoidWith.push(id);
          }
        });
        e.target.reset();
      }

      saveData(DATA);
      renderStaffTab();
      renderAvailabilityGrid();
      renderCoverageForm();
    });
  }

  // ---------- availability tab ----------

  function renderAvailabilityGrid() {
    const ym = document.getElementById('availability-month').value || currentYM();
    const dates = getDatesInMonth(ym);
    const wrap = document.getElementById('availability-grid-wrap');
    if (DATA.staff.length === 0) {
      wrap.innerHTML = '<p class="help-text">先に「スタッフ管理」でスタッフを登録してください。</p>';
      return;
    }
    let html = '<div class="avail-grid-scroll"><table class="avail-grid"><thead><tr><th class="staff-col">スタッフ</th>';
    dates.forEach(d => {
      html += `<th class="${d.isWeekend ? 'day-header-weekend' : ''}">${d.day}<br>${d.weekday}</th>`;
    });
    html += '</tr></thead><tbody>';
    DATA.staff.forEach(s => {
      html += `<tr><td class="staff-col">${escapeHtml(s.name)}</td>`;
      dates.forEach(d => {
        const key = s.id + '__' + d.dateStr;
        const rec = DATA.availability[key];
        const raw = rec ? rec.raw : '';
        const cls = rec ? (rec.type === 'off' ? 'off' : rec.type === 'invalid' ? 'invalid' : rec.type === 'range' ? 'range' : '') : '';
        const defRange = getDefaultRangeForStaffDate(s, d.dateStr, DATA.settings);
        const placeholder = hoursToTimeStr(defRange.start) + '〜' + hoursToTimeStr(defRange.end);
        html += `<td><input class="cell-input ${cls}" data-staff="${s.id}" data-date="${d.dateStr}" value="${escapeHtml(raw)}" placeholder="${escapeHtml(placeholder)}"></td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    wrap.innerHTML = html;

    wrap.querySelectorAll('.cell-input').forEach(inp => {
      inp.addEventListener('change', () => {
        const staffId = inp.dataset.staff;
        const dateStr = inp.dataset.date;
        const key = staffId + '__' + dateStr;
        const parsed = parseAvailabilityRaw(inp.value, DATA.settings.openTime, DATA.settings.closeTime);
        if (parsed.raw === '' && parsed.type === 'full') {
          delete DATA.availability[key];
        } else {
          DATA.availability[key] = parsed;
        }
        saveData(DATA);
        inp.className = 'cell-input' +
          (parsed.type === 'off' ? ' off' : parsed.type === 'invalid' ? ' invalid' : parsed.type === 'range' ? ' range' : '');
      });
    });
  }

  // ---------- coverage tab ----------

  function getAllSkills() {
    return COVERAGE_SKILLS;
  }

  function renderCoverageForm() {
    document.getElementById('open-time').value = hoursToTimeStr(DATA.settings.openTime);
    document.getElementById('close-time').value = hoursToTimeStr(DATA.settings.closeTime);
    document.getElementById('min-headcount').value = DATA.settings.minHeadcount;
    renderRequiredSkillsList();
  }

  function renderRequiredSkillsList() {
    const wrap = document.getElementById('required-skills-list');
    const allSkills = getAllSkills();
    if (DATA.settings.requiredSkills.length === 0) {
      wrap.innerHTML = '<p class="help-text">スキル条件はありません</p>';
      return;
    }
    wrap.innerHTML = DATA.settings.requiredSkills.map((r, i) => `
      <div class="form-row" data-idx="${i}">
        <select class="req-skill-select">
          ${allSkills.length === 0
            ? '<option value="">(スタッフにスキルを登録してください)</option>'
            : allSkills.map(sk => `<option value="${escapeHtml(sk)}" ${sk === r.skill ? 'selected' : ''}>${escapeHtml(sk)}</option>`).join('')}
        </select>
        <input type="number" class="req-skill-count" min="0" step="1" value="${r.count}" style="width:70px">
        <button type="button" class="secondary req-skill-remove">削除</button>
      </div>`).join('');

    wrap.querySelectorAll('[data-idx]').forEach(row => {
      const idx = Number(row.dataset.idx);
      row.querySelector('.req-skill-select').addEventListener('change', (e) => {
        DATA.settings.requiredSkills[idx].skill = e.target.value;
        saveData(DATA);
      });
      row.querySelector('.req-skill-count').addEventListener('change', (e) => {
        DATA.settings.requiredSkills[idx].count = Number(e.target.value) || 0;
        saveData(DATA);
      });
      row.querySelector('.req-skill-remove').addEventListener('click', () => {
        DATA.settings.requiredSkills.splice(idx, 1);
        saveData(DATA);
        renderRequiredSkillsList();
      });
    });
  }

  function bindCoverageForm() {
    document.getElementById('add-required-skill').addEventListener('click', () => {
      const allSkills = getAllSkills();
      DATA.settings.requiredSkills.push({ skill: allSkills[0] || '', count: 1 });
      saveData(DATA);
      renderRequiredSkillsList();
    });
    document.getElementById('coverage-form').addEventListener('submit', (e) => {
      e.preventDefault();
      DATA.settings.openTime = timeStrToHours(document.getElementById('open-time').value);
      DATA.settings.closeTime = timeStrToHours(document.getElementById('close-time').value);
      DATA.settings.minHeadcount = Number(document.getElementById('min-headcount').value) || 0;
      saveData(DATA);
      alert('設定を保存しました');
      renderAvailabilityGrid();
    });
  }

  // ---------- shift generation ----------

  function buildSlots(open, close, slotHours) {
    const slots = [];
    for (let t = open; t < close - 1e-9; t += slotHours) {
      slots.push({ start: t, end: Math.min(t + slotHours, close) });
    }
    return slots;
  }

  function buildNeedMaps(settings, slots) {
    const headNeed = new Map(slots.map(sl => [sl.start, settings.minHeadcount]));
    const skillNeed = new Map(slots.map(sl => [
      sl.start,
      Object.fromEntries((settings.requiredSkills || []).filter(r => r.skill).map(r => [r.skill, r.count]))
    ]));
    return { headNeed, skillNeed };
  }

  function applyAssignmentToNeed(assign, slots, headNeed, skillNeed, staff) {
    for (const sl of slots) {
      if (sl.start >= assign.start - 1e-9 && sl.end <= assign.end + 1e-9) {
        if (!isNewbie(staff)) headNeed.set(sl.start, headNeed.get(sl.start) - 1);
        const sk = skillNeed.get(sl.start);
        (staff.skills || []).forEach(skName => {
          if (sk[skName] !== undefined) sk[skName] = Math.max(0, sk[skName] - 1);
        });
      }
    }
  }

  function mergeConsecutive(shortages) {
    if (!shortages.length) return [];
    const merged = [];
    let cur = Object.assign({}, shortages[0]);
    for (let i = 1; i < shortages.length; i++) {
      const s = shortages[i];
      const sameSig = s.headShort === cur.headShort &&
        JSON.stringify(s.missingSkills) === JSON.stringify(cur.missingSkills);
      if (sameSig && Math.abs(s.start - cur.end) < 1e-9) {
        cur.end = s.end;
      } else {
        merged.push(cur);
        cur = Object.assign({}, s);
      }
    }
    merged.push(cur);
    return merged;
  }

  function deriveShortages(slots, headNeed, skillNeed) {
    const shortages = [];
    for (const sl of slots) {
      const hn = headNeed.get(sl.start);
      const sk = skillNeed.get(sl.start);
      const missingSkills = Object.entries(sk).filter(([, v]) => v > 0).map(([k, v]) => `${k}×${v}`);
      if (hn > 0 || missingSkills.length > 0) {
        shortages.push({ start: sl.start, end: sl.end, headShort: Math.max(0, hn), missingSkills });
      }
    }
    return mergeConsecutive(shortages);
  }

  function hasConflict(cand, picked, staffMap) {
    const staff = staffMap[cand.staffId];
    for (const p of picked) {
      const overlap = cand.start < p.end && p.start < cand.end;
      if (!overlap) continue;
      const pStaff = staffMap[p.staffId];
      if ((staff.avoidWith || []).includes(p.staffId) || (pStaff.avoidWith || []).includes(cand.staffId)) return true;
    }
    return false;
  }

  function scoreCandidate(cand, slots, headNeed, skillNeed, staffMap) {
    let score = 0;
    const staff = staffMap[cand.staffId];
    for (const sl of slots) {
      if (sl.start >= cand.start - 1e-9 && sl.end <= cand.end + 1e-9) {
        if (!isNewbie(staff) && headNeed.get(sl.start) > 0) score += 1;
        const sk = skillNeed.get(sl.start);
        (staff.skills || []).forEach(skName => { if (sk[skName] > 0) score += 2; });
      }
    }
    return score;
  }

  function solveDayCoverage(dayAvail, settings, staffMap, cumulativeHours) {
    const slots = buildSlots(settings.openTime, settings.closeTime, 0.5);
    const { headNeed, skillNeed } = buildNeedMaps(settings, slots);
    let remaining = dayAvail.slice();
    const picked = [];

    function totalUnmet() {
      let unmet = 0;
      for (const sl of slots) {
        unmet += Math.max(0, headNeed.get(sl.start));
        Object.values(skillNeed.get(sl.start)).forEach(v => { unmet += Math.max(0, v); });
      }
      return unmet;
    }

    while (totalUnmet() > 0 && remaining.length > 0) {
      let best = null, bestScore = -Infinity;
      for (const cand of remaining) {
        let score = scoreCandidate(cand, slots, headNeed, skillNeed, staffMap);
        if (score <= 0) continue;
        if (hasConflict(cand, picked, staffMap)) score -= 1000;
        score -= (cumulativeHours[cand.staffId] || 0) * 0.01;
        score -= (cand.end - cand.start) * 0.001;
        if (score > bestScore) { bestScore = score; best = cand; }
      }
      if (!best) break;
      picked.push(best);
      remaining = remaining.filter(c => c !== best);
      applyAssignmentToNeed(best, slots, headNeed, skillNeed, staffMap[best.staffId]);
    }

    const shortages = deriveShortages(slots, headNeed, skillNeed);
    return { assignments: picked.map(c => ({ staffId: c.staffId, start: c.start, end: c.end })), shortages };
  }

  function generateForMonth(ym) {
    const staffMap = {};
    DATA.staff.forEach(s => { staffMap[s.id] = s; });
    const dates = getDatesInMonth(ym);
    const cumulativeHours = {};
    DATA.staff.forEach(s => { cumulativeHours[s.id] = 0; });
    const result = {};

    dates.forEach(d => {
      const dayAvail = [];
      DATA.staff.forEach(s => {
        const key = s.id + '__' + d.dateStr;
        let rec = DATA.availability[key];
        if (!rec) {
          const def = getDefaultRangeForStaffDate(s, d.dateStr, DATA.settings);
          rec = { type: 'range', start: def.start, end: def.end };
        }
        if (rec.type === 'off' || rec.type === 'invalid') return;
        const start = Math.max(rec.start, DATA.settings.openTime);
        const end = Math.min(rec.end, DATA.settings.closeTime);
        if (start < end) dayAvail.push({ staffId: s.id, start, end });
      });
      const dayResult = solveDayCoverage(dayAvail, DATA.settings, staffMap, cumulativeHours);
      dayResult.assignments.forEach(a => { cumulativeHours[a.staffId] += (a.end - a.start); });
      result[d.dateStr] = dayResult;
    });

    DATA.results = DATA.results || {};
    DATA.results[ym] = result;
    saveData(DATA);
    return result;
  }

  function recomputeShortages(ym, date) {
    const staffMap = {};
    DATA.staff.forEach(s => { staffMap[s.id] = s; });
    const slots = buildSlots(DATA.settings.openTime, DATA.settings.closeTime, 0.5);
    const { headNeed, skillNeed } = buildNeedMaps(DATA.settings, slots);
    DATA.results[ym][date].assignments.forEach(a => {
      applyAssignmentToNeed(a, slots, headNeed, skillNeed, staffMap[a.staffId] || { skills: [] });
    });
    DATA.results[ym][date].shortages = deriveShortages(slots, headNeed, skillNeed);
  }

  // ---------- generate tab rendering ----------

  function renderGenerateResult() {
    const ym = document.getElementById('generate-month').value || currentYM();
    const wrap = document.getElementById('generate-result-wrap');
    const monthResult = (DATA.results || {})[ym];
    if (!monthResult) {
      wrap.innerHTML = '<p class="help-text">「自動生成する」ボタンを押してシフト表を作成してください。</p>';
      return;
    }
    const dates = getDatesInMonth(ym);
    const staffMap = {};
    DATA.staff.forEach(s => { staffMap[s.id] = s; });
    const totalHours = {};
    DATA.staff.forEach(s => { totalHours[s.id] = 0; });

    let html = '';
    dates.forEach(d => {
      const dayResult = monthResult[d.dateStr] || { assignments: [], shortages: [] };
      const assignedIds = new Set(dayResult.assignments.map(a => a.staffId));
      html += `<div class="result-day" data-date="${d.dateStr}">
        <h3>${d.dateStr.slice(5).replace('-', '/')} (${d.weekday})</h3>
        <div class="assign-list">`;
      dayResult.assignments.forEach((a, idx) => {
        const staff = staffMap[a.staffId];
        totalHours[a.staffId] += (a.end - a.start);
        const newbieTag = isNewbie(staff) ? '(新人)' : '';
        html += `<span class="assign-chip">${escapeHtml(staff ? staff.name : '?')}${newbieTag} ${hoursToTimeStr(a.start)}-${hoursToTimeStr(a.end)}
          <button type="button" class="remove-assign-btn" data-date="${d.dateStr}" data-idx="${idx}">×</button></span>`;
      });
      html += '</div>';
      dayResult.shortages.forEach(sh => {
        const skillTxt = sh.missingSkills.length ? ' / 不足スキル: ' + sh.missingSkills.join('、') : '';
        html += `<div class="shortage-warning">⚠ ${hoursToTimeStr(sh.start)}-${hoursToTimeStr(sh.end)} 人数不足${sh.headShort > 0 ? '(' + sh.headShort + '人)' : ''}${skillTxt}</div>`;
      });
      const candidates = DATA.staff.filter(s => !assignedIds.has(s.id));
      if (candidates.length > 0) {
        html += `<div class="add-assign-row">
          <select class="add-staff-select">
            ${candidates.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
          </select>
          <input type="time" class="add-start-time" value="${hoursToTimeStr(DATA.settings.openTime)}">
          <input type="time" class="add-end-time" value="${hoursToTimeStr(DATA.settings.closeTime)}">
          <button type="button" class="secondary add-assign-btn" data-date="${d.dateStr}">追加</button>
        </div>`;
      }
      html += '</div>';
    });

    html += '<table class="data-table summary-table"><thead><tr><th>スタッフ</th><th>合計時間</th><th>時給</th><th>給与(概算)</th></tr></thead><tbody>';
    let totalWage = 0;
    DATA.staff.forEach(s => {
      const wage = s.hourlyWage || 0;
      const pay = Math.round(totalHours[s.id] * wage);
      totalWage += pay;
      html += `<tr><td>${escapeHtml(s.name)}</td><td>${totalHours[s.id].toFixed(1)}時間</td><td>${wage.toLocaleString()}円</td><td>${pay.toLocaleString()}円</td></tr>`;
    });
    html += `<tr><td><strong>合計</strong></td><td></td><td></td><td><strong>${totalWage.toLocaleString()}円</strong></td></tr>`;
    html += '</tbody></table>';
    html += '<p class="help-text">※給与は「合計時間×時給」の概算です。深夜割増・交通費・控除等は考慮していません。</p>';

    wrap.innerHTML = html;

    wrap.querySelectorAll('.remove-assign-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const date = btn.dataset.date;
        const idx = Number(btn.dataset.idx);
        DATA.results[ym][date].assignments.splice(idx, 1);
        recomputeShortages(ym, date);
        saveData(DATA);
        renderGenerateResult();
      });
    });
    wrap.querySelectorAll('.add-assign-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const date = btn.dataset.date;
        const row = btn.closest('.add-assign-row');
        const staffId = row.querySelector('.add-staff-select').value;
        const start = timeStrToHours(row.querySelector('.add-start-time').value);
        const end = timeStrToHours(row.querySelector('.add-end-time').value);
        if (!(start < end)) { alert('開始時刻は終了時刻より前にしてください'); return; }
        DATA.results[ym][date].assignments.push({ staffId, start, end });
        recomputeShortages(ym, date);
        saveData(DATA);
        renderGenerateResult();
      });
    });
  }

  function csvEscape(v) {
    const s = String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportCsv() {
    const ym = document.getElementById('generate-month').value || currentYM();
    const monthResult = (DATA.results || {})[ym];
    if (!monthResult) { alert('先にシフトを自動生成してください'); return; }
    const staffMap = {};
    DATA.staff.forEach(s => { staffMap[s.id] = s; });
    const rows = [['日付', '曜日', 'スタッフ', '開始', '終了']];
    getDatesInMonth(ym).forEach(d => {
      const dayResult = monthResult[d.dateStr];
      if (!dayResult || dayResult.assignments.length === 0) {
        rows.push([d.dateStr, d.weekday, '', '', '']);
      } else {
        dayResult.assignments.forEach(a => {
          rows.push([d.dateStr, d.weekday, staffMap[a.staffId] ? staffMap[a.staffId].name : '', hoursToTimeStr(a.start), hoursToTimeStr(a.end)]);
        });
      }
    });
    const csv = '﻿' + rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `シフト表_${ym}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function bindGenerateButtons() {
    document.getElementById('generate-btn').addEventListener('click', () => {
      const ym = document.getElementById('generate-month').value || currentYM();
      generateForMonth(ym);
      renderGenerateResult();
    });
    document.getElementById('generate-month').addEventListener('change', renderGenerateResult);
    document.getElementById('export-csv-btn').addEventListener('click', exportCsv);
    document.getElementById('print-btn').addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.querySelector('.tab-btn[data-tab="generate"]').classList.add('active');
      document.getElementById('tab-generate').classList.add('active');
      window.print();
    });
  }

  // ---------- data export / import (for moving data between devices) ----------

  function renderAllTabs() {
    renderStaffTab();
    renderAvailabilityGrid();
    renderCoverageForm();
    renderGenerateResult();
  }

  function exportDataFile() {
    const json = JSON.stringify(DATA, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `シフトデータ_${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function importDataFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (e) {
        alert('ファイルの読み込みに失敗しました。正しいエクスポートファイルか確認してください。');
        return;
      }
      if (!confirm('現在のデータを、このファイルの内容で上書きします。よろしいですか？')) return;
      DATA = mergeWithDefaults(parsed);
      editingStaffId = null;
      saveData(DATA);
      renderAllTabs();
      alert('インポートが完了しました');
    };
    reader.readAsText(file);
  }

  function bindDataTransferButtons() {
    document.getElementById('export-data-btn').addEventListener('click', exportDataFile);
    document.getElementById('import-data-btn').addEventListener('click', () => {
      document.getElementById('import-data-file').click();
    });
    document.getElementById('import-data-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) importDataFile(file);
      e.target.value = '';
    });
  }

  function bindBackendSettings() {
    const input = document.getElementById('backend-url-input');
    input.value = getBackendUrl();
    document.getElementById('backend-connect-btn').addEventListener('click', async () => {
      const url = input.value.trim();
      setBackendUrl(url);
      if (url) {
        await syncFromBackend(true);
      } else {
        showSyncStatus('ローカル保存のみになりました', false);
      }
    });
    document.getElementById('backend-refresh-btn').addEventListener('click', () => syncFromBackend(true));
    if (getBackendUrl()) showSyncStatus('読み込み中...', false);
  }

  // ---------- init ----------

  document.addEventListener('DOMContentLoaded', async () => {
    initTabs();
    bindStaffForm();
    bindCoverageForm();
    bindGenerateButtons();
    bindDataTransferButtons();
    bindBackendSettings();

    document.getElementById('availability-month').value = currentYM();
    document.getElementById('generate-month').value = currentYM();
    document.getElementById('availability-month').addEventListener('change', renderAvailabilityGrid);

    renderAllTabs();

    if (getBackendUrl()) await syncFromBackend(false);
  });
})();
