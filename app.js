/* ===== Sprout & Paw: app logic =====
   Screens, timeline, adding/editing days, and the photo viewer. */
(function () {
  'use strict';

  const MAX_PHOTOS = 3; // per date
  const SETTINGS_KEY = 'sproutpaw:settings';

  const CATS = {
    plant:  { word: 'plant', plural: 'plants', defaultName: 'My plant', icon: '#i-leaf', note: 'New leaf today, watered in the morning' },
    animal: { word: 'pet',   plural: 'pets',   defaultName: 'My pet',   icon: '#i-paw',  note: 'Weighed 3.2 kg, learned a new trick' }
  };

  const $ = id => document.getElementById(id);

  // ----- Settings (small things kept in localStorage) -----
  const settings = loadSettings();
  function loadSettings() {
    const base = { category: null, diaryId: null, newestFirst: true, names: {} };
    try { return Object.assign(base, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}); }
    catch (e) { return base; }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  let diaries = [];             // every plant and pet
  let diary = null;             // the open diary
  let entries = [];             // days for the open diary
  const thumbCache = new Map(); // photoId -> Promise<object URL>
  let sheet = null;             // add/edit form state
  let pickTarget = 'new';       // where picked photos go: 'new' or 'sheet'
  let viewer = null;

  // ----- Small helpers -----
  const pad = n => String(n).padStart(2, '0');
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function parseDate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function formatDate(s) {
    return parseDate(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const formatSize = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const entryId = (diaryId, date) => diaryId + ':' + date;
  const diariesIn = cat => diaries.filter(d => d.category === cat)
    .sort((a, b) => a.created - b.created);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function icon(name, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  let toastTimer;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2800);
  }

  function lockScroll(on) { document.body.classList.toggle('no-scroll', on); }

  // ----- In-app pop-up (instead of the browser's prompt/confirm) -----
  // input: true shows a text box. Resolves with the text (or true), or null if cancelled.
  function showDialog(o) {
    return new Promise(resolve => {
      const box = $('dialog'), form = $('dialogForm'), inp = $('dialogInput');
      const okBtn = $('dialogOk'), cancelBtn = $('dialogCancel');
      $('dialogTitle').textContent = o.title;
      $('dialogText').textContent = o.text || '';
      inp.hidden = !o.input;
      inp.value = o.value || '';
      inp.placeholder = o.placeholder || '';
      okBtn.textContent = o.ok || 'OK';
      okBtn.classList.toggle('is-danger', !!o.danger);
      box.hidden = false;
      lockScroll(true);
      setTimeout(() => { if (o.input) { inp.focus(); inp.select(); } else okBtn.focus(); }, 60);

      const finish = value => {
        box.hidden = true;
        if (!sheet && $('pickSheet').hidden && !viewer) lockScroll(false);
        form.removeEventListener('submit', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        box.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey, true);
        resolve(value);
      };
      const onOk = e => { e.preventDefault(); finish(o.input ? inp.value : true); };
      const onCancel = () => finish(null);
      const onBackdrop = e => { if (e.target === box) finish(null); };
      const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
      form.addEventListener('submit', onOk);
      cancelBtn.addEventListener('click', onCancel);
      box.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey, true);
    });
  }
  const askText = o => showDialog(Object.assign({}, o, { input: true }));
  const askConfirm = o => showDialog(o).then(v => v !== null);

  function setThemeColor() {
    const c = getComputedStyle(document.body).getPropertyValue('--primary').trim();
    document.querySelector('meta[name="theme-color"]').setAttribute('content', c || '#2F7D4A');
  }

  // ===== Screens =====
  function showScreen(id) {
    ['chooseScreen', 'listScreen', 'diaryScreen'].forEach(x => { $(x).hidden = x !== id; });
    $('toast').hidden = true;
    window.scrollTo(0, 0);
  }

  async function loadDiaries() {
    try { diaries = await DB.getDiaries(); }
    catch (e) {
      diaries = [];
      toast('Storage is blocked in this browser, so photos can’t be saved.', 5000);
    }
  }

  // Screen 1: plant or animal
  async function showChoose() {
    settings.category = null;
    settings.diaryId = null;
    saveSettings();
    diary = null;
    document.body.dataset.theme = 'none';
    showScreen('chooseScreen');
    setThemeColor();
    await loadDiaries();
    ['plant', 'animal'].forEach(cat => {
      const n = diariesIn(cat).length;
      $('meta-' + cat).textContent = n ? plural(n, CATS[cat].word) : 'Start a new diary';
    });
  }

  // Screen 2: the list of plants or pets
  async function showList(cat) {
    settings.category = cat;
    settings.diaryId = null;
    saveSettings();
    diary = null;
    document.body.dataset.theme = cat;
    const c = CATS[cat];
    $('listTitle').textContent = 'Your ' + c.plural;
    $('listIcon').setAttribute('href', c.icon);
    $('listEmptyIcon').setAttribute('href', c.icon);
    $('listEmptyTitle').textContent = 'No ' + c.plural + ' yet';
    $('newDiaryLabel').textContent = 'Add a ' + c.word;
    showScreen('listScreen');
    setThemeColor();
    await loadDiaries();
    await renderList();
  }

  async function renderList() {
    const cat = settings.category;
    const mine = diariesIn(cat);
    let allEntries = [];
    try { allEntries = await DB.getEntries(); } catch (e) { /* shown as empty */ }

    const box = $('diaryList');
    box.textContent = '';
    $('listEmpty').hidden = mine.length > 0;
    const covers = [];

    mine.forEach(d => {
      const days = allEntries.filter(e => e.diaryId === d.id).sort((a, b) => (a.date < b.date ? 1 : -1));
      const photos = days.reduce((n, e) => n + e.photoIds.length, 0);

      const card = el('button', 'diary-card');
      card.type = 'button';
      const cover = el('span', 'diary-cover');
      if (days.length && days[0].photoIds.length) {
        const img = el('img');
        img.alt = '';
        const pid = days[0].photoIds[0];
        covers.push(pid);
        thumbUrl(pid).then(u => { if (u) img.src = u; });
        cover.appendChild(img);
      } else {
        cover.appendChild(icon(CATS[cat].icon.slice(3)));
      }
      const info = el('span', 'diary-info');
      info.append(
        el('span', 'diary-name', d.name),
        el('span', 'diary-meta', days.length
          ? plural(photos, 'photo') + ' across ' + plural(days.length, 'day') + '. Last: ' + formatDate(days[0].date)
          : 'No photos yet')
      );
      card.append(cover, info, icon('next'));
      card.addEventListener('click', () => openDiary(d));
      box.appendChild(card);
    });
    cleanupThumbs(covers);
  }

  async function addDiary() {
    const cat = settings.category;
    const c = CATS[cat];
    const n = diariesIn(cat).length;
    const suggested = n === 0 ? c.defaultName : '';
    const name = await askText({ title: 'Name your new ' + c.word, value: suggested, placeholder: c.defaultName, ok: 'Create' });
    if (name === null) return;
    const d = {
      id: uid(),
      category: cat,
      name: name.trim().slice(0, 40) || (c.word.charAt(0).toUpperCase() + c.word.slice(1) + ' ' + (n + 1)),
      created: Date.now()
    };
    try { await DB.write({ putDiaries: [d] }); }
    catch (e) { toast('Couldn’t create the diary. Please try again.'); return; }
    diaries.push(d);
    openDiary(d);
  }

  // Screen 3: one diary
  async function openDiary(d) {
    diary = d;
    settings.category = d.category;
    settings.diaryId = d.id;
    saveSettings();
    document.body.dataset.theme = d.category;
    const c = CATS[d.category];
    $('titleIcon').setAttribute('href', c.icon);
    $('emptyIcon').setAttribute('href', c.icon);
    $('entryNote').placeholder = c.note;
    $('diaryTitle').textContent = d.name;
    showScreen('diaryScreen');
    setThemeColor();
    await refresh();
  }

  async function refresh() {
    try {
      entries = (await DB.getEntries()).filter(e => e.diaryId === diary.id);
    } catch (e) {
      entries = [];
      toast('Storage is blocked in this browser, so photos can’t be saved.', 5000);
    }
    renderTimeline();
  }

  async function renameDiary() {
    const c = CATS[diary.category];
    const name = await askText({ title: 'Rename your ' + c.word, value: diary.name, ok: 'Save' });
    if (name === null || !name.trim()) return;
    const updated = Object.assign({}, diary, { name: name.trim().slice(0, 40) });
    try { await DB.write({ putDiaries: [updated] }); }
    catch (e) { toast('Couldn’t rename. Please try again.'); return; }
    Object.assign(diary, updated);
    $('diaryTitle').textContent = diary.name;
  }

  async function deleteDiary() {
    const photoIds = [];
    entries.forEach(e => photoIds.push(...e.photoIds));
    const what = photoIds.length ? ' and all ' + plural(photoIds.length, 'photo') : '';
    if (!(await askConfirm({ title: 'Delete “' + diary.name + '”?', text: 'This deletes the diary' + what + '. It can’t be undone.', ok: 'Delete', danger: true }))) return;
    try {
      await DB.write({ deleteDiaryIds: [diary.id], deleteEntryIds: entries.map(e => e.id), deletePhotoIds: photoIds });
    } catch (e) {
      toast('Couldn’t delete. Please try again.');
      return;
    }
    const name = diary.name;
    await showList(diary.category);
    toast('Deleted ' + name);
  }

  // Older versions had one diary per category. Move those days into a named diary.
  async function migrateOldData() {
    let all;
    try { all = await DB.getEntries(); } catch (e) { return; }
    const old = all.filter(e => !e.diaryId);
    if (!old.length) return;

    const change = { putDiaries: [], putEntries: [], deleteEntryIds: [] };
    ['plant', 'animal'].forEach(cat => {
      const days = old.filter(e => e.category === cat);
      if (!days.length) return;
      const d = { id: uid(), category: cat, name: settings.names[cat] || CATS[cat].defaultName, created: Date.now() };
      change.putDiaries.push(d);
      days.forEach(e => {
        change.deleteEntryIds.push(e.id);
        change.putEntries.push(Object.assign({}, e, { id: entryId(d.id, e.date), diaryId: d.id }));
      });
    });
    try { await DB.write(change); } catch (e) { /* try again next time */ }
  }

  // ===== Timeline =====
  function renderTimeline() {
    const tl = $('timeline');
    tl.textContent = '';

    const sorted = entries.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const firstDate = sorted.length ? sorted[0].date : null;
    if (settings.newestFirst) sorted.reverse();

    const photoCount = entries.reduce((n, e) => n + e.photoIds.length, 0);
    $('summary').textContent = entries.length
      ? plural(photoCount, 'photo') + ' across ' + plural(entries.length, 'day')
      : '';
    $('emptyState').hidden = entries.length > 0;
    $('sortBtn').hidden = entries.length < 2;
    $('sortLabel').textContent = settings.newestFirst ? 'Newest' : 'Oldest';
    $('sortBtn').setAttribute('aria-label', settings.newestFirst ? 'Showing newest first. Tap for oldest first.' : 'Showing oldest first. Tap for newest first.');

    $('deleteDiaryBtn').hidden = false;
    sorted.forEach(entry => tl.appendChild(dayCard(entry, daysBetween(firstDate, entry.date) + 1)));
    cleanupThumbs(entries.flatMap(e => e.photoIds));
  }

  function dayCard(entry, dayNum) {
    const card = el('article', 'day');

    const head = el('div', 'day-head');
    const titles = el('div');
    titles.append(el('span', 'day-badge', 'Day ' + dayNum), el('h3', 'day-date', formatDate(entry.date)));
    const edit = el('button', 'icon-btn day-edit');
    edit.type = 'button';
    edit.setAttribute('aria-label', 'Edit ' + formatDate(entry.date));
    edit.appendChild(icon('edit'));
    edit.addEventListener('click', () => openSheet('edit', entry));
    head.append(titles, edit);

    const album = el('div', 'album n' + entry.photoIds.length);
    entry.photoIds.forEach((pid, i) => {
      const btn = el('button', 'ph');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Open photo ' + (i + 1) + ' of ' + entry.photoIds.length);
      const img = el('img');
      img.alt = '';
      img.decoding = 'async';
      btn.appendChild(img);
      thumbUrl(pid).then(u => { if (u) img.src = u; });
      btn.addEventListener('click', () => openViewer(entry, i, dayNum));
      album.appendChild(btn);
    });

    card.append(head, album);
    if (entry.note) card.appendChild(el('p', 'day-note', entry.note));
    return card;
  }

  function thumbUrl(pid) {
    if (!thumbCache.has(pid)) {
      thumbCache.set(pid, DB.getPhoto(pid)
        .then(rec => (rec ? URL.createObjectURL(rec.thumb) : null))
        .catch(() => null));
    }
    return thumbCache.get(pid);
  }

  // Free memory for photos no longer shown
  function cleanupThumbs(shownIds) {
    const live = new Set(shownIds);
    thumbCache.forEach((p, id) => {
      if (!live.has(id)) {
        thumbCache.delete(id);
        p.then(u => u && URL.revokeObjectURL(u));
      }
    });
  }

  // ===== Picking photos =====
  function openPicker(target) {
    pickTarget = target;
    $('pickSheet').hidden = false;
    lockScroll(true);
  }
  function closePicker() {
    $('pickSheet').hidden = true;
    if (!sheet) lockScroll(false);
  }

  async function handleFiles(input) {
    let files = Array.from(input.files || []);
    input.value = ''; // lets the same photo be picked again later
    if (!files.length) return;

    let room = MAX_PHOTOS;
    if (pickTarget === 'sheet' && sheet) room = MAX_PHOTOS - sheetPhotos().length;
    let skipped = 0;
    if (files.length > room) {
      skipped = files.length - room;
      files = files.slice(0, Math.max(0, room));
    }
    if (!files.length) { toast('This date already has 3 photos.'); return; }

    toast(files.length > 1 ? 'Compressing ' + files.length + ' photos…' : 'Compressing photo…', 60000);

    const added = [];
    let before = 0, after = 0, failed = 0;
    for (const file of files) {
      try {
        const r = await Photo.compress(file);
        added.push({ id: uid(), full: r.full, thumb: r.thumb, url: URL.createObjectURL(r.thumb) });
        before += file.size;
        after += r.full.size + r.thumb.size;
      } catch (e) {
        failed++;
      }
    }

    if (!added.length) {
      toast('That photo couldn’t be opened. Try a JPG or PNG.', 4000);
      return;
    }

    if (pickTarget === 'sheet' && sheet) {
      sheet.added.push(...added);
      renderSheet();
    } else {
      openSheet('add', null, added);
    }

    let msg = 'Compressed ' + formatSize(before) + ' to ' + formatSize(after);
    if (skipped) msg = 'Only 3 photos per date, so ' + plural(skipped, 'photo') + ' skipped';
    if (failed) msg = plural(failed, 'photo') + ' couldn’t be opened';
    toast(msg);
  }

  // ===== Add / edit sheet =====
  // The sheet always edits "the day for the chosen date".
  // Add mode: if that date already has photos, new ones join them.
  // Edit mode: changing the date moves the whole day.
  function openSheet(mode, entry, added) {
    sheet = {
      mode,
      base: mode === 'edit' ? entry : null,
      added: added || [],
      removed: new Set(),
      noteTouched: false,
      saved: false
    };
    $('entryTitle').textContent = mode === 'edit' ? 'Edit day' : 'New photos';
    $('entryDate').max = todayStr();
    $('entryDate').value = mode === 'edit' ? entry.date : todayStr();
    $('entryNote').value = mode === 'edit' ? (entry.note || '') : '';
    $('entryDelete').hidden = mode !== 'edit';
    if (mode === 'add') syncAddTarget();
    $('entrySheet').hidden = false;
    lockScroll(true);
    renderSheet();
  }

  // Add mode: find the existing day for the chosen date, if any
  function syncAddTarget() {
    const date = $('entryDate').value;
    const existing = entries.find(e => e.date === date) || null;
    if (existing !== sheet.base) {
      sheet.base = existing;
      sheet.removed.clear();
      if (!sheet.noteTouched) $('entryNote').value = existing ? (existing.note || '') : '';
    }
  }

  function keptExisting() {
    return sheet.base ? sheet.base.photoIds.filter(id => !sheet.removed.has(id)) : [];
  }
  function sheetPhotos() {
    return keptExisting().map(id => ({ id, existing: true }))
      .concat(sheet.added.map(p => ({ id: p.id, url: p.url })));
  }

  function renderSheet() {
    const photos = sheetPhotos();
    const box = $('slots');
    box.textContent = '';

    photos.forEach((p, i) => {
      const slot = el('div', 'slot' + (i >= MAX_PHOTOS ? ' over' : ''));
      const img = el('img');
      img.alt = '';
      if (p.url) img.src = p.url;
      else thumbUrl(p.id).then(u => { if (u) img.src = u; });
      const rm = el('button', 'slot-remove');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Remove photo ' + (i + 1));
      rm.appendChild(icon('close', 'icon-sm'));
      rm.addEventListener('click', () => removeSheetPhoto(p));
      slot.append(img, rm);
      box.appendChild(slot);
    });

    if (photos.length < MAX_PHOTOS) {
      const add = el('button', 'slot-add');
      add.type = 'button';
      add.append(icon('plus'), el('span', null, 'Add'));
      add.addEventListener('click', () => openPicker('sheet'));
      box.appendChild(add);
    }

    $('slotCount').textContent = photos.length + ' of ' + MAX_PHOTOS;
    validateSheet(photos.length);
  }

  function removeSheetPhoto(p) {
    if (p.existing) {
      sheet.removed.add(p.id);
    } else {
      const i = sheet.added.findIndex(a => a.id === p.id);
      if (i !== -1) { URL.revokeObjectURL(sheet.added[i].url); sheet.added.splice(i, 1); }
    }
    renderSheet();
  }

  function validateSheet(total) {
    const date = $('entryDate').value;
    let error = '';
    let hint = '';

    const otherDay = sheet.mode === 'edit'
      ? entries.find(e => e.date === date && e.id !== sheet.base.id)
      : null;

    if (!date) error = 'Pick a date.';
    else if (date > todayStr()) error = 'The date can’t be in the future.';
    else if (otherDay) error = 'That date already has its own entry. Pick another date.';
    else if (total > MAX_PHOTOS) {
      error = 'Only 3 photos per date. Remove ' + plural(total - MAX_PHOTOS, 'photo') +
        (sheet.mode === 'add' ? ' or pick another date.' : '.');
    } else if (total === 0) {
      error = sheet.mode === 'edit' ? 'Add at least one photo, or delete this day.' : 'Add at least one photo.';
    }

    if (sheet.mode === 'add' && sheet.base && !error) {
      hint = 'This date already has ' + plural(sheet.base.photoIds.length, 'photo') + '. New photos will join them.';
    } else if (sheet.mode === 'add' && !sheet.base) {
      hint = 'Set to the day you added the photo. Tap the date to change it.';
    }

    $('entryError').textContent = error;
    $('dateHint').textContent = hint;
    $('entrySave').disabled = !!error;
  }

  async function saveSheet(e) {
    e.preventDefault();
    if ($('entrySave').disabled) return;

    const date = $('entryDate').value;
    const id = entryId(diary.id, date);
    const entry = {
      id,
      diaryId: diary.id,
      category: diary.category,
      date,
      note: $('entryNote').value.trim(),
      photoIds: keptExisting().concat(sheet.added.map(p => p.id)),
      updated: Date.now()
    };
    const change = {
      putEntries: [entry],
      putPhotos: sheet.added.map(p => ({ id: p.id, full: p.full, thumb: p.thumb })),
      deletePhotoIds: Array.from(sheet.removed)
    };
    if (sheet.mode === 'edit' && sheet.base.id !== id) change.deleteEntryIds = [sheet.base.id];

    $('entrySave').disabled = true;
    try {
      await DB.write(change);
    } catch (err) {
      $('entrySave').disabled = false;
      toast('Couldn’t save. Your phone may be low on storage.', 4000);
      return;
    }

    // keep the new thumbnails' URLs for the timeline
    sheet.added.forEach(p => thumbCache.set(p.id, Promise.resolve(p.url)));
    const wasEdit = sheet.mode === 'edit';
    sheet.saved = true;
    closeSheet(true);
    askPersistentStorage();
    await refresh();
    toast(wasEdit ? 'Changes saved' : 'Saved to ' + formatDate(date));
  }

  async function closeSheet(force) {
    if (!sheet) return;
    if (!force && !sheet.saved && sheet.added.length &&
        !(await askConfirm({ title: 'Discard ' + plural(sheet.added.length, 'new photo') + '?', text: 'They haven’t been saved yet.', ok: 'Discard', danger: true }))) return;
    if (!sheet) return;
    if (!sheet.saved) sheet.added.forEach(p => URL.revokeObjectURL(p.url));
    sheet = null;
    $('entrySheet').hidden = true;
    lockScroll(false);
  }

  async function deleteDay() {
    const base = sheet.base;
    if (!(await askConfirm({ title: 'Delete ' + formatDate(base.date) + '?', text: 'This deletes the day and its photos. It can’t be undone.', ok: 'Delete', danger: true }))) return;
    try {
      await DB.write({ deleteEntryIds: [base.id], deletePhotoIds: base.photoIds });
    } catch (e) {
      toast('Couldn’t delete. Please try again.');
      return;
    }
    closeSheet(true);
    await refresh();
    toast('Day deleted');
  }

  // Ask the browser not to clear the diary when space runs low
  let persistAsked = false;
  function askPersistentStorage() {
    if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }

  // ===== Viewer =====
  async function openViewer(entry, index, dayNum) {
    viewer = { entry, index, dayNum, url: null };
    $('viewer').hidden = false;
    lockScroll(true);
    $('viewerNote').textContent = entry.note || '';
    await showViewerPhoto();
  }

  async function showViewerPhoto() {
    if (!viewer) return;
    const { entry, index } = viewer;
    $('viewerDate').textContent = 'Day ' + viewer.dayNum + ', ' + formatDate(entry.date);
    $('viewerCount').textContent = entry.photoIds.length > 1 ? (index + 1) + ' / ' + entry.photoIds.length : '';
    $('viewerPrev').hidden = index === 0;
    $('viewerNext').hidden = index === entry.photoIds.length - 1;

    const rec = await DB.getPhoto(entry.photoIds[index]).catch(() => null);
    if (!viewer || viewer.index !== index) return; // user moved on
    if (viewer.url) URL.revokeObjectURL(viewer.url);
    viewer.url = rec ? URL.createObjectURL(rec.full) : null;
    $('viewerImg').src = viewer.url || '';
  }

  function stepViewer(dir) {
    if (!viewer) return;
    const next = viewer.index + dir;
    if (next < 0 || next >= viewer.entry.photoIds.length) return;
    viewer.index = next;
    showViewerPhoto();
  }

  function closeViewer() {
    if (!viewer) return;
    if (viewer.url) URL.revokeObjectURL(viewer.url);
    viewer = null;
    $('viewerImg').removeAttribute('src');
    $('viewer').hidden = true;
    lockScroll(false);
  }

  // ===== Events =====
  document.querySelectorAll('.choice').forEach(btn => {
    btn.addEventListener('click', () => showList(btn.dataset.cat));
  });
  $('listBack').addEventListener('click', showChoose);
  $('newDiaryBtn').addEventListener('click', addDiary);
  $('switchBtn').addEventListener('click', () => showList(diary.category));
  $('titleBtn').addEventListener('click', renameDiary);
  $('deleteDiaryBtn').addEventListener('click', deleteDiary);

  $('sortBtn').addEventListener('click', () => {
    settings.newestFirst = !settings.newestFirst;
    saveSettings();
    renderTimeline();
  });

  $('addBtn').addEventListener('click', () => openPicker('new'));
  $('pickCamera').addEventListener('click', () => { closePicker(); $('cameraInput').click(); });
  $('pickGallery').addEventListener('click', () => { closePicker(); $('galleryInput').click(); });
  $('pickCancel').addEventListener('click', closePicker);
  $('pickSheet').addEventListener('click', e => { if (e.target === $('pickSheet')) closePicker(); });
  $('cameraInput').addEventListener('change', e => handleFiles(e.target));
  $('galleryInput').addEventListener('change', e => handleFiles(e.target));

  $('entryForm').addEventListener('submit', saveSheet);
  $('entryClose').addEventListener('click', () => closeSheet(false));
  $('entrySheet').addEventListener('click', e => { if (e.target === $('entrySheet')) closeSheet(false); });
  $('entryDelete').addEventListener('click', deleteDay);
  $('entryNote').addEventListener('input', () => { if (sheet) sheet.noteTouched = true; });
  $('entryDate').addEventListener('change', () => {
    if (!sheet) return;
    if (sheet.mode === 'add') syncAddTarget();
    renderSheet();
  });

  $('viewerClose').addEventListener('click', closeViewer);
  $('viewerPrev').addEventListener('click', () => stepViewer(-1));
  $('viewerNext').addEventListener('click', () => stepViewer(1));
  let touchX = null;
  $('viewer').addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
  $('viewer').addEventListener('touchend', e => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) stepViewer(dx < 0 ? 1 : -1);
  });

  document.addEventListener('keydown', e => {
    if (viewer) {
      if (e.key === 'Escape') closeViewer();
      if (e.key === 'ArrowLeft') stepViewer(-1);
      if (e.key === 'ArrowRight') stepViewer(1);
    } else if (e.key === 'Escape') {
      if (!$('pickSheet').hidden) closePicker();
      else if (sheet) closeSheet(false);
    }
  });

  // ===== Start: reopen where the user left off =====
  (async function start() {
    await migrateOldData();
    await loadDiaries();
    const last = diaries.find(d => d.id === settings.diaryId);
    if (last) openDiary(last);
    else if (CATS[settings.category]) showList(settings.category);
    else showChoose();
  })();

  // Offline support (works on https:// or localhost)
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
