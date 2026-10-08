(function () {
  'use strict';

  const STORAGE_KEY = 'shiftAppData_v1';
  const BACKEND_URL_KEY = 'shiftAppBackendUrl';
  const SKILL_OPTIONS = ['新人', '焼き', 'フライヤー', 'お弁当', '冷凍もの'];
  const COVERAGE_SKILLS = SKILL_OPTIONS.filter(s => s !== '新人');
  const ROLE_OPTIONS = ['社員', 'パート', 'アルバイト'];
  // 「午前・午後をまたぐ通し勤務ができない」スタッフの分割境界(午前/午後パターンの境目に合わせる)
  const AM_PM_SPLIT = 14.5;
  // 同時にこなせる(1人で両方カウントしてよい)スキルの組み合わせ
  const LINKED_SKILL_GROUPS = [['フライヤー', '冷凍もの']];

  // スタッフの持つスキルから、シフト中に同時に担当できる「役割の組み合わせ候補」を作る。
  // 例: フライヤーと冷凍ものを両方持っていれば、その2つはセットで1つの候補になる。
  function getRoleGroupCandidates(staffSkills) {
    const skillSet = new Set(staffSkills || []);
    const used = new Set();
    const options = [];
    LINKED_SKILL_GROUPS.forEach(group => {
      if (group.every(sk => skillSet.has(sk))) {
        options.push(group.slice());
        group.forEach(sk => used.add(sk));
      }
    });
    (staffSkills || []).forEach(sk => {
      if (!used.has(sk)) options.push([sk]);
    });
    return options;
  }

  function isNewbie(staff) {
    return !!(staff && (staff.skills || []).includes('新人'));
  }

  // 勤務パターン。自動作成ではこのパターンの中からだけ割り当てる。
  //   access: 'all' = 全員 / 'special' = スタッフごとに許可した人だけ / 'employee' = 社員だけ(8:00出勤)
  // (キーは保存データの基本シフトで使っているので変えないこと)
  const PATTERNS = {
    p9: { start: 9, end: 20.5, access: 'all' },
    p1: { start: 9, end: 14.5, access: 'all' },
    p4: { start: 9, end: 17, access: 'special' },
    p5: { start: 11.5, end: 20.5, access: 'special' },
    p2: { start: 14.5, end: 20.5, access: 'all' },
    p3: { start: 17, end: 20.5, access: 'all' },
    p7: { start: 8, end: 20.5, access: 'employee' },
    p6: { start: 8, end: 14.5, access: 'employee' },
    p8: { start: 8, end: 17, access: 'employee' }
  };
  const SPECIAL_PATTERN_KEYS = Object.keys(PATTERNS).filter(k => PATTERNS[k].access === 'special');
  // 社員は毎日1人、この時刻から出勤する(開店前の準備)
  const EMPLOYEE_EARLY_START = 8;

  function isEmployee(staff) {
    return !!staff && (staff.jobRole || 'アルバイト') === '社員';
  }

  // 9:00〜17:00 / 11:30〜20:30 を担当できるか。
  // 未設定の古いデータは、基本シフトにそのパターンを登録している人を「担当できる」とみなす。
  function getSpecialPatterns(staff) {
    if (Array.isArray(staff.specialPatterns)) return staff.specialPatterns;
    return SPECIAL_PATTERN_KEYS.filter(k => staff.defaultWeekday === k || staff.defaultWeekend === k);
  }

  function canUsePattern(staff, key) {
    const p = PATTERNS[key];
    if (p.access === 'employee') return isEmployee(staff);
    if (p.access === 'special') return getSpecialPatterns(staff).includes(key);
    return true;
  }

  // そのスタッフが勤務を始められる最も早い時刻(社員だけは開店前の8:00から)
  function earliestStartFor(staff, settings) {
    return isEmployee(staff) ? Math.min(EMPLOYEE_EARLY_START, settings.openTime) : settings.openTime;
  }

  function defaultData() {
    return {
      staff: [],
      settings: {
        openTime: 9, closeTime: 20.5, minHeadcount: 2,
        requiredSkills: [], headcountRules: [], holidays: [], requiredRoles: []
      },
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

  function getDayType(dateStr, settings) {
    const isHoliday = (settings.holidays || []).includes(dateStr);
    return (isWeekendDate(dateStr) || isHoliday) ? 'weekend' : 'weekday';
  }

  function getDefaultRangeForStaffDate(staff, dateStr, settings) {
    const key = getDayType(dateStr, settings) === 'weekend' ? staff.defaultWeekend : staff.defaultWeekday;
    const p = PATTERNS[key];
    const earliest = earliestStartFor(staff, settings);
    if (!p) return { start: earliest, end: settings.closeTime };
    return { start: Math.max(p.start, earliest), end: Math.min(p.end, settings.closeTime) };
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

  // 日本語入力のまま打たれやすい全角数字・記号を半角にそろえる
  function normalizeAvailabilityInput(str) {
    return str
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[．。]/g, '.')
      .replace(/[：]/g, ':')
      .replace(/[／]/g, '/')
      .replace(/[～〜~－ー―‐−]/g, '-')
      .replace(/\s+/g, '');
  }

  function parseAvailabilityRaw(raw, open, close) {
    const s = normalizeAvailabilityInput(raw.trim());
    if (s === '') return { type: 'full', start: open, end: close, raw };
    if (s === '/' || s === '×' || s === '休' || s.toLowerCase() === 'off') {
      return { type: 'off', raw };
    }
    const norm = s;
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
  let staffTimePriorities = [];

  function renderStaffTimePriorityList() {
    const wrap = document.getElementById('staff-time-priority-list');
    if (staffTimePriorities.length === 0) {
      wrap.innerHTML = '<p class="help-text">優先度の設定はありません(すべての時間帯が同じ扱いになります)</p>';
      return;
    }
    wrap.innerHTML = staffTimePriorities.map((p, i) => `
      <div class="form-row" data-idx="${i}">
        <input type="time" class="priority-start" value="${hoursToTimeStr(p.start)}">
        〜
        <input type="time" class="priority-end" value="${hoursToTimeStr(p.end)}">
        <select class="priority-level">
          <option value="high" ${p.level === 'high' ? 'selected' : ''}>優先度高(積極的に入れる)</option>
          <option value="low" ${p.level === 'low' ? 'selected' : ''}>優先度低(できるだけ避ける)</option>
        </select>
        <button type="button" class="secondary priority-remove">削除</button>
      </div>`).join('');

    wrap.querySelectorAll('[data-idx]').forEach(row => {
      const idx = Number(row.dataset.idx);
      row.querySelector('.priority-start').addEventListener('change', (e) => {
        staffTimePriorities[idx].start = timeStrToHours(e.target.value);
      });
      row.querySelector('.priority-end').addEventListener('change', (e) => {
        staffTimePriorities[idx].end = timeStrToHours(e.target.value);
      });
      row.querySelector('.priority-level').addEventListener('change', (e) => {
        staffTimePriorities[idx].level = e.target.value;
      });
      row.querySelector('.priority-remove').addEventListener('click', () => {
        staffTimePriorities.splice(idx, 1);
        renderStaffTimePriorityList();
      });
    });
  }

  function bindStaffTimePriorityControls() {
    document.getElementById('add-staff-time-priority').addEventListener('click', () => {
      staffTimePriorities.push({ start: DATA.settings.openTime, end: DATA.settings.closeTime, level: 'high' });
      renderStaffTimePriorityList();
    });
  }

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
        <td>${escapeHtml(s.jobRole || 'アルバイト')}</td>
        <td>${(s.hourlyWage || 0).toLocaleString()}円</td>
        <td>${skillsText}</td>
        <td>${s.noContinuousShift ? '午前/午後のみ' : '通し可'}</td>
        <td>${escapeHtml(getSpecialPatterns(s).map(patternLabel).join('、') || 'なし')}</td>
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
        // 作成済みシフト表からも外し、不足判定を計算し直す
        Object.keys(DATA.results || {}).forEach(ym => {
          Object.keys(DATA.results[ym]).forEach(date => {
            const day = DATA.results[ym][date];
            const before = day.assignments.length;
            day.assignments = day.assignments.filter(a => a.staffId !== id);
            if (day.assignments.length !== before) recomputeShortages(ym, date);
          });
        });
        saveData(DATA);
        renderStaffTab();
        renderAvailabilityGrid();
        renderCoverageForm();
        renderGenerateResult();
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
    document.getElementById('staff-role').value = s.jobRole || 'アルバイト';
    document.getElementById('staff-no-continuous').checked = !!s.noContinuousShift;
    document.querySelectorAll('input[name="staff-skill"]').forEach(cb => {
      cb.checked = (s.skills || []).includes(cb.value);
    });
    renderAvoidCheckboxes(id);
    document.querySelectorAll('#staff-avoid-list input[type=checkbox]').forEach(cb => {
      cb.checked = (s.avoidWith || []).includes(cb.value);
    });
    const special = getSpecialPatterns(s);
    document.querySelectorAll('input[name="staff-special-pattern"]').forEach(cb => { cb.checked = special.includes(cb.value); });
    document.getElementById('staff-default-weekday').value = s.defaultWeekday || '';
    document.getElementById('staff-default-weekend').value = s.defaultWeekend || '';
    staffTimePriorities = JSON.parse(JSON.stringify(s.timePriorities || []));
    renderStaffTimePriorityList();

    document.getElementById('staff-submit-btn').textContent = 'スタッフを更新';
    document.getElementById('staff-cancel-btn').hidden = false;
    document.getElementById('staff-name').focus();
  }

  function cancelStaffEdit() {
    editingStaffId = null;
    document.getElementById('staff-form').reset();
    renderAvoidCheckboxes();
    staffTimePriorities = [];
    renderStaffTimePriorityList();
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
      const jobRole = document.getElementById('staff-role').value || 'アルバイト';
      const noContinuousShift = document.getElementById('staff-no-continuous').checked;
      const skills = Array.from(
        document.querySelectorAll('input[name="staff-skill"]:checked')
      ).map(cb => cb.value);
      const avoidWith = Array.from(
        document.querySelectorAll('#staff-avoid-list input[type=checkbox]:checked')
      ).map(cb => cb.value);
      const specialPatterns = Array.from(
        document.querySelectorAll('input[name="staff-special-pattern"]:checked')
      ).map(cb => cb.value);
      const defaultWeekday = document.getElementById('staff-default-weekday').value;
      const defaultWeekend = document.getElementById('staff-default-weekend').value;
      const timePriorities = staffTimePriorities.filter(p => p.start < p.end);

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
          s.jobRole = jobRole;
          s.noContinuousShift = noContinuousShift;
          s.specialPatterns = specialPatterns;
          s.skills = skills;
          s.avoidWith = [...avoidWith];
          s.defaultWeekday = defaultWeekday;
          s.defaultWeekend = defaultWeekend;
          s.timePriorities = timePriorities;
        }
        cancelStaffEdit();
      } else {
        const id = 's' + Date.now() + Math.floor(Math.random() * 1000);
        DATA.staff.push({ id, name, hourlyWage, jobRole, noContinuousShift, specialPatterns, skills, avoidWith: [...avoidWith], defaultWeekday, defaultWeekend, timePriorities });
        avoidWith.forEach(otherId => {
          const other = DATA.staff.find(s => s.id === otherId);
          if (other) {
            other.avoidWith = other.avoidWith || [];
            if (!other.avoidWith.includes(id)) other.avoidWith.push(id);
          }
        });
        e.target.reset();
        staffTimePriorities = [];
        renderStaffTimePriorityList();
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
      html += `<th class="${getDayType(d.dateStr, DATA.settings) === 'weekend' ? 'day-header-weekend' : ''}">${d.day}<br>${d.weekday}</th>`;
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
    renderHeadcountRulesList();
    renderHolidaysList();
    renderRequiredSkillsList();
    renderRequiredRolesList();
  }

  function renderHeadcountRulesList() {
    const wrap = document.getElementById('headcount-rules-list');
    DATA.settings.headcountRules = DATA.settings.headcountRules || [];
    if (DATA.settings.headcountRules.length === 0) {
      wrap.innerHTML = '<p class="help-text">個別ルールはありません(常に基本の最低人数が適用されます)</p>';
      return;
    }
    wrap.innerHTML = DATA.settings.headcountRules.map((r, i) => `
      <div class="form-row" data-idx="${i}">
        <select class="rule-daytype">
          <option value="weekday" ${r.dayType === 'weekday' ? 'selected' : ''}>平日</option>
          <option value="weekend" ${r.dayType === 'weekend' ? 'selected' : ''}>土日祝</option>
        </select>
        <label>時間帯 <input type="time" class="rule-start" value="${hoursToTimeStr(r.start)}"></label>
        〜
        <input type="time" class="rule-end" value="${hoursToTimeStr(r.end)}">
        <label>最低人数 <input type="number" class="rule-min" min="0" step="1" value="${r.min}" style="width:60px"></label>
        <label>目標人数 <input type="number" class="rule-desired" min="0" step="1" value="${r.desired != null ? r.desired : r.min}" style="width:60px"></label>
        <button type="button" class="secondary rule-remove">削除</button>
      </div>`).join('');

    wrap.querySelectorAll('[data-idx]').forEach(row => {
      const idx = Number(row.dataset.idx);
      row.querySelector('.rule-daytype').addEventListener('change', (e) => {
        DATA.settings.headcountRules[idx].dayType = e.target.value;
        saveData(DATA);
      });
      row.querySelector('.rule-start').addEventListener('change', (e) => {
        DATA.settings.headcountRules[idx].start = timeStrToHours(e.target.value);
        saveData(DATA);
      });
      row.querySelector('.rule-end').addEventListener('change', (e) => {
        DATA.settings.headcountRules[idx].end = timeStrToHours(e.target.value);
        saveData(DATA);
      });
      row.querySelector('.rule-min').addEventListener('change', (e) => {
        DATA.settings.headcountRules[idx].min = Number(e.target.value) || 0;
        saveData(DATA);
      });
      row.querySelector('.rule-desired').addEventListener('change', (e) => {
        DATA.settings.headcountRules[idx].desired = Number(e.target.value) || 0;
        saveData(DATA);
      });
      row.querySelector('.rule-remove').addEventListener('click', () => {
        DATA.settings.headcountRules.splice(idx, 1);
        saveData(DATA);
        renderHeadcountRulesList();
      });
    });
  }

  function renderHolidaysList() {
    const wrap = document.getElementById('holidays-list');
    DATA.settings.holidays = DATA.settings.holidays || [];
    if (DATA.settings.holidays.length === 0) {
      wrap.innerHTML = '<p class="help-text">登録された日はありません</p>';
      return;
    }
    const sorted = [...DATA.settings.holidays].sort();
    wrap.innerHTML = sorted.map(dateStr =>
      `<span class="assign-chip">${escapeHtml(dateStr)}
        <button type="button" class="holiday-remove" data-date="${dateStr}">×</button></span>`
    ).join('');
    wrap.querySelectorAll('.holiday-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        DATA.settings.holidays = DATA.settings.holidays.filter(d => d !== btn.dataset.date);
        saveData(DATA);
        renderHolidaysList();
      });
    });
  }

  function renderRequiredSkillsList() {
    const wrap = document.getElementById('required-skills-list');
    const allSkills = getAllSkills();
    if (DATA.settings.requiredSkills.length === 0) {
      wrap.innerHTML = '<p class="help-text">スキル条件はありません</p>';
      return;
    }
    wrap.innerHTML = DATA.settings.requiredSkills.map((r, i) => {
      const start = r.start != null ? r.start : DATA.settings.openTime;
      const end = r.end != null ? r.end : DATA.settings.closeTime;
      return `
      <div class="form-row" data-idx="${i}">
        <select class="req-skill-select">
          ${allSkills.length === 0
            ? '<option value="">(スタッフにスキルを登録してください)</option>'
            : allSkills.map(sk => `<option value="${escapeHtml(sk)}" ${sk === r.skill ? 'selected' : ''}>${escapeHtml(sk)}</option>`).join('')}
        </select>
        <input type="number" class="req-skill-count" min="0" step="1" value="${r.count}" style="width:70px">
        <label>時間帯 <input type="time" class="req-skill-start" value="${hoursToTimeStr(start)}"></label>
        〜
        <input type="time" class="req-skill-end" value="${hoursToTimeStr(end)}">
        <button type="button" class="secondary req-skill-remove">削除</button>
      </div>`;
    }).join('');

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
      row.querySelector('.req-skill-start').addEventListener('change', (e) => {
        DATA.settings.requiredSkills[idx].start = timeStrToHours(e.target.value);
        saveData(DATA);
      });
      row.querySelector('.req-skill-end').addEventListener('change', (e) => {
        DATA.settings.requiredSkills[idx].end = timeStrToHours(e.target.value);
        saveData(DATA);
      });
      row.querySelector('.req-skill-remove').addEventListener('click', () => {
        DATA.settings.requiredSkills.splice(idx, 1);
        saveData(DATA);
        renderRequiredSkillsList();
      });
    });
  }

  function renderRequiredRolesList() {
    const wrap = document.getElementById('required-roles-list');
    DATA.settings.requiredRoles = DATA.settings.requiredRoles || [];
    if (DATA.settings.requiredRoles.length === 0) {
      wrap.innerHTML = '<p class="help-text">役職条件はありません</p>';
      return;
    }
    wrap.innerHTML = DATA.settings.requiredRoles.map((r, i) => {
      const start = r.start != null ? r.start : DATA.settings.openTime;
      const end = r.end != null ? r.end : DATA.settings.closeTime;
      return `
      <div class="form-row" data-idx="${i}">
        <select class="req-role-select">
          ${ROLE_OPTIONS.map(rl => `<option value="${escapeHtml(rl)}" ${rl === r.role ? 'selected' : ''}>${escapeHtml(rl)}</option>`).join('')}
        </select>
        <input type="number" class="req-role-count" min="0" step="1" value="${r.count}" style="width:70px">
        <label>時間帯 <input type="time" class="req-role-start" value="${hoursToTimeStr(start)}"></label>
        〜
        <input type="time" class="req-role-end" value="${hoursToTimeStr(end)}">
        <button type="button" class="secondary req-role-remove">削除</button>
      </div>`;
    }).join('');

    wrap.querySelectorAll('[data-idx]').forEach(row => {
      const idx = Number(row.dataset.idx);
      row.querySelector('.req-role-select').addEventListener('change', (e) => {
        DATA.settings.requiredRoles[idx].role = e.target.value;
        saveData(DATA);
      });
      row.querySelector('.req-role-count').addEventListener('change', (e) => {
        DATA.settings.requiredRoles[idx].count = Number(e.target.value) || 0;
        saveData(DATA);
      });
      row.querySelector('.req-role-start').addEventListener('change', (e) => {
        DATA.settings.requiredRoles[idx].start = timeStrToHours(e.target.value);
        saveData(DATA);
      });
      row.querySelector('.req-role-end').addEventListener('change', (e) => {
        DATA.settings.requiredRoles[idx].end = timeStrToHours(e.target.value);
        saveData(DATA);
      });
      row.querySelector('.req-role-remove').addEventListener('click', () => {
        DATA.settings.requiredRoles.splice(idx, 1);
        saveData(DATA);
        renderRequiredRolesList();
      });
    });
  }

  function bindCoverageForm() {
    document.getElementById('add-required-role').addEventListener('click', () => {
      DATA.settings.requiredRoles = DATA.settings.requiredRoles || [];
      DATA.settings.requiredRoles.push({
        role: ROLE_OPTIONS[0],
        count: 1,
        start: DATA.settings.openTime,
        end: DATA.settings.closeTime
      });
      saveData(DATA);
      renderRequiredRolesList();
    });
    document.getElementById('add-headcount-rule').addEventListener('click', () => {
      DATA.settings.headcountRules = DATA.settings.headcountRules || [];
      DATA.settings.headcountRules.push({
        dayType: 'weekday',
        start: DATA.settings.openTime,
        end: DATA.settings.closeTime,
        min: DATA.settings.minHeadcount,
        desired: DATA.settings.minHeadcount
      });
      saveData(DATA);
      renderHeadcountRulesList();
    });
    document.getElementById('add-holiday').addEventListener('click', () => {
      const input = document.getElementById('holiday-date-input');
      const dateStr = input.value;
      if (!dateStr) return;
      DATA.settings.holidays = DATA.settings.holidays || [];
      if (!DATA.settings.holidays.includes(dateStr)) DATA.settings.holidays.push(dateStr);
      saveData(DATA);
      input.value = '';
      renderHolidaysList();
    });
    document.getElementById('add-required-skill').addEventListener('click', () => {
      const allSkills = getAllSkills();
      DATA.settings.requiredSkills.push({
        skill: allSkills[0] || '',
        count: 1,
        start: DATA.settings.openTime,
        end: DATA.settings.closeTime
      });
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

  function buildNeedMaps(settings, slots, dayType) {
    const headNeed = new Map(slots.map(sl => [sl.start, settings.minHeadcount]));
    const desiredExtra = new Map(slots.map(sl => [sl.start, 0]));
    (settings.headcountRules || []).filter(r => r.dayType === dayType).forEach(r => {
      slots.forEach(sl => {
        if (sl.start >= r.start - 1e-9 && sl.end <= r.end + 1e-9) {
          headNeed.set(sl.start, r.min);
          const desired = (r.desired != null && r.desired > r.min) ? r.desired : r.min;
          desiredExtra.set(sl.start, Math.max(0, desired - r.min));
        }
      });
    });
    const skillNeed = new Map(slots.map(sl => [sl.start, {}]));
    (settings.requiredSkills || []).filter(r => r.skill).forEach(r => {
      const rStart = r.start != null ? r.start : settings.openTime;
      const rEnd = r.end != null ? r.end : settings.closeTime;
      slots.forEach(sl => {
        if (sl.start >= rStart - 1e-9 && sl.end <= rEnd + 1e-9) {
          const sk = skillNeed.get(sl.start);
          sk[r.skill] = (sk[r.skill] || 0) + r.count;
        }
      });
    });
    const jobRoleNeed = new Map(slots.map(sl => [sl.start, {}]));
    (settings.requiredRoles || []).filter(r => r.role).forEach(r => {
      const rStart = r.start != null ? r.start : settings.openTime;
      const rEnd = r.end != null ? r.end : settings.closeTime;
      slots.forEach(sl => {
        if (sl.start >= rStart - 1e-9 && sl.end <= rEnd + 1e-9) {
          const rn = jobRoleNeed.get(sl.start);
          rn[r.role] = (rn[r.role] || 0) + r.count;
        }
      });
    });
    return { headNeed, desiredExtra, skillNeed, jobRoleNeed };
  }

  function applyAssignmentToNeed(assign, slots, headNeed, skillNeed, jobRoleNeed, staff) {
    for (const sl of slots) {
      if (sl.start >= assign.start - 1e-9 && sl.end <= assign.end + 1e-9) {
        if (!isNewbie(staff)) headNeed.set(sl.start, headNeed.get(sl.start) - 1);
        (assign.roles || []).forEach(roleName => {
          const sk = skillNeed.get(sl.start);
          if (sk[roleName] !== undefined) sk[roleName] = Math.max(0, sk[roleName] - 1);
        });
        const jobRole = staff.jobRole || 'アルバイト';
        const rn = jobRoleNeed.get(sl.start);
        if (rn[jobRole] !== undefined) rn[jobRole] = Math.max(0, rn[jobRole] - 1);
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
        JSON.stringify(s.missingSkills) === JSON.stringify(cur.missingSkills) &&
        JSON.stringify(s.missingRoles) === JSON.stringify(cur.missingRoles);
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

  function deriveShortages(slots, headNeed, skillNeed, jobRoleNeed) {
    const shortages = [];
    for (const sl of slots) {
      const hn = headNeed.get(sl.start);
      const sk = skillNeed.get(sl.start);
      const rn = jobRoleNeed.get(sl.start);
      const missingSkills = Object.entries(sk).filter(([, v]) => v > 0).map(([k, v]) => `${k}×${v}`);
      const missingRoles = Object.entries(rn).filter(([, v]) => v > 0).map(([k, v]) => `${k}×${v}`);
      if (hn > 0 || missingSkills.length > 0 || missingRoles.length > 0) {
        shortages.push({ start: sl.start, end: sl.end, headShort: Math.max(0, hn), missingSkills, missingRoles });
      }
    }
    return mergeConsecutive(shortages);
  }

  // 目標人数までの残り人数。headNeed は「最低人数 − 配置済み人数(新人除く)」なので、
  // 負の値は最低人数を超えて配置できている人数を表す。
  function desiredGap(headNeed, desiredExtra, slotStart) {
    return Math.max(0, headNeed.get(slotStart) + desiredExtra.get(slotStart));
  }

  // 目標人数の未達を集計する(最低人数自体が不足している枠は不足警告側で出すので除外)
  function deriveDesiredShortages(slots, headNeed, desiredExtra) {
    const items = [];
    for (const sl of slots) {
      if (headNeed.get(sl.start) > 0) continue;
      const remain = desiredGap(headNeed, desiredExtra, sl.start);
      if (remain > 0) items.push({ start: sl.start, end: sl.end, remain });
    }
    if (!items.length) return [];
    const merged = [];
    let cur = Object.assign({}, items[0]);
    for (let i = 1; i < items.length; i++) {
      const it = items[i];
      if (it.remain === cur.remain && Math.abs(it.start - cur.end) < 1e-9) {
        cur.end = it.end;
      } else {
        merged.push(cur);
        cur = Object.assign({}, it);
      }
    }
    merged.push(cur);
    return merged;
  }

  // スタッフが設定した「時間帯ごとの優先度」を、候補の時間範囲に重なる30分枠ごとに加点/減点してスコア化する。
  // 優先度高の枠は+1、優先度低の枠は-1(重なりがない枠や設定がなければ0)。
  function priorityScoreForCandidate(staff, cand, slots) {
    const prios = (staff && staff.timePriorities) || [];
    if (!prios.length) return 0;
    let score = 0;
    for (const sl of slots) {
      if (sl.start >= cand.start - 1e-9 && sl.end <= cand.end + 1e-9) {
        for (const p of prios) {
          if (sl.start >= p.start - 1e-9 && sl.end <= p.end + 1e-9) {
            score += p.level === 'high' ? 1 : p.level === 'low' ? -1 : 0;
            break;
          }
        }
      }
    }
    return score;
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

  // 「社員」は必要な最低人数(通常1人)を満たせば足りるため、同じ時間帯に社員が重複しないように
  // できるだけ避ける(人が足りずどうしても必要な場合は重複を許す、あくまでソフトな優先度)。
  const AVOID_ROLE_OVERLAP = '社員';
  function hasAvoidableRoleOverlap(cand, picked, staffMap) {
    const staff = staffMap[cand.staffId];
    if ((staff.jobRole || 'アルバイト') !== AVOID_ROLE_OVERLAP) return false;
    for (const p of picked) {
      const overlap = cand.start < p.end && p.start < cand.end;
      if (!overlap) continue;
      const pStaff = staffMap[p.staffId];
      if ((pStaff.jobRole || 'アルバイト') === AVOID_ROLE_OVERLAP) return true;
    }
    return false;
  }

  // 一人のスタッフは1回のシフトで基本1つの役割(スキル)しか担当できない前提だが、
  // LINKED_SKILL_GROUPSで組にしたスキル(例: フライヤーと冷凍もの)は同時に1人でカウントしてよい。
  // その前提で、そのスタッフが担当するのに最も貢献度の高い役割(の組)を1つだけ選んでスコア化する。
  function bestRoleAndScore(cand, slots, headNeed, skillNeed, jobRoleNeed, staffMap) {
    const staff = staffMap[cand.staffId];
    let headScore = 0;
    let jobRoleScore = 0;
    const jobRole = staff.jobRole || 'アルバイト';
    for (const sl of slots) {
      if (sl.start >= cand.start - 1e-9 && sl.end <= cand.end + 1e-9) {
        if (!isNewbie(staff) && headNeed.get(sl.start) > 0) headScore += 1;
        const rn = jobRoleNeed.get(sl.start);
        if (rn[jobRole] > 0) jobRoleScore += 1;
      }
    }
    let bestRoles = null;
    let bestSkillScore = 0;
    getRoleGroupCandidates(staff.skills).forEach(roleGroup => {
      let s = 0;
      for (const sl of slots) {
        if (sl.start >= cand.start - 1e-9 && sl.end <= cand.end + 1e-9) {
          const sk = skillNeed.get(sl.start);
          roleGroup.forEach(skName => { if (sk[skName] > 0) s += 1; });
        }
      }
      if (s > bestSkillScore) { bestSkillScore = s; bestRoles = roleGroup; }
    });
    return { score: headScore + bestSkillScore * 2 + jobRoleScore * 2, roles: bestRoles };
  }

  function solveDayCoverage(dayAvail, settings, staffMap, loadOf, dayType) {
    const slots = buildSlots(settings.openTime, settings.closeTime, 0.5);
    const { headNeed, desiredExtra, skillNeed, jobRoleNeed } = buildNeedMaps(settings, slots, dayType);
    let remaining = dayAvail.slice();
    const picked = [];

    function totalUnmet() {
      let unmet = 0;
      for (const sl of slots) {
        unmet += Math.max(0, headNeed.get(sl.start));
        Object.values(skillNeed.get(sl.start)).forEach(v => { unmet += Math.max(0, v); });
        Object.values(jobRoleNeed.get(sl.start)).forEach(v => { unmet += Math.max(0, v); });
      }
      return unmet;
    }

    while (totalUnmet() > 0 && remaining.length > 0) {
      let best = null, bestScore = -Infinity, bestRoles = null;
      for (const cand of remaining) {
        const { score: rawScore, roles } = bestRoleAndScore(cand, slots, headNeed, skillNeed, jobRoleNeed, staffMap);
        let score = rawScore;
        if (score <= 0) continue;
        score += priorityScoreForCandidate(staffMap[cand.staffId], cand, slots);
        if (hasConflict(cand, picked, staffMap)) score -= 1000;
        if (hasAvoidableRoleOverlap(cand, picked, staffMap)) score -= 50;
        score -= loadOf(cand.staffId) * GREEDY_LOAD_WEIGHT;
        score -= (cand.end - cand.start) * 0.001;
        if (score > bestScore) { bestScore = score; best = cand; bestRoles = roles; }
      }
      if (!best) break;
      const assign = { staffId: best.staffId, start: best.start, end: best.end, roles: bestRoles || [] };
      picked.push(assign);
      remaining = remaining.filter(c => c.staffId !== best.staffId);
      applyAssignmentToNeed(assign, slots, headNeed, skillNeed, jobRoleNeed, staffMap[best.staffId]);
    }

    // 最低人数(必須)を満たした後、余裕があれば「目標人数」まで追加で配置を試みる。
    // 満たせなくても不足警告にはしない(あくまで努力目標)。
    // 最低人数と同様、新人は目標人数にもカウントしない。
    function totalDesiredUnmet() {
      let unmet = 0;
      for (const sl of slots) unmet += desiredGap(headNeed, desiredExtra, sl.start);
      return unmet;
    }
    while (totalDesiredUnmet() > 0 && remaining.length > 0) {
      let best = null, bestScore = -Infinity;
      for (const cand of remaining) {
        if (isNewbie(staffMap[cand.staffId])) continue;
        let score = 0;
        for (const sl of slots) {
          if (sl.start >= cand.start - 1e-9 && sl.end <= cand.end + 1e-9 && desiredGap(headNeed, desiredExtra, sl.start) > 0) {
            score += 1;
          }
        }
        if (score <= 0) continue;
        score += priorityScoreForCandidate(staffMap[cand.staffId], cand, slots);
        if (hasConflict(cand, picked, staffMap)) score -= 1000;
        if (hasAvoidableRoleOverlap(cand, picked, staffMap)) score -= 50;
        score -= loadOf(cand.staffId) * GREEDY_LOAD_WEIGHT;
        score -= (cand.end - cand.start) * 0.001;
        if (score > bestScore) { bestScore = score; best = cand; }
      }
      if (!best) break;
      const { roles } = bestRoleAndScore(best, slots, headNeed, skillNeed, jobRoleNeed, staffMap);
      const assign = { staffId: best.staffId, start: best.start, end: best.end, roles: roles || [], desiredOnly: true };
      picked.push(assign);
      remaining = remaining.filter(c => c.staffId !== best.staffId);
      applyAssignmentToNeed(assign, slots, headNeed, skillNeed, jobRoleNeed, staffMap[best.staffId]);
    }

    // 目標人数のために追加した人が不足スキル・役職を埋めることもあるので、最後に集計する
    const shortages = deriveShortages(slots, headNeed, skillNeed, jobRoleNeed);
    const desiredShortages = deriveDesiredShortages(slots, headNeed, desiredExtra);
    return { assignments: picked, shortages, desiredShortages };
  }

  // ---------- 月全体でのバランス調整 ----------
  //
  // 日ごとの貪欲法だけだと「その日に一番多く枠を埋められる人(=希望時間が長い人、同点なら登録順が上の人)」が
  // 毎日選ばれ、月を通すと特定の人に偏る。そこで貪欲法で作った案を出発点に、
  // 「1日分の入れ替え・追加・削除」を、月全体の評価が良くなる限り繰り返す(局所探索)。
  //
  // 評価(小さいほど良い)の重み。上から順に重要。
  const W_SHORTAGE = 1000;      // 最低人数・必須スキル・必須役職の不足(30分枠×人数ごと)
  const W_CONFLICT = 5000;      // 組ませたくない2人の同時勤務(1組ごと。2.5時間分の不足よりは避ける)
  const W_DESIRED = 10;         // 目標人数までの不足(30分枠×人数ごと)
  const W_FAIR_DAYS = 30;       // 月の出勤日数の偏り(下の fairnessPenalty)
  const W_FAIR_HOURS = 2;       // 月の勤務時間の偏り(同上)
  const W_PRIORITY = 3;         // スタッフの時間帯優先度(30分枠ごと)
  const W_ROLE_OVERLAP = 5;     // 社員どうしの重複(30分枠ごと)
  const W_EARLY_MISSING = 2000; // 8:00出勤の社員がいない日(1時間分の不足として扱う)
  const W_EARLY_EXTRA = 50;     // 8:00出勤の社員が2人以上(1人増えるごと)
  const W_LONG_SHIFT = 20;      // 14:30をまたぐ長いシフト(できるだけ14:30で区切る)
  const W_LABOR = 1;            // 勤務時間そのもの(30分枠ごと。不要な配置や長すぎる配置を減らす)
  const W_NEWBIE_ALONE = 1000;  // 新人が「最低人数を満たしていない時間帯」や「新人どうし」で入っている(30分枠×人数ごと)
  const GREEDY_LOAD_WEIGHT = 10; // 初期案(貪欲法)で、すでに多く入っている人を後回しにする強さ
  const MAX_SWEEPS = 40;

  // 月を通した配置を「出勤可能な量に比例した配分」に近づけるためのペナルティ。
  // 全員の 出勤日数÷出勤可能日数(出勤率)と 勤務時間÷勤務可能時間(配置率)がそろうのが理想で、
  // そこからのズレの二乗和で測る。希望を多く出した人ほど多く入り、少ない人は少なめになる。
  function proportionalDeviation(used, avail, staffIds) {
    let U = 0, A = 0;
    staffIds.forEach(id => { if (avail[id] > 0) { U += used[id]; A += avail[id]; } });
    if (A <= 0) return 0;
    const ratio = U / A;
    let p = 0;
    staffIds.forEach(id => {
      const a = avail[id];
      if (a > 0) { const dev = used[id] - ratio * a; p += dev * dev / a; }
    });
    return p;
  }

  function fairnessPenalty(load, avail, staffIds) {
    return proportionalDeviation(load.days, avail.days, staffIds) * W_FAIR_DAYS +
      proportionalDeviation(load.hours, avail.hours, staffIds) * W_FAIR_HOURS;
  }

  // ある日の必要人数などを配列にしたもの(評価のたびに作り直さないよう日ごとにキャッシュ)
  function dayTemplate(day) {
    if (day.tmpl) return day.tmpl;
    const { slots, dayType } = day;
    const { headNeed, desiredExtra, skillNeed, jobRoleNeed } = buildNeedMaps(DATA.settings, slots, dayType);
    day.tmpl = {
      head: slots.map(sl => headNeed.get(sl.start)),
      extra: slots.map(sl => desiredExtra.get(sl.start)),
      skill: slots.map(sl => skillNeed.get(sl.start)),
      role: slots.map(sl => jobRoleNeed.get(sl.start)),
      ranges: new Map(),
      prio: new Map()
    };
    return day.tmpl;
  }

  // 勤務 a に完全に含まれる30分枠の範囲 [i0, i1)
  function slotRange(day, a) {
    const tmpl = dayTemplate(day);
    const key = a.start + '-' + a.end;
    let r = tmpl.ranges.get(key);
    if (!r) {
      let i0 = -1, i1 = -1;
      day.slots.forEach((sl, i) => {
        if (sl.start >= a.start - 1e-9 && sl.end <= a.end + 1e-9) { if (i0 < 0) i0 = i; i1 = i + 1; }
      });
      r = i0 < 0 ? [0, 0] : [i0, i1];
      tmpl.ranges.set(key, r);
    }
    return r;
  }

  const roleGroupCache = new WeakMap();
  function roleGroupsOf(staff) {
    let g = roleGroupCache.get(staff);
    if (!g) { g = getRoleGroupCandidates(staff.skills); roleGroupCache.set(staff, g); }
    return g;
  }

  // ある日の配置案を評価し、役割(スキル)の割り振りもあわせて決める
  function evaluateDay(day, assigned, staffMap) {
    const tmpl = dayTemplate(day);
    const n = day.slots.length;
    const head = tmpl.head.slice();
    const skill = tmpl.skill.map(o => Object.assign({}, o));
    const role = tmpl.role.map(o => Object.assign({}, o));
    const withRoles = assigned.map(a => ({ staffId: a.staffId, start: a.start, end: a.end, roles: [] }));
    const ranges = withRoles.map(a => slotRange(day, a));

    const newbies = new Array(n).fill(0);
    const veterans = new Array(n).fill(0);
    withRoles.forEach((a, k) => {
      const st = staffMap[a.staffId];
      const newbie = isNewbie(st);
      const jobRole = st.jobRole || 'アルバイト';
      for (let i = ranges[k][0]; i < ranges[k][1]; i++) {
        if (newbie) newbies[i] += 1; else veterans[i] += 1;
        if (!newbie) head[i] -= 1;
        if (role[i][jobRole] !== undefined) role[i][jobRole] = Math.max(0, role[i][jobRole] - 1);
      }
    });

    // 担当できる役割が少ない人から順に、まだ足りていない役割を割り当てる
    const order = withRoles.map((a, k) => k).sort((x, y) =>
      roleGroupsOf(staffMap[withRoles[x].staffId]).length - roleGroupsOf(staffMap[withRoles[y].staffId]).length);
    order.forEach(k => {
      const a = withRoles[k];
      const [i0, i1] = ranges[k];
      let best = null, bestScore = 0;
      roleGroupsOf(staffMap[a.staffId]).forEach(group => {
        let s = 0;
        for (let i = i0; i < i1; i++) group.forEach(sk => { if (skill[i][sk] > 0) s++; });
        if (s > bestScore) { bestScore = s; best = group; }
      });
      if (!best) return;
      a.roles = best.slice();
      for (let i = i0; i < i1; i++) {
        best.forEach(name => { if (skill[i][name] !== undefined) skill[i][name] = Math.max(0, skill[i][name] - 1); });
      }
    });

    // coverage: 不足・目標未達だけの評価(人を追加する価値があるかの判定に使う)
    let coverage = 0;
    let penalty0 = 0;
    for (let i = 0; i < n; i++) {
      coverage += Math.max(0, head[i]) * W_SHORTAGE;
      for (const k in skill[i]) coverage += Math.max(0, skill[i][k]) * W_SHORTAGE;
      for (const k in role[i]) coverage += Math.max(0, role[i][k]) * W_SHORTAGE;
      coverage += Math.max(0, head[i] + tmpl.extra[i]) * W_DESIRED;
    }
    // 社員のうち1人は毎日8:00出勤
    if (day.needsEarly) {
      const early = withRoles.filter(a => a.start <= EMPLOYEE_EARLY_START + 1e-9 && isEmployee(staffMap[a.staffId])).length;
      if (early === 0) coverage += W_EARLY_MISSING;
      else penalty0 = (early - 1) * W_EARLY_EXTRA;
    }
    let penalty = coverage + penalty0;
    // 新人は、新人以外で最低人数を満たしている時間帯に、新人1人ずつで入れる
    for (let i = 0; i < n; i++) {
      if (newbies[i] === 0) continue;
      if (head[i] > 0 || veterans[i] === 0) penalty += newbies[i] * W_NEWBIE_ALONE;
      else if (newbies[i] > 1) penalty += (newbies[i] - 1) * W_NEWBIE_ALONE;
    }
    for (let i = 0; i < withRoles.length; i++) {
      const a = withRoles[i], sa = staffMap[a.staffId];
      penalty += (a.end - a.start) * 2 * W_LABOR;
      if (crossesAmPm(a.start, a.end)) penalty += W_LONG_SHIFT;
      const pk = a.staffId + '|' + a.start + '|' + a.end;
      let prio = tmpl.prio.get(pk);
      if (prio === undefined) { prio = priorityScoreForCandidate(sa, a, day.slots); tmpl.prio.set(pk, prio); }
      penalty -= prio * W_PRIORITY;
      for (let j = i + 1; j < withRoles.length; j++) {
        const b = withRoles[j], sb = staffMap[b.staffId];
        const ov = Math.min(a.end, b.end) - Math.max(a.start, b.start);
        if (ov <= 0) continue;
        if ((sa.avoidWith || []).includes(b.staffId) || (sb.avoidWith || []).includes(a.staffId)) penalty += W_CONFLICT;
        if ((sa.jobRole || 'アルバイト') === AVOID_ROLE_OVERLAP && (sb.jobRole || 'アルバイト') === AVOID_ROLE_OVERLAP) {
          penalty += ov * 2 * W_ROLE_OVERLAP;
        }
      }
    }
    return { penalty, coverage, withRoles };
  }

  // スタッフがその日に入れる時間帯の候補 = 希望時間帯に収まる勤務パターン(そのスタッフが担当できるものだけ)。
  // 社員は開店から入れる日なら8:00出勤のパターンも候補にする。
  // 通し勤務不可の人は、14:30をまたぐパターンを除く。
  function buildDayCandidates(dateStr) {
    const cands = [];
    const settings = DATA.settings;
    DATA.staff.forEach(s => {
      let rec = DATA.availability[s.id + '__' + dateStr];
      if (!rec) {
        const def = getDefaultRangeForStaffDate(s, dateStr, settings);
        rec = { type: 'range', start: def.start, end: def.end };
      }
      if (rec.type === 'off' || rec.type === 'invalid') return;
      const earliest = earliestStartFor(s, settings);
      // 開店から入れる社員は、開店前の早出もできるとみなす
      const start = rec.start <= settings.openTime + 1e-9 ? earliest : Math.max(rec.start, earliest);
      const end = Math.min(rec.end, settings.closeTime);
      if (!(start < end)) return;
      Object.keys(PATTERNS).forEach(key => {
        const p = PATTERNS[key];
        if (!canUsePattern(s, key)) return;
        const pe = Math.min(p.end, settings.closeTime);
        if (!(p.start < pe) || p.start < start - 1e-9 || pe > end + 1e-9) return;
        if (s.noContinuousShift && crossesAmPm(p.start, pe)) return;
        cands.push({ staffId: s.id, start: p.start, end: pe });
      });
    });
    return cands;
  }

  function crossesAmPm(start, end) {
    return start < AM_PM_SPLIT - 1e-9 && end > AM_PM_SPLIT + 1e-9;
  }

  // 月の出勤可能日数と勤務可能時間(その日に入れる最長の時間帯の合計)
  function computeAvailability(ym) {
    const avail = { days: {}, hours: {} };
    DATA.staff.forEach(s => { avail.days[s.id] = 0; avail.hours[s.id] = 0; });
    getDatesInMonth(ym).forEach(d => {
      const longest = {};
      buildDayCandidates(d.dateStr).forEach(c => {
        longest[c.staffId] = Math.max(longest[c.staffId] || 0, c.end - c.start);
      });
      Object.keys(longest).forEach(id => { avail.days[id] += 1; avail.hours[id] += longest[id]; });
    });
    return avail;
  }

  function generateForMonth(ym) {
    const staffMap = {};
    DATA.staff.forEach(s => { staffMap[s.id] = s; });
    const staffIds = DATA.staff.map(s => s.id);
    const slots = buildSlots(DATA.settings.openTime, DATA.settings.closeTime, 0.5);
    const avail = computeAvailability(ym);
    const load = { days: {}, hours: {} };
    staffIds.forEach(id => { load.days[id] = 0; load.hours[id] = 0; });
    const addLoad = (a, sign) => { load.days[a.staffId] += sign; load.hours[a.staffId] += sign * (a.end - a.start); };
    const loadOf = id => (avail.days[id] > 0 ? load.days[id] / avail.days[id] : 0);

    // 1) 日ごとの貪欲法で初期案を作る(すでに出勤率が高い人ほど後回し)
    const days = getDatesInMonth(ym).map(d => {
      const day = {
        dateStr: d.dateStr, dayType: getDayType(d.dateStr, DATA.settings), slots,
        cands: buildDayCandidates(d.dateStr), needsEarly: DATA.staff.some(isEmployee)
      };
      const r = solveDayCoverage(day.cands, DATA.settings, staffMap, loadOf, day.dayType);
      day.assigned = r.assignments.map(a => ({ staffId: a.staffId, start: a.start, end: a.end }));
      day.assigned.forEach(a => addLoad(a, 1));
      const ev = evaluateDay(day, day.assigned, staffMap);
      day.penalty = ev.penalty;
      day.coverage = ev.coverage;
      return day;
    });

    // 2) 月全体の評価が良くなる限り、1日単位の入れ替え・追加・削除を繰り返す
    let fair = fairnessPenalty(load, avail, staffIds);
    for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
      let improved = false;
      days.forEach(day => {
        const assignedIds = new Set(day.assigned.map(a => a.staffId));
        // 候補の手: removed を外して added を入れる
        const moves = [];
        day.assigned.forEach((a, i) => {
          moves.push({ removed: [a], added: [] });
          day.cands.forEach(c => {
            if (c.staffId === a.staffId ? (c.start !== a.start || c.end !== a.end) : !assignedIds.has(c.staffId)) {
              moves.push({ removed: [a], added: [c] });
            }
          });
          // 交代: a の勤務を短くし、空いた時間を別の人が引き継ぐ(例: 終日→午前のみ + 午後に別の人)
          day.cands.forEach(w => {
            if (w.staffId !== a.staffId || w.start < a.start - 1e-9 || w.end > a.end + 1e-9) return;
            if (w.start === a.start && w.end === a.end) return;
            day.cands.forEach(c => {
              if (assignedIds.has(c.staffId)) return;
              const coversFreed = (c.start < w.start && c.end > a.start) || (c.end > w.end && c.start < a.end);
              if (coversFreed) moves.push({ removed: [a], added: [w, c] });
            });
          });
        });
        day.cands.forEach(c => { if (!assignedIds.has(c.staffId)) moves.push({ removed: [], added: [c] }); });

        let best = null, bestDelta = -1e-6;
        moves.forEach(m => {
          const next = day.assigned.filter(a => !m.removed.includes(a)).concat(m.added);
          m.removed.forEach(a => addLoad(a, -1));
          m.added.forEach(a => addLoad(a, 1));
          const nextFair = fairnessPenalty(load, avail, staffIds);
          m.removed.forEach(a => addLoad(a, 1));
          m.added.forEach(a => addLoad(a, -1));
          const ev = evaluateDay(day, next, staffMap);
          const delta = (ev.penalty - day.penalty) + (nextFair - fair);
          if (delta >= bestDelta) return;
          // 出勤率をそろえるためだけに人を入れない。
          // 新しく入る人は、その人がいないと不足・目標未達が出るときだけ認める(同じ人の時間変更は対象外)。
          // ただし新人は人数に数えないので例外とし、上の W_NEWBIE_ALONE の条件を満たす範囲で研修として入れる。
          const newcomer = m.added.find(c => !m.removed.some(a => a.staffId === c.staffId));
          if (newcomer && !isNewbie(staffMap[newcomer.staffId])) {
            const without = evaluateDay(day, next.filter(c => c !== newcomer), staffMap);
            if (ev.coverage >= without.coverage - 1e-9) return;
          }
          bestDelta = delta;
          best = { m, next, ev, nextFair };
        });
        if (!best) return;
        best.m.removed.forEach(a => addLoad(a, -1));
        best.m.added.forEach(a => addLoad(a, 1));
        day.assigned = best.next;
        day.penalty = best.ev.penalty;
        day.coverage = best.ev.coverage;
        fair = best.nextFair;
        improved = true;
      });
      if (!improved) break;
    }

    const result = {};
    days.forEach(day => {
      const assignments = evaluateDay(day, day.assigned, staffMap).withRoles
        .sort((x, y) => x.start - y.start || x.end - y.end);
      result[day.dateStr] = Object.assign({ assignments }, summarizeDay(day.dateStr, assignments));
    });

    DATA.results = DATA.results || {};
    DATA.results[ym] = result;
    saveData(DATA);
    return result;
  }

  function summarizeDay(date, assignments) {
    const staffMap = {};
    DATA.staff.forEach(s => { staffMap[s.id] = s; });
    const slots = buildSlots(DATA.settings.openTime, DATA.settings.closeTime, 0.5);
    const dayType = getDayType(date, DATA.settings);
    const { headNeed, desiredExtra, skillNeed, jobRoleNeed } = buildNeedMaps(DATA.settings, slots, dayType);
    assignments.forEach(a => {
      applyAssignmentToNeed(a, slots, headNeed, skillNeed, jobRoleNeed, staffMap[a.staffId] || { skills: [], jobRole: 'アルバイト' });
    });
    const shortages = deriveShortages(slots, headNeed, skillNeed, jobRoleNeed);
    const hasEarly = assignments.some(a => a.start <= EMPLOYEE_EARLY_START + 1e-9 && isEmployee(staffMap[a.staffId]));
    if (DATA.staff.some(isEmployee) && !hasEarly) {
      shortages.unshift({
        start: EMPLOYEE_EARLY_START, end: DATA.settings.openTime, headShort: 0,
        missingSkills: [], missingRoles: ['8:00出勤の社員×1']
      });
    }
    return {
      shortages,
      desiredShortages: deriveDesiredShortages(slots, headNeed, desiredExtra)
    };
  }

  function recomputeShortages(ym, date) {
    Object.assign(DATA.results[ym][date], summarizeDay(date, DATA.results[ym][date].assignments));
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
        const roleTag = (a.roles && a.roles.length) ? `[${escapeHtml(a.roles.join('・'))}]` : '';
        html += `<span class="assign-chip">${escapeHtml(staff ? staff.name : '?')}${newbieTag} ${hoursToTimeStr(a.start)}-${hoursToTimeStr(a.end)}${roleTag}
          <button type="button" class="remove-assign-btn" data-date="${d.dateStr}" data-idx="${idx}">×</button></span>`;
      });
      html += '</div>';
      dayResult.shortages.forEach(sh => {
        const parts = [];
        if (sh.headShort > 0) parts.push(`人数不足(${sh.headShort}人)`);
        if (sh.missingSkills.length) parts.push('不足スキル: ' + sh.missingSkills.join('、'));
        if (sh.missingRoles && sh.missingRoles.length) parts.push('不足役職: ' + sh.missingRoles.join('、'));
        html += `<div class="shortage-warning">⚠ ${hoursToTimeStr(sh.start)}-${hoursToTimeStr(sh.end)} ${parts.join(' / ')}</div>`;
      });
      (dayResult.desiredShortages || []).forEach(ds => {
        html += `<div class="desired-note">◯ ${hoursToTimeStr(ds.start)}-${hoursToTimeStr(ds.end)} 目標人数まであと${ds.remain}人(最低人数は満たしています)</div>`;
      });
      const candidates = DATA.staff.filter(s => !assignedIds.has(s.id));
      if (candidates.length > 0) {
        const roleOptionsFor = (s) => `<option value="">役割なし(接客)</option>` +
          getRoleGroupCandidates(s.skills).map(group =>
            `<option value="${escapeHtml(group.join(','))}">${escapeHtml(group.join('・'))}</option>`
          ).join('');
        html += `<div class="add-assign-row">
          <select class="add-staff-select">
            ${candidates.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
          </select>
          <select class="add-role-select">${roleOptionsFor(candidates[0])}</select>
          <input type="time" class="add-start-time" value="${hoursToTimeStr(DATA.settings.openTime)}">
          <input type="time" class="add-end-time" value="${hoursToTimeStr(DATA.settings.closeTime)}">
          <button type="button" class="secondary add-assign-btn" data-date="${d.dateStr}">追加</button>
        </div>`;
      }
      html += '</div>';
    });

    const workDays = {};
    DATA.staff.forEach(s => { workDays[s.id] = 0; });
    dates.forEach(d => {
      const dayResult = monthResult[d.dateStr];
      if (!dayResult) return;
      new Set(dayResult.assignments.map(a => a.staffId)).forEach(id => { if (id in workDays) workDays[id]++; });
    });
    const avail = computeAvailability(ym);

    html += '<table class="data-table summary-table"><thead><tr><th>スタッフ</th><th>出勤日数</th><th>出勤率</th><th>合計時間</th><th>時給</th><th>給与(概算)</th></tr></thead><tbody>';
    let totalWage = 0;
    DATA.staff.forEach(s => {
      const wage = s.hourlyWage || 0;
      const pay = Math.round(totalHours[s.id] * wage);
      totalWage += pay;
      const rate = avail.days[s.id] > 0 ? Math.round(workDays[s.id] / avail.days[s.id] * 100) + '%' : '-';
      html += `<tr><td>${escapeHtml(s.name)}</td><td>${workDays[s.id]}日 / ${avail.days[s.id]}日</td><td>${rate}</td><td>${totalHours[s.id].toFixed(1)}時間</td><td>${wage.toLocaleString()}円</td><td>${pay.toLocaleString()}円</td></tr>`;
    });
    html += `<tr><td><strong>合計</strong></td><td></td><td></td><td></td><td></td><td><strong>${totalWage.toLocaleString()}円</strong></td></tr>`;
    html += '</tbody></table>';
    html += '<p class="help-text">※出勤日数は「出勤する日数 / 出勤できる日数(希望入力・基本シフトから計算)」です。自動作成では、全員の出勤率ができるだけそろうように月全体で調整します。</p>';
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
    wrap.querySelectorAll('.add-assign-row').forEach(row => {
      const staffSelect = row.querySelector('.add-staff-select');
      const roleSelect = row.querySelector('.add-role-select');
      staffSelect.addEventListener('change', () => {
        const s = staffMap[staffSelect.value];
        roleSelect.innerHTML = '<option value="">役割なし(接客)</option>' +
          getRoleGroupCandidates(s && s.skills).map(group =>
            `<option value="${escapeHtml(group.join(','))}">${escapeHtml(group.join('・'))}</option>`
          ).join('');
      });
    });
    wrap.querySelectorAll('.add-assign-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const date = btn.dataset.date;
        const row = btn.closest('.add-assign-row');
        const staffId = row.querySelector('.add-staff-select').value;
        const roleValue = row.querySelector('.add-role-select').value;
        const roles = roleValue ? roleValue.split(',') : [];
        const start = timeStrToHours(row.querySelector('.add-start-time').value);
        const end = timeStrToHours(row.querySelector('.add-end-time').value);
        if (!(start < end)) { alert('開始時刻は終了時刻より前にしてください'); return; }
        DATA.results[ym][date].assignments.push({ staffId, start, end, roles });
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
    const rows = [['日付', '曜日', 'スタッフ', '開始', '終了', '役割']];
    getDatesInMonth(ym).forEach(d => {
      const dayResult = monthResult[d.dateStr];
      if (!dayResult || dayResult.assignments.length === 0) {
        rows.push([d.dateStr, d.weekday, '', '', '', '']);
      } else {
        dayResult.assignments.forEach(a => {
          rows.push([d.dateStr, d.weekday, staffMap[a.staffId] ? staffMap[a.staffId].name : '', hoursToTimeStr(a.start), hoursToTimeStr(a.end), (a.roles || []).join('・')]);
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
      const btn = document.getElementById('generate-btn');
      btn.disabled = true;
      btn.textContent = '作成中…(月全体のバランスを調整しています)';
      // 表示を更新してから重い計算を始める
      setTimeout(() => {
        try {
          generateForMonth(ym);
          renderGenerateResult();
        } finally {
          btn.disabled = false;
          btn.textContent = '自動生成する';
        }
      }, 30);
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

  function renderDefaultShiftOptions() {
    const note = { all: '', special: '(許可した人のみ)', employee: '(社員のみ)' };
    const html = '<option value="">未設定</option>' + Object.keys(PATTERNS).map(k =>
      `<option value="${k}">${patternLabel(k)}${note[PATTERNS[k].access]}</option>`).join('');
    ['staff-default-weekday', 'staff-default-weekend'].forEach(id => { document.getElementById(id).innerHTML = html; });
  }

  // ---------- init ----------

  document.addEventListener('DOMContentLoaded', async () => {
    renderDefaultShiftOptions();
    initTabs();
    bindStaffForm();
    bindStaffTimePriorityControls();
    renderStaffTimePriorityList();
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
