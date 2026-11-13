/* 從 Tesseract 的 lines 結果解析姓名／公司名稱（純函式，可在 node 測試） */
(function (root) {
  'use strict';
  var CJK = '\\u4e00-\\u9fff';

  function cleanSpaces(s) {
    s = String(s || '').replace(/[\u3000\s]+/g, ' ').trim();
    // 中文字之間的空白移除（Tesseract 常在字間插入空白）
    return s.replace(new RegExp('([' + CJK + '])\\s+(?=[' + CJK + '])', 'g'), '$1');
  }
  function noSpace(s) { return cleanSpaces(s).replace(/\s+/g, ''); }

  function normalizeLines(data) {
    var out = [];
    var ls = (data && data.lines) || [];
    ls.forEach(function (l) {
      var t = cleanSpaces(l.text);
      if (!t) return;
      var b = l.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 };
      out.push({ text: t, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, h: b.y1 - b.y0, w: b.x1 - b.x0, conf: l.confidence || 0 });
    });
    if (!out.length && data && data.text) {
      data.text.split(/\n+/).forEach(function (s, i) {
        var t = cleanSpaces(s);
        if (t) out.push({ text: t, x0: 0, y0: i * 10, x1: 0, y1: i * 10 + 10, h: 10, w: 0, conf: 0 });
      });
    }
    return out;
  }

  /* ---------- 姓名驗證 ---------- */
  function normName(s) {
    s = String(s || '').replace(/[•・．.]/g, '·');
    if (new RegExp('^[' + CJK + ']{2,4}$').test(s)) return s;
    // 原住民姓名等含間隔號的長姓名
    if (new RegExp('^[' + CJK + ']{1,6}·[' + CJK + '·]{1,10}$').test(s)) return s;
    return '';
  }

  /* ---------- 身分證／健保卡 ---------- */
  var ID_STOP = ['中華', '民國', '國民', '身分', '身份', '統一', '編號', '出生', '年月', '性別', '配偶', '役別',
    '住址', '發證', '日期', '全民', '健康', '保險', '卡號', '姓名', '簽發', '換發', '補發', '初發', '持卡',
    '有效', '期限', '衛生', '福利', '內政', '國籍', '原住民', '戶政', '事務', '註記', '照片', '背面', '正面',
    '卡片', '字號', '出生地', '父', '母'];
  // 單字 '父' '母' 只在整串等於它時才排除，避免誤殺姓名
  function hasStop(s) {
    for (var i = 0; i < ID_STOP.length; i++) {
      var w = ID_STOP[i];
      if (w.length === 1) { if (s === w) return true; continue; }
      if (s.indexOf(w) >= 0) return true;
    }
    return false;
  }

  function parseIdName(lines) {
    var out = [];
    function add(raw) {
      var n = normName(noSpace(raw));
      if (n && !hasStop(n) && out.indexOf(n) < 0) out.push(n);
    }
    var labels = [];
    lines.forEach(function (l) {
      var t = noSpace(l.text);
      var m = t.match(/姓名[:：;]?(.{2,14})/);
      if (m) {
        var tail = m[1].replace(new RegExp('[^' + CJK + '·・•．]', 'g'), '');
        ID_STOP.forEach(function (w) {
          if (w.length < 2) return;
          var idx = tail.indexOf(w);
          if (idx > 0) tail = tail.slice(0, idx);
        });
        add(tail);
      }
      if (/姓名$/.test(t)) labels.push(l);
    });
    // 標籤與姓名分屬不同行：找右方、再找下方
    labels.forEach(function (lb) {
      var cy = (lb.y0 + lb.y1) / 2, hh = Math.max(lb.h, 10);
      lines.filter(function (l) {
        return l !== lb && l.x0 >= lb.x1 - hh && Math.abs((l.y0 + l.y1) / 2 - cy) < hh * 1.2;
      }).sort(function (a, b) { return a.x0 - b.x0; }).forEach(function (l) { add(l.text); });
      lines.filter(function (l) {
        return l !== lb && l.y0 >= lb.y1 - hh * 0.3 && l.y0 <= lb.y1 + hh * 3 && l.x1 > lb.x0 && l.x0 < lb.x1 + hh * 6;
      }).sort(function (a, b) { return a.y0 - b.y0 || a.x0 - b.x0; }).forEach(function (l) { add(l.text); });
    });
    // 後備：整行就是 2~4 個中文字，字最大者優先
    lines.slice().sort(function (a, b) { return b.h - a.h; }).forEach(function (l) {
      if (new RegExp('^[' + CJK + ']{2,4}$').test(noSpace(l.text))) add(l.text);
    });
    return out.slice(0, 6);
  }

  /* ---------- 名片 ---------- */
  var TITLE_RE = /(董事長|總經理|副總|總監|經理|協理|副理|襄理|主任|主管|處長|部長|課長|組長|科長|院長|校長|所長|館長|店長|廠長|工程師|設計師|專員|助理|秘書|業務|顧問|代表|負責人|律師|會計師|醫師|教授|老師|博士|創辦人|執行長|CEO|CTO|COO|CFO|Manager|Director|Engineer|President|Sales)/i;
  var COMPANY_RE = /(股份有限公司|有限公司|公司|企業社|企業|事務所|診所|醫院|銀行|集團|工作室|協會|基金會|學會|大學|學院|科技|實業|工業|國際|\bInc\b|\bLtd\b|\bCo\.|\bCorp|\bLLC\b|\bCompany\b|\bGroup\b)/i;
  var CARD_STOP = ['電話', '傳真', '手機', '地址', '信箱', '網址', '統編', '部門', '名片', '行動', '公司', '姓名', '職稱'];
  var EN_NAME_RE = /^[A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){1,3}$/;

  function cleanCompany(t) {
    t = cleanSpaces(t).replace(/^(公司|名稱|公司名稱)[:：\s]*/, '');
    return t.replace(/^[\s|:：·•*_\-~]+|[\s|:：·•*_\-~]+$/g, '');
  }

  function parseCard(lines) {
    var names = [], comps = [], en = [];
    lines.forEach(function (l) {
      var t = l.text, ns = noSpace(t);
      if (COMPANY_RE.test(t)) {
        var c = cleanCompany(t);
        if (c.length >= 3) {
          var score = /股份有限公司|有限公司/.test(c) ? 3 : /公司/.test(c) ? 2 : 1;
          comps.push({ text: c, score: score, h: l.h, y: l.y0 });
        }
        return;
      }
      if (new RegExp('^[' + CJK + ']{2,4}$').test(ns)) {
        if (TITLE_RE.test(ns) || CARD_STOP.indexOf(ns) >= 0) return;
        names.push({ text: ns, h: l.h, y: l.y0 });
      } else if (EN_NAME_RE.test(t) && !TITLE_RE.test(t)) {
        en.push({ text: t, h: l.h, y: l.y0 });
      }
    });
    function rank(a, b) { return (b.h - a.h) || (a.y - b.y); }
    function uniq(arr) { var r = []; arr.forEach(function (x) { if (r.indexOf(x) < 0) r.push(x); }); return r; }
    names.sort(rank); en.sort(rank);
    comps.sort(function (a, b) { return (b.score - a.score) || (b.h - a.h) || (a.y - b.y); });
    return {
      names: uniq(names.map(function (x) { return x.text; }).concat(en.map(function (x) { return x.text; }))).slice(0, 6),
      companies: uniq(comps.map(function (x) { return x.text; })).slice(0, 4)
    };
  }

  var api = { cleanSpaces: cleanSpaces, normalizeLines: normalizeLines, parseIdName: parseIdName, parseCard: parseCard };
  root.Parse = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
