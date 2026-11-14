'use strict';
(function () {
  const $ = (s) => document.querySelector(s);

  /* ===== 常數 ===== */
  const ID_W_CM = 8.56, ID_H_CM = 5.4;                 // 政府規定尺寸
  const ID_RATIO = ID_W_CM / ID_H_CM;
  const CARD_RATIO_LAND = 9 / 5.4;                     // 橫式名片 9×5.4 cm（取景框比例）
  const ID_RATIO_PORT = ID_H_CM / ID_W_CM;            // 證件直放
  const CARD_RATIO_PORT = 5.4 / 9;                     // 直式名片
  const ID_PX = { w: Math.round(ID_W_CM / 2.54 * 300), h: Math.round(ID_H_CM / 2.54 * 300) }; // 300 dpi → 1011×638
  const SLOTS = [
    { key: 'front', label: '身分證正面', ocr: true },
    { key: 'back', label: '身分證反面', ocr: false },
    { key: 'nhi', label: '健保卡正面', ocr: true }
  ];
  const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const APP_VERSION = 'v3.5';
  const FIX_KEY = 'idshot.fixes.v1', ORI_KEY = 'idshot.orient.v2', CONFIRM_KEY = 'idshot.confirm.v1', STAMP_KEY = 'idshot.stamp.v1';
  const KAI_CSS = 'https://cdn.jsdelivr.net/npm/lxgw-wenkai-tc-webfont@1.0.0/style.css';
  const KAI_STACK = '"LXGW WenKai TC","Kaiti TC","BiauKai","DFKai-SB","KaiTi","標楷體",serif';
  // 身分證／健保卡只先辨識姓名所在的區域（比例），讀不到才退回整張
  const ROI = { front: { x0: 0.22, y0: 0.10, x1: 1, y1: 0.62 }, nhi: { x0: 0.04, y0: 0.26, x1: 0.96, y1: 0.74 } };

  /* ===== 狀態 ===== */
  const S = {
    mode: 'card', orient: { card: 'port', id: 'port' }, pending: null,
    stream: null, camOn: false, wantCam: true, devices: [], facing: 'environment',
    worker: null, queue: Promise.resolve(),
    card: { blob: null, url: null, nameEdited: false, coEdited: false, fileEdited: false, raw: { names: [], companies: [] }, job: 0, sel: { name: [], company: [] }, target: 'name', pool: [] },
    id: {
      slots: {}, step: 'front', nameEdited: false, sel: [],
      raw: { front: [], nhi: [] }, cands: { front: [], nhi: [] }, lines: { front: [], nhi: [] },
      state: { front: '', nhi: '' }, job: { front: 0, nhi: 0 }
    }
  };

  /* ===== 記住修正（只存在這支手機的 localStorage） ===== */
  const Fix = {
    data: { name: {}, company: {} },
    load() {
      try {
        const s = localStorage.getItem(FIX_KEY);
        if (s) { const o = JSON.parse(s); this.data = { name: o.name || {}, company: o.company || {} }; }
      } catch (_) { /* 無法讀取就當作沒有 */ }
    },
    save() { try { localStorage.setItem(FIX_KEY, JSON.stringify(this.data)); } catch (_) { /* 忽略 */ } },
    // 已學過的修正排在最前面，其餘維持原順序
    apply(kind, list) {
      const m = this.data[kind], out = [];
      list.forEach((x) => { const f = Object.prototype.hasOwnProperty.call(m, x) ? m[x] : null; if (f && out.indexOf(f) < 0) out.push(f); });
      list.forEach((x) => { if (out.indexOf(x) < 0) out.push(x); });
      return out;
    },
    set(kind, from, to) { this.data[kind][from] = to; },
    del(kind, from) { delete this.data[kind][from]; },
    count() { return Object.keys(this.data.name).length + Object.keys(this.data.company).length; },
    clear() { this.data = { name: {}, company: {} }; this.save(); }
  };
  Fix.load();

  function similarName(a, b) {                        // 同字數、至少有一字相同、又不完全一樣
    if (!a || !b || a.length !== b.length || a === b) return false;
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
    return same >= 1;
  }
  function learnName(raws, finalName) {
    const f = String(finalName || '').trim();
    if (!/^[一-鿿·]{2,10}$/.test(f)) return;
    raws.slice(0, 2).forEach((r) => {
      if (!r) return;
      if (r === f) Fix.del('name', r);
      else if (similarName(r, f)) Fix.set('name', r, f);
    });
  }
  function learnCompany(raws, finalCo) {
    const f = String(finalCo || '').trim(), r = raws[0];
    if (!r || !f) return;
    if (r === f) Fix.del('company', r); else Fix.set('company', r, f);
  }
  function updateFixNote() {
    const n = Fix.count();
    $('#fixCount').textContent = n ? '已記住 ' + n + ' 筆修正（辨識錯誤時會自動改成你更正過的字）' : '尚未記住任何修正（你改過姓名或公司並儲存後，就會記住）';
    $('#btnFixClear').hidden = !n;
  }

  /* ===== 小工具 ===== */
  function sanitize(s) {
    return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  }
  async function share(blob, filename) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch (_) { /* 使用者取消 */ }
    }
  }
  const canShareFiles = !!(navigator.canShare && (() => {
    try { return navigator.canShare({ files: [new File([''], 'a.txt', { type: 'text/plain' })] }); } catch (_) { return false; }
  })());
  function renderChips(el, arr, onPick) {
    el.innerHTML = '';
    arr.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.textContent = t;
      b.onclick = () => onPick(t);
      el.appendChild(b);
    });
  }
  // 點選用的 OCR 文字池：已選中的會反白，可連續點選
  function renderPool(box, list, pool, isSel, onTap) {
    list.innerHTML = '';
    box.hidden = !pool.length;
    pool.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip' + (isSel(t) ? ' sel' : ''); b.textContent = t;
      b.onclick = () => onTap(t);
      list.appendChild(b);
    });
  }
  function joinParts(arr) {                            // 中文字之間不加空白，其餘以空白連接
    return arr.reduce((acc, p) => {
      if (!acc) return p;
      return (/[\u4e00-\u9fff]$/.test(acc) && /^[\u4e00-\u9fff]/.test(p)) ? acc + p : acc + ' ' + p;
    }, '');
  }
  function setStat(sel, text, warn) {
    const el = $(sel); el.textContent = text; el.classList.toggle('warn', !!warn);
  }
  function showBanner(t) { const b = $('#banner'); b.hidden = !t; b.textContent = t || ''; }
  const curRatio = () => (S.mode === 'id' ? (S.orient.id === 'port' ? ID_RATIO_PORT : ID_RATIO) : (S.orient.card === 'port' ? CARD_RATIO_PORT : CARD_RATIO_LAND));

  /* ===== 相機 ===== */
  function guideRect(vw, vh, r) {
    const gw = Math.min(vw * 0.92, vh * 0.92 * r), gh = gw / r;
    return { x: (vw - gw) / 2, y: (vh - gh) / 2, w: gw, h: gh };
  }
  function fitRatio(bw, bh, r) {
    return bw / bh > r ? { x: (bw - bh * r) / 2, y: 0, w: bh * r, h: bh } : { x: 0, y: (bh - bw / r) / 2, w: bw, h: bw / r };
  }
  function layoutStage() {
    const vid = $('#video'), stage = $('#stage');
    const vw = vid.videoWidth || 16, vh = vid.videoHeight || 9;
    const maxW = stage.parentElement.clientWidth, maxH = Math.max(220, window.innerHeight * 0.5);
    let w = maxW, h = w * vh / vw;
    if (h > maxH) { h = maxH; w = h * vw / vh; }
    stage.style.width = w + 'px'; stage.style.height = h + 'px';
    const g = guideRect(vw, vh, curRatio()), gd = $('#guide');
    gd.style.left = (g.x / vw * 100) + '%'; gd.style.top = (g.y / vh * 100) + '%';
    gd.style.width = (g.w / vw * 100) + '%'; gd.style.height = (g.h / vh * 100) + '%';
  }
  function updateHint() {
    let t;
    if (S.mode === 'card') t = '把' + (S.orient.card === 'port' ? '直式' : '橫式') + '名片放進框內，再按拍照';
    else {
      const s = SLOTS.find((x) => x.key === S.id.step);
      t = s ? '請拍：' + s.label + (S.orient.id === 'port' ? '（證件直放，拍完自動轉橫）' : '（證件對齊框內）') : '';
    }
    $('#hint').textContent = t;
  }
  function camError(e) {
    const n = e && e.name;
    let m = '無法開啟相機。';
    if (!window.isSecureContext) m = '此網頁不是 HTTPS，瀏覽器不允許使用相機。';
    else if (n === 'NotAllowedError' || n === 'SecurityError') m = '相機權限被拒絕，請到瀏覽器／系統設定允許相機。';
    else if (n === 'NotFoundError' || n === 'OverconstrainedError') m = '找不到可用的相機。';
    else if (n === 'NotReadableError') m = '相機被其他程式占用。';
    const el = $('#camErr'); el.hidden = false;
    el.textContent = m + ' 你仍可用下方「系統相機」或「相簿」。';
  }
  async function startCam(deviceId) {
    stopCam();
    $('#camErr').hidden = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camError({}); return; }
    const size = { width: { ideal: 3840 }, height: { ideal: 2160 } };
    const video = deviceId ? Object.assign({ deviceId: { exact: deviceId } }, size) : Object.assign({ facingMode: { ideal: S.facing } }, size);
    try {
      try { S.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video }); }
      catch (e) { S.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true }); }
    } catch (e) { camError(e); return; }
    if (!S.wantCam) { stopCam(); return; }
    const vid = $('#video');
    vid.srcObject = S.stream;
    try { await vid.play(); } catch (_) { /* 忽略 */ }
    if (!vid.videoWidth) await new Promise((r) => { vid.onloadedmetadata = r; setTimeout(r, 1500); });
    S.camOn = true; layoutStage();
    try { S.devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch (_) { /* 忽略 */ }
  }
  function stopCam() {
    if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
    S.stream = null; S.camOn = false;
    const vid = $('#video'); vid.srcObject = null;
  }
  function setCam(on) {
    S.wantCam = on;
    $('#camSec').hidden = !on;
    if (on) { updateHint(); if (!S.stream) startCam(); else layoutStage(); }
    else stopCam();
  }
  function switchCam() {
    if (!S.stream || S.devices.length < 2) return;
    const cur = S.stream.getVideoTracks()[0].getSettings().deviceId;
    const i = S.devices.findIndex((d) => d.deviceId === cur);
    startCam(S.devices[(i + 1) % S.devices.length].deviceId);
  }
  function updateOrientUi() {
    const id = S.mode === 'id', o = S.orient[S.mode];
    const port = o === 'port';
    $('#btnOrient').textContent = (id ? (port ? '取景框：證件直放（拍完自動轉橫）' : '取景框：證件橫放') : (port ? '取景框：直式名片' : '取景框：橫式名片'))
      + '　⟲ 點一下改' + (port ? '橫式' : '直式');
    updateHint();
    if (S.camOn) layoutStage();
  }
  function setOrient(o, persist) {
    S.orient[S.mode] = o === 'port' ? 'port' : 'land';
    if (persist) { try { localStorage.setItem(ORI_KEY + '.' + S.mode, S.orient[S.mode]); } catch (_) { /* 忽略 */ } }
    updateOrientUi();
  }

  /* ===== 擷取 ===== */
  function shoot() {
    const vid = $('#video');
    if (!S.camOn || !vid.videoWidth) return;
    const vw = vid.videoWidth, vh = vid.videoHeight;
    const crop = S.mode === 'id' || $('#chkCrop').checked;
    handleSource(vid, crop ? guideRect(vw, vh, curRatio()) : { x: 0, y: 0, w: vw, h: vh });
    if (navigator.vibrate) navigator.vibrate(30);
  }
  async function onFile(file) {
    if (!file) return;
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (_) {
      bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); });
    }
    const bw = bmp.width || bmp.naturalWidth, bh = bmp.height || bmp.naturalHeight;
    const crop = S.mode === 'id' || $('#chkCrop').checked;
    handleSource(bmp, crop ? fitRatio(bw, bh, curRatio()) : { x: 0, y: 0, w: bw, h: bh });
  }
  function handleSource(src, r) {
    const c = document.createElement('canvas');
    if (S.mode === 'id') { const pt = S.orient.id === 'port'; c.width = pt ? ID_PX.h : ID_PX.w; c.height = pt ? ID_PX.w : ID_PX.h; }
    else { const k = Math.min(1, 2400 / Math.max(r.w, r.h)); c.width = Math.round(r.w * k); c.height = Math.round(r.h * k); }
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    afterCapture(c);
  }

  /* ===== OCR ===== */
  function loadScript(url) {
    return new Promise((res, rej) => {
      if (window.Tesseract) return res();
      const s = document.createElement('script');
      s.src = url; s.onload = res; s.onerror = () => rej(new Error('無法載入辨識引擎（請確認網路）'));
      document.head.appendChild(s);
    });
  }
  const STATUS_ZH = {
    'loading tesseract core': '下載辨識引擎', 'initializing tesseract': '初始化',
    'loading language traineddata': '下載中文語言包', 'initializing api': '初始化', 'recognizing text': '辨識中'
  };
  async function getWorker() {
    if (S.worker) return S.worker;
    showBanner('載入辨識引擎…（首次需下載，請保持連網）');
    try {
      await loadScript(TESS_URL);
      const w = await Tesseract.createWorker('chi_tra+eng', 1, {
        logger: (m) => {
          if (!m || !m.status) return;
          const zh = STATUS_ZH[m.status] || m.status;
          showBanner(zh + (typeof m.progress === 'number' ? ' ' + Math.round(m.progress * 100) + '%' : ''));
        }
      });
      await w.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
      S.worker = w;
      return w;
    } catch (e) { showBanner(''); throw e; }
  }
  function prepForOcr(src, targetW) {
    const sc = targetW / src.width, w = Math.round(src.width * sc), h = Math.round(src.height * sc);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, w, h);
    const im = x.getImageData(0, 0, w, h), d = im.data, hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
      d[i] = d[i + 1] = d[i + 2] = g; hist[g]++;
    }
    const tot = w * h; let acc = 0, lo = 0, hi = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= tot * 0.02) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= tot * 0.02) { hi = i; break; } }
    if (hi - lo > 20) {
      const k = 255 / (hi - lo);
      for (let i = 0; i < d.length; i += 4) {
        let v = (d[i] - lo) * k; v = v < 0 ? 0 : v > 255 ? 255 : v;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    x.putImageData(im, 0, 0);
    return c;
  }
  function ocrLines(canvas) {
    const run = async () => {
      const w = await getWorker();
      const { data } = await w.recognize(canvas);
      showBanner('');
      return Parse.normalizeLines(data);
    };
    const p = S.queue.then(run, run);
    S.queue = p.catch(() => {});
    return p;
  }
  // 二次辨識：只裁出姓名那一行、放大成約 96px 高、當成單行文字再辨識一次
  function cropLine(src, line) {
    if (!line || !(line.x1 > line.x0) || !(line.y1 > line.y0)) return null;
    const h = Math.max(line.y1 - line.y0, 8), px = h * 0.4, py = h * 0.45;
    const x0 = Math.max(0, line.x0 - px), y0 = Math.max(0, line.y0 - py);
    const x1 = Math.min(src.width, line.x1 + px), y1 = Math.min(src.height, line.y1 + py);
    const w = x1 - x0, hh = y1 - y0;
    if (w < 4 || hh < 4) return null;
    const k = Math.min(4, Math.max(0.6, 96 / h)), pad = 24;
    const c = document.createElement('canvas');
    c.width = Math.round(w * k) + pad * 2; c.height = Math.round(hh * k) + pad * 2;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(src, x0, y0, w, hh, pad, pad, Math.round(w * k), Math.round(hh * k));
    return c;
  }
  function cropRoi(src, r) {
    const w = src.width, h = src.height, sw = Math.round((r.x1 - r.x0) * w), sh = Math.round((r.y1 - r.y0) * h);
    const c = document.createElement('canvas'); c.width = sw; c.height = sh;
    c.getContext('2d').drawImage(src, Math.round(r.x0 * w), Math.round(r.y0 * h), sw, sh, 0, 0, sw, sh);
    return c;
  }
  function ocrSingle(canvas) {
    const run = async () => {
      const w = await getWorker();
      await w.setParameters({ tessedit_pageseg_mode: '7' });
      try {
        const { data } = await w.recognize(canvas);
        return (data && data.text) || '';
      } finally {
        await w.setParameters({ tessedit_pageseg_mode: '11' });
        showBanner('');
      }
    };
    const p = S.queue.then(run, run);
    S.queue = p.catch(() => {});
    return p;
  }

  /* ===== 名片流程 ===== */
  function cardBase() {
    const n = sanitize($('#cardName').value), c = sanitize($('#cardCompany').value);
    return [n, c].filter(Boolean).join('_');         // 預設：姓名_公司名稱
  }
  function cardFilename() { return (sanitize($('#cardFile').value) || cardBase() || ('名片_' + stamp())) + '.jpg'; }
  function updateCardFn() {
    if (!S.card.fileEdited) $('#cardFile').value = cardBase();
    $('#cardFile').placeholder = '名片_' + stamp().slice(0, 8);
  }
  function renderCardPool() {
    const tg = S.card.target;
    document.querySelectorAll('#cardTarget button').forEach((b) => b.classList.toggle('on', b.dataset.t === tg));
    const mapped = (t) => (tg === 'company' ? Parse.companyFromLine(t) : t);
    renderPool($('#cardPoolBox'), $('#cardPool'), S.card.pool, (t) => S.card.sel[tg].indexOf(mapped(t)) >= 0, toggleCardPiece);
  }
  function toggleCardPiece(t) {
    const tg = S.card.target, piece = tg === 'company' ? Parse.companyFromLine(t) : t;
    const arr = S.card.sel[tg], i = arr.indexOf(piece);
    if (i >= 0) arr.splice(i, 1); else arr.push(piece);
    if (tg === 'name') { $('#cardName').value = joinParts(arr); S.card.nameEdited = true; }
    else { $('#cardCompany').value = joinParts(arr); S.card.coEdited = true; }
    updateCardFn(); renderCardPool();
  }
  function setCardName(t) { $('#cardName').value = t; S.card.nameEdited = true; S.card.sel.name = []; updateCardFn(); renderCardPool(); }
  function setCardCo(t) { $('#cardCompany').value = t; S.card.coEdited = true; S.card.sel.company = []; updateCardFn(); renderCardPool(); }
  function applyCardCands() {
    const nm = Fix.apply('name', S.card.raw.names), co = Fix.apply('company', S.card.raw.companies);
    if (!S.card.nameEdited && nm[0]) $('#cardName').value = nm[0];
    if (!S.card.coEdited && co[0]) $('#cardCompany').value = co[0];
    renderChips($('#cardChips'), nm, setCardName);
    renderChips($('#cardCoChips'), co, setCardCo);
    updateCardFn();
    return nm.length || co.length;
  }
  function recordCardFix() {
    learnName(S.card.raw.names, $('#cardName').value);
    learnCompany(S.card.raw.companies, $('#cardCompany').value);
    Fix.save(); updateFixNote();
  }
  function onCardShot(canvas) {
    canvas.toBlob((blob) => {
      if (S.card.url) URL.revokeObjectURL(S.card.url);
      S.card.blob = blob; S.card.url = URL.createObjectURL(blob);
      S.card.nameEdited = false; S.card.coEdited = false; S.card.fileEdited = false; S.card.raw = { names: [], companies: [] };
      S.card.sel = { name: [], company: [] }; S.card.pool = [];
      $('#cardImg').src = S.card.url;
      $('#cardName').value = ''; $('#cardCompany').value = '';
      renderChips($('#cardChips'), [], () => {}); renderChips($('#cardCoChips'), [], () => {});
      $('#cardFile').value = ''; renderCardPool();
      $('#cardPanel').hidden = false; setCam(false); updateCardFn();
      $('#cardPanel').scrollIntoView({ block: 'start' });
      runCardOcr(canvas);
    }, 'image/jpeg', 0.92);
  }
  async function runCardOcr(canvas) {
    const job = ++S.card.job;
    setStat('#cardStat', '辨識中…');
    try {
      const prep = prepForOcr(canvas, Math.min(2400, Math.max(1600, canvas.width)));
      const lines = await ocrLines(prep);
      if (job !== S.card.job) return;
      const r = Parse.parseCard(lines);
      S.card.raw = { names: r.names.slice(), companies: r.companies.slice() };
      S.card.pool = Parse.pool(r.allLines); renderCardPool();
      const ok = applyCardCands();
      const box = r.boxes[r.names[0]];
      setStat('#cardStat', ok ? '初步辨識完成' + (box ? '，姓名精修中…' : '。請確認姓名與公司。') : '沒有自動辨識到姓名／公司。請展開下方「辨識到的所有文字」點選，或手動輸入。', !ok);
      // 二次辨識姓名
      if (box) {
        let better = '';
        try { const cc = cropLine(prep, box); if (cc) better = Parse.extractName(await ocrSingle(cc)); } catch (_) { /* 精修失敗就沿用初步結果 */ }
        if (job !== S.card.job) return;
        if (better && better !== r.names[0]) {
          S.card.raw.names = [better].concat(r.names.filter((x) => x !== better));
          applyCardCands();
          setStat('#cardStat', '辨識完成（姓名經二次辨識，與初步結果不同，請核對；點下方選項可替換）');
        } else {
          setStat('#cardStat', '辨識完成，請確認姓名與公司（點下方選項可替換）');
        }
      }
    } catch (e) {
      if (job === S.card.job) setStat('#cardStat', 'OCR 失敗：' + e.message + '。可手動輸入。', true);
    }
  }
  function nextCard() {
    S.card.job++;
    $('#cardPanel').hidden = true;
    setCam(true);
    window.scrollTo(0, 0);
  }

  /* ===== 證件流程 ===== */
  function renderSlots() {
    const box = $('#slots'); box.innerHTML = '';
    SLOTS.forEach((s, i) => {
      const sl = S.id.slots[s.key];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot' + (S.id.step === s.key ? ' active' : '') + (sl ? ' done' : '');
      b.innerHTML = (sl ? '<img alt="">' : '<div class="ph">' + (i + 1) + '</div>') + '<span>' + s.label + '</span>';
      if (sl) b.querySelector('img').src = sl.url;
      b.onclick = () => { cancelReview(); S.id.step = s.key; renderSlots(); setCam(true); };
      box.appendChild(b);
    });
  }
  function onIdShot(canvas) {
    const key = S.id.step; if (!key) return;
    canvas.toBlob((blob) => {
      const old = S.id.slots[key]; if (old) URL.revokeObjectURL(old.url);
      S.id.slots[key] = { blob, url: URL.createObjectURL(blob) };
      const slot = SLOTS.find((s) => s.key === key);
      const next = SLOTS.find((s) => !S.id.slots[s.key]);
      S.id.step = next ? next.key : null;
      renderSlots();
      if (next) { setCam(true); } else { setCam(false); $('#idPanel').scrollIntoView({ block: 'start' }); }
      if (slot.ocr) runIdOcr(key, canvas); else updateIdUi();
    }, 'image/jpeg', 0.92);
  }
  async function runIdOcr(key, canvas) {
    const job = ++S.id.job[key];
    S.id.state[key] = '辨識中…'; S.id.cands[key] = []; S.id.raw[key] = []; S.id.lines[key] = []; updateIdUi();
    try {
      S.id.state[key] = '辨識姓名區域…'; updateIdUi();
      let prep = prepForOcr(cropRoi(canvas, ROI[key]), 1600);
      let lines = await ocrLines(prep);
      if (job !== S.id.job[key]) return;
      let res = Parse.parseIdName(lines);
      if (!res.names.length) {                         // 區域內沒讀到：退回掃描整張
        S.id.state[key] = '區域內沒讀到，改掃描整張…'; updateIdUi();
        prep = prepForOcr(canvas, 2000);
        lines = await ocrLines(prep);
        if (job !== S.id.job[key]) return;
        res = Parse.parseIdName(lines);
      }
      S.id.raw[key] = res.names.slice();
      S.id.lines[key] = Parse.allLines(lines);
      S.id.cands[key] = Fix.apply('name', S.id.raw[key]);
      const box = res.boxes[res.names[0]];
      S.id.state[key] = res.names.length ? (box ? '初步完成，姓名精修中…' : '完成') : '沒讀到姓名（可展開「辨識到的所有文字」點選）';
      updateIdUi();
      if (box) {
        let better = '';
        try { const cc = cropLine(prep, box); if (cc) better = Parse.extractName(await ocrSingle(cc)); } catch (_) { /* 沿用初步結果 */ }
        if (job !== S.id.job[key]) return;
        if (better && better !== res.names[0]) {
          S.id.raw[key] = [better].concat(res.names.filter((x) => x !== better));
          S.id.cands[key] = Fix.apply('name', S.id.raw[key]);
        }
        S.id.state[key] = '完成';
      }
    } catch (e) {
      if (job !== S.id.job[key]) return;
      S.id.state[key] = 'OCR 失敗（' + e.message + '）';
    }
    updateIdUi();
  }
  function mergedCands() {
    const out = [];
    S.id.cands.front.concat(S.id.cands.nhi).forEach((n) => { if (out.indexOf(n) < 0) out.push(n); });
    return out;
  }
  function mergedIdLines() {
    const out = [];
    S.id.lines.front.concat(S.id.lines.nhi).forEach((n) => { if (out.indexOf(n) < 0) out.push(n); });
    return out;
  }
  function toggleIdPiece(t) {
    const piece = Parse.extractName(t) || t, arr = S.id.sel, i = arr.indexOf(piece);
    if (i >= 0) arr.splice(i, 1); else arr.push(piece);
    $('#idName').value = joinParts(arr); S.id.nameEdited = true; updateIdUi();
  }
  function idBase() { return sanitize($('#idName').value) || (S.id.fb || (S.id.fb = '證件_' + stamp())); }
  function idFilename() { return idBase() + '.docx'; }
  const haveSlots = () => SLOTS.filter((s) => S.id.slots[s.key]);
  function updateIdUi() {
    const c = mergedCands();
    if (!S.id.nameEdited) $('#idName').value = S.id.cands.front[0] || S.id.cands.nhi[0] || '';
    renderChips($('#idChips'), c, (t) => { $('#idName').value = t; S.id.nameEdited = true; S.id.sel = []; updateIdUi(); });
    renderPool($('#idPoolBox'), $('#idPool'), Parse.pool(mergedIdLines()), (t) => S.id.sel.indexOf(Parse.extractName(t) || t) >= 0, toggleIdPiece);
    let st = '';
    if (S.id.state.front) st += '身分證正面：' + S.id.state.front + '\n';
    if (S.id.state.nhi) st += '健保卡正面：' + S.id.state.nhi + '\n';
    const f = S.id.cands.front[0], n = S.id.cands.nhi[0];
    const diff = f && n && f !== n;
    if (diff) st += '兩張證件辨識出的姓名不同，請核對。';
    setStat('#idStat', st.trim(), diff);
    const have = haveSlots(), nm = sanitize($('#idName').value);
    SLOTS.forEach((s) => { $('#btnJpg' + s.key).disabled = !S.id.slots[s.key]; });
    $('#btnDocx').disabled = !have.length;
    $('#btnIdShare').disabled = !have.length;
    $('#btnSaveAll').disabled = !have.length;
    const base = nm || '（未填姓名，會用「證件_日期時間」）';
    $('#idFn').textContent = have.length
      ? '將存成：' + have.map((s) => base + s.label + '.jpg').join('、') + '、' + base + '.docx'
      : '拍好至少一張照片後，就能存檔或產生 Word。';
  }
  function recordIdFix() {
    const f = $('#idName').value;
    learnName(S.id.raw.front, f); learnName(S.id.raw.nhi, f);
    Fix.save(); updateFixNote();
  }
  /* ===== 加註文字（深藍色楷書，印在照片的空白處） ===== */
  function stampText() {
    const a = $('#stA').checked;
    const ps = ['#stB', '#stC', '#stD'].filter((s) => $(s).checked).map((s) => $(s).parentElement.textContent.trim());
    if (!a && !ps.length) return '';
    return '僅供' + (a ? '臺灣銀行' : '') + ps.join('、') + '使用';
  }
  function updateStampUi() {
    $('#stampPv').textContent = stampText() || '（未勾選，不加註）';
  }
  async function ensureKai(text) {                       // 載入楷體字型；失敗就用系統字型
    S.kaiFail = false;
    try {
      if (!S.kaiCss) {                                   // 只建立一次樣式表連結，並等它載入完成（或失敗）
        S.kaiCss = new Promise((res) => {
          const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = KAI_CSS;
          l.onload = () => res(true); l.onerror = () => { S.kaiCss = null; res(false); };
          document.head.appendChild(l); setTimeout(() => res(false), 8000);
        });
      }
      const ok = await S.kaiCss;
      if (!ok) { S.kaiFail = true; return; }
      await Promise.race([document.fonts.load('40px "LXGW WenKai TC"', text), new Promise((r) => setTimeout(r, 8000))]);
      S.kaiFail = !Array.from(document.fonts).some((f) => /LXGW/.test(f.family) && f.status === 'loaded');
    } catch (_) { S.kaiFail = true; }
  }
  function drawStamp(c, text) {
    const W = c.width, H = c.height, x = c.getContext('2d');
    const d = x.getImageData(0, 0, W, H).data;
    const L = (px, py) => { const i = (py * W + px) * 4; return (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000; };
    const mx = Math.round(W * 0.03), my = Math.round(H * 0.04);
    // 依字級排版：放得下一行就一行，否則分兩行
    function layout(fs) {
      x.font = fs + 'px ' + KAI_STACK;
      let lines = [text];
      if (x.measureText(text).width > W * 0.9) {
        let cut = text.indexOf('、', Math.floor(text.length / 3));
        cut = (cut < 0 || cut > text.length * 0.7) ? Math.ceil(text.length / 2) : cut + 1;
        lines = [text.slice(0, cut), text.slice(cut)];
      }
      const lineH = Math.round(fs * 1.25);
      return { fs, lines, lineH, boxH: lineH * lines.length + 6, boxW: Math.ceil(Math.max.apply(null, lines.map((l) => x.measureText(l).width))) + 16 };
    }
    // 在整張照片（含中間）找最平滑、最亮的位置：邊緣越少、越亮越像空白
    function search(ly) {
      let best = { s: Infinity, x: mx, y: my };
      const xs = []; for (let px = mx; px <= W - ly.boxW - mx; px += 24) xs.push(px); if (!xs.length) xs.push(mx);
      for (let py = my; py <= H - ly.boxH - my; py += 5) {
        for (const px of xs) {
          let sum = 0, lum = 0, n = 0;
          for (let yy = py; yy < py + ly.boxH; yy += 3) for (let xx = px; xx < Math.min(px + ly.boxW, W - 4); xx += 3) {
            const a = L(xx, yy);
            sum += Math.abs(a - L(xx + 4 > W - 1 ? xx : xx + 4, yy)) + Math.abs(a - L(xx, yy + 4 > H - 1 ? yy : yy + 4)); lum += a; n++;
          }
          const sc = sum / n + 0.25 * (255 - lum / n);
          if (sc < best.s) best = { s: sc, x: px, y: py };
        }
      }
      return best;
    }
    const tries = [34, 28, 24, 20].map((fs) => { const ly = layout(fs); return { ly, b: search(ly) }; });
    const minS = Math.min.apply(null, tries.map((t) => t.b.s));
    // 字越大越好讀：只要該字級找得到夠空白的位置（不比最空白處差太多）就用大的，否則改用較小字體
    const pick = tries.find((t) => t.b.s <= minS * 1.3 + 3) || tries[tries.length - 1];
    x.font = pick.ly.fs + 'px ' + KAI_STACK;
    x.textBaseline = 'top'; x.textAlign = 'left'; x.lineJoin = 'round';
    pick.ly.lines.forEach((ln, i) => {
      const ty = pick.b.y + 3 + i * pick.ly.lineH;
      x.lineWidth = Math.max(3, Math.round(pick.ly.fs / 7)); x.strokeStyle = 'rgba(255,255,255,0.9)'; x.strokeText(ln, pick.b.x + 8, ty);
      x.fillStyle = '#0b2a6f'; x.fillText(ln, pick.b.x + 8, ty);
    });
  }
  async function slotCanvas(s, text) {
    const bmp = await createImageBitmap(S.id.slots[s.key].blob);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    if (text) drawStamp(c, text);
    return c;
  }
  async function previewStamp() {
    const text = stampText(), box = $('#stampPvImgs'); box.innerHTML = '';
    if (!text) { $('#stampPv').textContent = '（未勾選，不加註）'; return; }
    if (!SLOTS.some((s) => S.id.slots[s.key])) { $('#stampPv').textContent = text + '（拍好照片後才能預覽）'; return; }
    await ensureKai(text);
    for (const s of SLOTS) {
      if (!S.id.slots[s.key]) continue;
      const im = document.createElement('img'); im.alt = s.label;
      im.src = (await slotCanvas(s, text)).toDataURL('image/jpeg', 0.8);
      box.appendChild(im);
    }
    if (S.kaiFail) $('#stampPv').textContent = text + '（楷體字型未載入，預覽改用系統字型；請連網後再試）';
  }
  async function makeDocx() {
    const list = haveSlots();
    if (!list.length) throw new Error('還沒有照片');
    const text = stampText();
    if (text) await ensureKai(text);
    const imgs = [];
    for (const s of list) {
      if (!text) { imgs.push(new Uint8Array(await S.id.slots[s.key].blob.arrayBuffer())); continue; }
      const b = await jpgBlob(s, text, true);
      imgs.push(new Uint8Array(await b.arrayBuffer()));
    }
    return DocxLite.buildDocx(imgs, { widthCm: ID_W_CM, heightCm: ID_H_CM });
  }
  async function jpgBlob(s, text, ready) {              // 單張 JPG（有勾加註就印上去）
    if (!text) return S.id.slots[s.key].blob;
    if (!ready) await ensureKai(text);
    const c = await slotCanvas(s, text);
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
  }
  const kaiNote = () => (stampText() && S.kaiFail ? '\n楷體字型未載入，加註改用系統字型；連網後重新存檔即可。' : '');
  async function saveJpg(s) {
    try {
      recordIdFix();
      const name = idBase() + s.label + '.jpg';
      download(await jpgBlob(s, stampText()), name);
      setStat('#idStat', '已存成 ' + name + '（在下載資料夾）' + kaiNote());
    } catch (e) { setStat('#idStat', '存檔失敗：' + e.message, true); }
  }
  async function saveDocx() {
    try {
      recordIdFix(); const blob = await makeDocx(); download(blob, idFilename());
      setStat('#idStat', '已產生 ' + idFilename() + '（在下載資料夾）' + kaiNote());
    } catch (e) { setStat('#idStat', '產生失敗：' + e.message, true); }
  }
  async function saveAll() {
    for (const s of haveSlots()) { await saveJpg(s); await new Promise((r) => setTimeout(r, 700)); }
    await saveDocx();
  }
  function resetId() {
    SLOTS.forEach((s) => { const o = S.id.slots[s.key]; if (o) URL.revokeObjectURL(o.url); });
    S.id.slots = {}; S.id.step = 'front'; S.id.nameEdited = false; S.id.sel = []; S.id.fb = null;
    S.id.raw = { front: [], nhi: [] }; S.id.cands = { front: [], nhi: [] }; S.id.lines = { front: [], nhi: [] };
    S.id.state = { front: '', nhi: '' };
    S.id.job.front++; S.id.job.nhi++;
    $('#idName').value = '';
    renderSlots(); updateIdUi(); setCam(true); window.scrollTo(0, 0);
  }

  /* ===== 拍後確認：可旋轉 90°，確定後才辨識 ===== */
  function rotateCanvas(c, rot) {
    rot = ((rot % 360) + 360) % 360;
    if (!rot) return c;
    const out = document.createElement('canvas'), swap = rot === 90 || rot === 270;
    out.width = swap ? c.height : c.width; out.height = swap ? c.width : c.height;
    const x = out.getContext('2d');
    if (rot === 90) { x.translate(out.width, 0); x.rotate(Math.PI / 2); }
    else if (rot === 180) { x.translate(out.width, out.height); x.rotate(Math.PI); }
    else { x.translate(0, out.height); x.rotate(-Math.PI / 2); }
    x.drawImage(c, 0, 0);
    return out;
  }
  function rotAllowed(rot) {                           // 證件最後一定要是橫式；名片任何方向都可以
    const P = S.pending;
    if (!P || P.mode !== 'id') return true;
    const swap = rot % 180 === 90, w = swap ? P.canvas.height : P.canvas.width, h = swap ? P.canvas.width : P.canvas.height;
    return w > h;
  }
  function afterCapture(c) {
    S.pending = { canvas: c, mode: S.mode, rot: 0 };
    for (const r of [0, 270, 90, 180]) { if (rotAllowed(r)) { S.pending.rot = r; break; } }
    if ($('#chkConfirm').checked) showReview(); else finalizePending();
  }
  function drawReview() {
    const P = S.pending; if (!P) return;
    const r = rotateCanvas(P.canvas, P.rot), cv = $('#rvCanvas');
    cv.width = r.width; cv.height = r.height;
    cv.getContext('2d').drawImage(r, 0, 0);
  }
  function showReview() {
    setCam(false);
    $('#rvTip').textContent = S.mode === 'id'
      ? '確認證件文字是正立的（可左右旋轉；證件最後一定是橫式）。確定後才會辨識，並放進 Word。'
      : '確認名片文字是正立的（可左右旋轉 90°）。確定後才會辨識並存檔。';
    $('#reviewSec').hidden = false; drawReview();
    $('#reviewSec').scrollIntoView({ block: 'start' });
  }
  function cancelReview() { S.pending = null; $('#reviewSec').hidden = true; }
  function rotateReview(dir) {
    const P = S.pending; if (!P) return;
    for (let i = 0; i < 4; i++) { P.rot = (P.rot + dir * 90 + 360) % 360; if (rotAllowed(P.rot)) break; }
    drawReview();
  }
  function finalizePending() {
    const P = S.pending; if (!P) return;
    const out = rotateCanvas(P.canvas, P.rot);
    cancelReview();
    if (P.mode === 'id') onIdShot(out); else onCardShot(out);
  }
  $('#btnRotL').onclick = () => rotateReview(-1);
  $('#btnRotR').onclick = () => rotateReview(1);
  $('#btnRvOk').onclick = finalizePending;
  $('#btnRetake').onclick = () => { cancelReview(); setCam(S.mode === 'card' || !!S.id.step); };
  $('#chkConfirm').onchange = () => { try { localStorage.setItem(CONFIRM_KEY, $('#chkConfirm').checked ? '1' : '0'); } catch (_) { /* 忽略 */ } };

  /* ===== 模式 ===== */
  function setMode(m) {
    S.mode = m;
    document.querySelectorAll('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    $('#slotSec').hidden = m !== 'id';
    $('#stampSec').hidden = m !== 'id';
    $('#idPanel').hidden = m !== 'id';
    $('#optCrop').hidden = m !== 'card';
    cancelReview(); updateOrientUi();
    if (m === 'card') {
      const pending = !!S.card.blob && !$('#cardPanel').hidden;
      $('#cardPanel').hidden = !pending;
      setCam(!pending);
    } else {
      $('#cardPanel').hidden = true;
      renderSlots(); updateIdUi();
      setCam(!!S.id.step);
    }
    updateHint();
    if (S.camOn) layoutStage();
  }

  /* ===== 事件 ===== */
  document.querySelectorAll('#seg button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
  $('#btnOrient').onclick = () => setOrient(S.orient[S.mode] === 'port' ? 'land' : 'port', true);
  $('#btnShot').onclick = shoot;
  $('#btnSwitch').onclick = switchCam;
  $('#btnSys').onclick = () => $('#fileSys').click();
  $('#btnGallery').onclick = () => $('#fileGallery').click();
  ['#fileSys', '#fileGallery'].forEach((sel) => {
    $(sel).onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; onFile(f); };
  });
  $('#cardName').oninput = () => { S.card.nameEdited = true; S.card.sel.name = []; updateCardFn(); renderCardPool(); };
  $('#cardCompany').oninput = () => { S.card.coEdited = true; S.card.sel.company = []; updateCardFn(); renderCardPool(); };
  $('#cardFile').oninput = () => { S.card.fileEdited = !!$('#cardFile').value; if (!S.card.fileEdited) updateCardFn(); };
  document.querySelectorAll('#cardTarget button').forEach((b) => { b.onclick = () => { S.card.target = b.dataset.t; renderCardPool(); }; });
  $('#btnPoolClear').onclick = () => {
    const tg = S.card.target; S.card.sel[tg] = [];
    if (tg === 'name') { $('#cardName').value = ''; S.card.nameEdited = true; } else { $('#cardCompany').value = ''; S.card.coEdited = true; }
    updateCardFn(); renderCardPool();
  };
  $('#btnIdPoolClear').onclick = () => { S.id.sel = []; $('#idName').value = ''; S.id.nameEdited = true; updateIdUi(); };
  $('#btnCardSave').onclick = () => { if (S.card.blob) { recordCardFix(); download(S.card.blob, cardFilename()); } };
  $('#btnCardShare').onclick = () => { if (S.card.blob) { recordCardFix(); share(S.card.blob, cardFilename()); } };
  $('#btnCardNext').onclick = nextCard;
  $('#idName').oninput = () => { S.id.nameEdited = true; S.id.sel = []; updateIdUi(); };
  $('#btnDocx').onclick = saveDocx;
  SLOTS.forEach((s) => { $('#btnJpg' + s.key).onclick = () => saveJpg(s); });
  $('#btnSaveAll').onclick = saveAll;
  $('#btnIdShare').onclick = async () => { try { recordIdFix(); share(await makeDocx(), idFilename()); } catch (_) { /* 忽略 */ } };
  $('#btnIdReset').onclick = resetId;
  $('#btnFixClear').onclick = () => { if (confirm('清除所有已記住的修正？')) { Fix.clear(); updateFixNote(); } };
  if (canShareFiles) { $('#btnCardShare').hidden = false; $('#btnIdShare').hidden = false; }

  window.addEventListener('resize', () => { if (S.camOn) layoutStage(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCam();
    else if (S.wantCam && !S.stream) startCam();
  });

  /* ===== PWA 安裝 / Service Worker ===== */
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#btnInstall').hidden = false; });
  window.addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; });
  $('#btnInstall').onclick = async () => {
    if (!deferred) return;
    deferred.prompt(); await deferred.userChoice.catch(() => {}); deferred = null; $('#btnInstall').hidden = true;
  };
  if ('serviceWorker' in navigator) {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) $('#updBar').hidden = false; });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  $('#btnReload').onclick = () => location.reload();
  $('#ver').textContent = '版本 ' + APP_VERSION;

  try {
    S.orient.card = localStorage.getItem(ORI_KEY + '.card') === 'land' ? 'land' : 'port';
    S.orient.id = localStorage.getItem(ORI_KEY + '.id') === 'land' ? 'land' : 'port';
    $('#chkConfirm').checked = localStorage.getItem(CONFIRM_KEY) !== '0';
  } catch (_) { /* 忽略 */ }
  updateOrientUi();
  updateFixNote();
  ['#stA', '#stB', '#stC', '#stD'].forEach((s) => { $(s).onchange = () => { $('#stampPvImgs').innerHTML = ''; updateStampUi(); }; });
  $('#btnStampPv').onclick = previewStamp;
  updateStampUi();
  setMode('id');
})();
