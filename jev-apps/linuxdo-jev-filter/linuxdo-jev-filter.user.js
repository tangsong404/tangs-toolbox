// ==UserScript==
// @name         LinuxDo Jev 过滤器
// @namespace    https://linux.do/
// @version      1.0.0
// @description  用 TypeSafe Jev（System One）按自然语言问题判断 linux.do 主题帖，支持过滤/高亮、作用域、规则优先级、草稿、规则测试、导入导出。文档：https://docs.typesafe.ai
// @author       you
// @match        https://linux.do/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.typesafe.ai
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  // ───────────────────────── 常量 ─────────────────────────
  var BUCKET_MAX = 1000;
  var CLASSIFIER_KEY = 'ldf_jev_classifier_v1';   // {name,status,instructions,scope,categories:[{key,desc,action,color}]}
  var LEGACY_RULES_KEY = 'ldf_jev_rules_v1';      // 旧版多规则，用于迁移
  var CFG_KEY = 'ldf_jev_cfg_v1';
  var CACHE_KEY = 'ldf_jev_cache_v1';
  var CACHE_MAX = 20000;
  var HOME_ROUTES = ['latest', 'new', 'unseen', 'hot', 'top', 'read'];
  var HL_PALETTE = ['#ffb000', '#1971c2', '#2f9e44', '#e03131', '#9c36b5', '#f76707', '#0c8599', '#66a80f'];

  // ───────────────────────── 状态 ─────────────────────────
  var state = {
    catMap: null,
    catMapPromise: null,
    buckets: {},
    classifier: null,      // 原始分类配置
    CL: null,              // 编译后的分类（运行时）
    pageHighlights: {},
    jevVerdicts: {},
    jevInflight: {},
    jevPending: 0,
    jevRunning: 0,
    jevError: '',
    jevBlocked: false,
    jevLog: [],
    pageTopics: {},
    users: {},              // userId -> {username, name}（来自 topic_list.users）
    currentPage: null,
    cfg: null,
    cache: {}
  };

  // ───────────────────────── 小工具 ─────────────────────────
  function log() { try { if (state.currentPage && state.currentPage.kind === 'other') return; console.log.apply(console, ['%c[LDJ]', 'color:#6b46c1'].concat([].slice.call(arguments))); } catch (e) { } }
  function err() { try { console.error.apply(console, ['%c[LDJ]', 'color:#e55'].concat([].slice.call(arguments))); } catch (e) { } }
  function gmGet(key, def) { try { var v = GM_getValue(key, def); return (v === undefined || v === null) ? def : v; } catch (e) { return def; } }
  function gmSet(key, val) { try { GM_setValue(key, val); } catch (e) { } }
  function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function escAttr(s) { return escHtml(s); }
  function hashStr(s) { var h = 5381, i; s = String(s == null ? '' : s); for (i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function clampNum(v, lo, hi, def) { v = Number(v); if (!isFinite(v)) return def; return Math.min(hi, Math.max(lo, v)); }
  function clampInt(v, lo, hi, def) { v = parseInt(v, 10); if (!isFinite(v)) return def; return Math.min(hi, Math.max(lo, v)); }
  function joinUrl(base, path) { return String(base == null ? '' : base).replace(/\/+$/, '') + '/' + String(path == null ? '' : path).replace(/^\/+/, ''); }
  function trimText(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
  function hlColorFor(r, i) { if (r && typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color)) return r.color; return HL_PALETTE[i % HL_PALETTE.length]; }

  var toastEl = null;
  function ldfToast(msg, type) {
    try {
      if (!document.body) return;
      if (!toastEl) { toastEl = document.createElement('div'); toastEl.id = 'ldj-toast'; document.body.appendChild(toastEl); }
      toastEl.textContent = msg;
      toastEl.className = 'ldj-toast ldj-toast-' + (type || 'info');
      toastEl.style.display = 'block';
      clearTimeout(toastEl._t);
      toastEl._t = setTimeout(function () { toastEl.style.display = 'none'; }, 8000);
    } catch (e) { }
  }

  // ───────────────────────── 配置 ─────────────────────────
  var JEV_MODEL_DEFAULT = 'jev-latest';
  var JEV_TIMEOUT = 30000;
  var JEV_CONCURRENCY = 4;
  // 批量请求时作为 state 传的描述（每条帖子在各自问题的 instructions.post 里）
  var JEV_BATCH_STATE = { source: 'linux.do topic list' };
  // 内置供应商（选一个自动填好 Base URL / 接口 / 类型名）
  var JEV_PROVIDERS = {
    typesafe: { label: 'TypeSafe 官方', baseUrl: 'https://api.typesafe.ai', endpoint: 'v1/systemone', apiStyle: 'systemone', model: 'jev-latest' },
    openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', endpoint: 'v1/systemone', apiStyle: 'systemone', model: 'typesafe/jev-1.14' },
    vercel: { label: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh', endpoint: 'v1/evaluate', apiStyle: 'vercel', model: 'typesafe-ai/jev-1.14.0' },
    custom: { label: '自定义（本地路由等）…', baseUrl: '', endpoint: 'v1/systemone', apiStyle: 'systemone', model: '' }
  };

  var CFG_DEFAULT = {
    enabled: false,
    batchSize: 10,
    dimPending: true,
    model: 'jev-latest',
    providerKey: 'typesafe',
    // 下面是「当前选中供应商」解析后的值，由 applyActiveProvider 维护，运行时直接用
    apiKey: '',
    baseUrl: 'https://api.typesafe.ai',
    apiStyle: 'systemone',
    endpoint: 'v1/systemone',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    extraHeaders: '',
    providers: {                       // providerKey -> {enabled, apiKey, [自定义: name/baseUrl/apiStyle/authHeader/authPrefix/extraHeaders]}
      typesafe: { enabled: false, apiKey: '' },
      openrouter: { enabled: false, apiKey: '' },
      vercel: { enabled: false, apiKey: '' }
    },
    models: {}                         // providerKey -> [model id]
  };
  var modelFilterText = '';

  function providerConf(cfg, key) { return (cfg.providers && cfg.providers[key]) || {}; }
  // 解析某供应商实际要用的连接参数
  function resolveProvider(cfg, key) {
    var pc = providerConf(cfg, key);
    var d = JEV_PROVIDERS[key];
    if (d) {
      return { key: key, label: d.label, custom: false, apiKey: pc.apiKey || '', baseUrl: d.baseUrl, endpoint: d.endpoint, apiStyle: d.apiStyle, authHeader: 'Authorization', authPrefix: 'Bearer ', extraHeaders: '' };
    }
    var ep = (pc.endpoint || '').trim() || (pc.apiStyle === 'vercel' ? 'v1/evaluate' : 'v1/systemone');
    return {
      key: key, label: pc.name || '自定义', custom: true, apiKey: pc.apiKey || '',
      baseUrl: pc.baseUrl || '', endpoint: ep, apiStyle: /evaluate/i.test(ep) ? 'vercel' : 'systemone',
      authHeader: pc.authHeader || 'Authorization', authPrefix: (pc.authPrefix == null ? 'Bearer ' : pc.authPrefix),
      extraHeaders: pc.extraHeaders || ''
    };
  }
  // 把选中供应商的参数写进 cfg 顶层，供运行时直接使用
  function applyActiveProvider(cfg, key, model) {
    if (!key) return;
    if (!cfg.providers[key]) cfg.providers[key] = { enabled: true, apiKey: '' };
    var r = resolveProvider(cfg, key);
    cfg.providerKey = key;
    cfg.baseUrl = r.baseUrl;
    cfg.apiStyle = r.apiStyle;
    cfg.endpoint = r.endpoint;
    cfg.apiKey = r.apiKey;
    cfg.authHeader = r.authHeader;
    cfg.authPrefix = r.authPrefix;
    cfg.extraHeaders = r.extraHeaders;
    if (model) cfg.model = model;
  }
  function providerModels(cfg, key) { return (cfg.models && cfg.models[key]) || []; }
  // 所有已启用供应商的模型并集：[{key, label, id}]
  function modelUnion(cfg) {
    var out = [];
    Object.keys(cfg.providers || {}).forEach(function (key) {
      var pc = providerConf(cfg, key);
      if (!pc.enabled) return;
      var label = resolveProvider(cfg, key).label;
      providerModels(cfg, key).forEach(function (id) { out.push({ key: key, label: label, id: id }); });
    });
    return out;
  }

  loadCfg();
  loadCache();

  function cfgFromSaved(saved) {
    var cfg = {};
    Object.keys(CFG_DEFAULT).forEach(function (k) { if (k !== 'providers' && k !== 'models') cfg[k] = CFG_DEFAULT[k]; });
    cfg.providers = {};
    Object.keys(CFG_DEFAULT.providers).forEach(function (k) { cfg.providers[k] = { enabled: false, apiKey: '' }; });
    cfg.models = {};
    if (saved && typeof saved === 'object') {
      Object.keys(saved).forEach(function (k) { if (saved[k] !== undefined && saved[k] !== null) cfg[k] = saved[k]; });
      if (saved.providers && typeof saved.providers === 'object') {
        Object.keys(saved.providers).forEach(function (k) {
          cfg.providers[k] = Object.assign({}, cfg.providers[k] || {}, saved.providers[k]);
        });
      }
      if (saved.models && typeof saved.models === 'object') cfg.models = saved.models;
    }
    // 旧版单供应商配置迁移
    if (!saved || !saved.providerKey) {
      var key = (saved && (saved.provider || (saved.apiStyle === 'vercel' ? 'vercel' : (/openrouter/i.test(saved.baseUrl || '') ? 'openrouter' : (/typesafe/i.test(saved.baseUrl || '') ? 'typesafe' : 'custom'))))) || 'typesafe';
      if (saved && /^sk-or-/.test(saved.apiKey || '')) key = 'openrouter';   // OpenRouter Key 前缀纠正（避免旧单字段配置把 OR Key 落到 TypeSafe）
      if (key !== 'custom' && !JEV_PROVIDERS[key]) key = 'custom';
      if (!cfg.providers[key]) cfg.providers[key] = { enabled: true, apiKey: '' };
      if (saved) {
        if (!cfg.providers[key].apiKey && saved.apiKey) cfg.providers[key].apiKey = saved.apiKey;
        cfg.providers[key].enabled = true;
        if (key === 'custom') {
          cfg.providers[key].baseUrl = saved.baseUrl || '';
          cfg.providers[key].endpoint = saved.endpoint || (saved.apiStyle === 'vercel' ? 'v1/evaluate' : 'v1/systemone');
          cfg.providers[key].authHeader = saved.authHeader;
          cfg.providers[key].authPrefix = saved.authPrefix;
          cfg.providers[key].extraHeaders = saved.extraHeaders || '';
        }
      }
      cfg.providerKey = key;
    }
    if (!cfg.providers[cfg.providerKey]) cfg.providers[cfg.providerKey] = { enabled: true, apiKey: '' };
    delete cfg.provider; delete cfg.rules;
    applyActiveProvider(cfg, cfg.providerKey, cfg.model);
    return cfg;
  }
  function loadCfg() {
    state.cfg = cfgFromSaved(gmGet(CFG_KEY, null));
  }
  function saveCfg() {
    var c = state.cfg;
    c.batchSize = clampInt(c.batchSize, 1, 50, 10);
    applyActiveProvider(c, c.providerKey, c.model);
    if (!c.model) c.model = JEV_MODEL_DEFAULT;
    gmSet(CFG_KEY, c);
    state.jevVerdicts = {};
    state.jevError = '';
    state.jevBlocked = false;
    reloadClassifier();
    rescanCurrentPage();
    updateCount();
  }
  function jevEnabled() { return !!state.CL; }

  // ───────────────────────── 缓存 ─────────────────────────
  function loadCache() {
    var v = gmGet(CACHE_KEY, null);
    state.cache = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  }
  var cacheTimer = null;
  function saveCacheSoon() {
    if (cacheTimer) return;
    cacheTimer = setTimeout(function () { cacheTimer = null; pruneCache(); gmSet(CACHE_KEY, state.cache); }, 1500);
  }
  function pruneCache() {
    var keys = Object.keys(state.cache), total = 0, i;
    for (i = 0; i < keys.length; i++) total += Object.keys(state.cache[keys[i]] || {}).length;
    if (total <= CACHE_MAX) return;
    var flat = [];
    keys.forEach(function (k) {
      var m = state.cache[k] || {};
      Object.keys(m).forEach(function (id) { flat.push({ k: k, id: id, t: (m[id] && m[id].t) || 0 }); });
    });
    flat.sort(function (a, b) { return a.t - b.t; });
    for (i = 0; i < Math.floor(flat.length / 2); i++) { if (state.cache[flat[i].k]) delete state.cache[flat[i].k][flat[i].id]; }
  }
  function cacheGet(key, id) { var m = state.cache[key]; return m ? m[id] : undefined; }
  function cacheSet(key, id, answer) {
    if (!state.cache[key]) state.cache[key] = {};
    state.cache[key][id] = { a: answer, t: Date.now() };
    saveCacheSoon();
  }

  // ───────────────────────── 类别映射 ─────────────────────────
  function buildCatMap(categories) {
    var id2 = new Map();
    (categories || []).forEach(function (c) {
      id2.set(c.id, { id: c.id, name: c.name, slug: c.slug, parentId: c.parent_category_id || null });
    });
    state.catMap = { id2: id2 };
    log('类别映射就绪：', id2.size, '个类别');
  }
  function ensureCatMapFromSite(siteObj) {
    if (state.catMap) return;
    if (siteObj && siteObj.categories) buildCatMap(siteObj.categories);
  }
  function ensureCatMapFallback() {
    if (state.catMap) return Promise.resolve(state.catMap);
    if (state.catMapPromise) return state.catMapPromise;
    state.catMapPromise = new Promise(function (resolve) {
      try {
        fetch('/site.json', { headers: { 'Accept': 'application/json' } })
          .then(function (r) { return r.json(); })
          .then(function (s) { buildCatMap(s.categories); resolve(state.catMap); })
          .catch(function (e) { err('回退 /site.json 失败', e); resolve(null); });
      } catch (e) { err('回退 /site.json 失败', e); resolve(null); }
    });
    return state.catMapPromise;
  }
  function collectDescendants(pid, ids) {
    ids.add(pid);
    state.catMap.id2.forEach(function (c) { if (c.parentId === pid) collectDescendants(c.id, ids); });
  }
  function expandCategoryIdsWithDescendants(categoryIds) {
    var out = new Set();
    (categoryIds || []).forEach(function (cid) { collectDescendants(cid, out); });
    return out;
  }

  // ───────────────────────── 页面上下文 ─────────────────────────
  function pageContext(u) {
    try {
      var url = new URL(u, location.href);
      var catParam = /[?&]category=(\d+)/i.exec(url.search);
      if (catParam) {
        var cid1 = parseInt(catParam[1], 10);
        var f1 = (/[\?&]order=([a-z]+)/i.exec(url.search) || [])[1] || 'latest';
        return { kind: 'category', categoryId: cid1, filter: f1.toLowerCase(), key: 'cat:' + cid1 + ':' + f1.toLowerCase() };
      }
      if (url.pathname === '/' || url.pathname === '') return { kind: 'home', route: 'latest', key: 'home:latest' };
      var hm = new RegExp('^/(' + HOME_ROUTES.join('|') + ')(\\.json)?(/.*)?$', 'i').exec(url.pathname);
      if (hm) return { kind: 'home', route: hm[1].toLowerCase(), key: 'home:' + hm[1].toLowerCase() };
      var cm = /^\/c\/[^/]+(?:\/[^/]+)?\/(\d+)(?:\/l\/([a-z]+))?/i.exec(url.pathname);
      if (cm) {
        var cid2 = parseInt(cm[1], 10);
        var f2 = (cm[2] || 'latest').toLowerCase();
        return { kind: 'category', categoryId: cid2, filter: f2, key: 'cat:' + cid2 + ':' + f2 };
      }
      return { kind: 'other', key: 'other' };
    } catch (e) { return { kind: 'other', key: 'other' }; }
  }
  function isFilterablePage(pg) { return pg && (pg.kind === 'home' || pg.kind === 'category'); }

  function ruleAppliesToPage(rule, pg) {
    if (!rule.scope) return true;
    if (pg.kind === 'other') return false;
    if (rule.scope.type === 'global') return true;
    if (rule.scope.type === 'home') return pg.kind === 'home';
    if (rule.scope.type === 'category') {
      if (rule.scope.includeHome && pg.kind === 'home') return true;
      if (pg.kind === 'category') return expandCategoryIdsWithDescendants(rule.scope.categoryIds || []).has(pg.categoryId);
      return false;
    }
    return false;
  }
  function pageHasActiveRule(pg) {
    return !!(state.CL && ruleAppliesToPage(state.CL, pg));
  }

  // ───────────────────────── Jev：问题与命中判定 ─────────────────────────
  // 不同网关的差异：TypeSafe/OpenRouter 用 /v1/systemone 且布尔类型名为 noul；
  // Vercel AI Gateway 用 /v1/evaluate 且布尔类型名为 boolean。
  function jevEndpointPath(cfg) { return (cfg && cfg.endpoint) ? cfg.endpoint : 'v1/systemone'; }
  function jevBoolType() { return (state.cfg && state.cfg.apiStyle === 'vercel') ? 'boolean' : 'noul'; }
  // 依据官方文档：questions 里每个键是一个 Question{type, instructions, criteria?}
  function jevQuestionOf() {
    return { type: 'choice', instructions: state.CL.instructions, criteria: state.CL.criteria };
  }
  // 解析发帖人（posters + topic_list.users）
  function posterInfo(t) {
    var posters = t.posters || [];
    var opId = null, i;
    for (i = 0; i < posters.length; i++) {
      if (/original poster/i.test(String(posters[i] && posters[i].description || ''))) { opId = posters[i].user_id; break; }
    }
    if (opId == null && posters.length) opId = posters[0].user_id;
    var u = (opId != null) ? state.users[opId] : null;
    if (!u && t.last_poster_username) return { username: t.last_poster_username, name: '', display: '@' + t.last_poster_username };
    if (!u) return null;
    var name = u.name || '';
    return { username: u.username || '', name: name, display: name ? (name + ' (@' + u.username + ')') : ('@' + u.username) };
  }
  function posterName(t) { var p = posterInfo(t); return p ? p.display : ''; }
  function jevStateOf(t) {
    var cat = (t.category_id != null && state.catMap) ? state.catMap.id2.get(t.category_id) : null;
    var s = {
      title: t.title || t.fancy_title || '',
      category: cat ? cat.name : (t.category_id != null ? ('#' + t.category_id) : null),
      tags: (t.tags || []).map(function (x) { return x.name || x.slug || ''; }).filter(Boolean),
      author: posterName(t) || null,
      replies: t.posts_count != null ? Math.max(0, t.posts_count - 1) : null,
      views: t.views != null ? t.views : null,
      created_at: t.created_at || null,
      excerpt: (function () {
        var ex = String(t.excerpt || '').replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
        return ex ? ex.slice(0, 300) : null;
      })()
    };
    Object.keys(s).forEach(function (k) { if (s[k] === null || s[k] === '' || (Array.isArray(s[k]) && !s[k].length)) delete s[k]; });
    return s;
  }

  // ───────────────────────── Jev：分类编译 ─────────────────────────
  function defaultClassifier() {
    return {
      name: '帖子分类',
      status: 'draft',
      instructions: '这条帖子的主要性质属于哪一类？',
      scope: { type: 'global' },
      categories: [
        { key: '商用推广', desc: "带 '富可敌国'、'福利羊毛' 标签，或涉及中转站、送额度、商业推广性质、收费或盈利的产品", action: 'filter' },
        { key: '站内交易', desc: "带 '积分乐园' 标签，或涉及 '出' 一个物品、'收' 一个物品，以及谈到 Linux Do Credit (LDC)、抽奖之类的话题", action: 'filter' },
        { key: '灌水', desc: "无有效信息、纯情绪，或带 '纯水' 标签", action: 'filter' },
        { key: '价值', desc: '其他有实质价值的内容', action: 'ignore' }
      ]
    };
  }
  // 旧版多规则 → 单问题多分类
  function classifierFromRules(old) {
    if (!Array.isArray(old) || !old.length) return null;
    var base = old.filter(function (r) { return r && r.instructions; })[0];
    if (!base) return null;
    var cats = [], seen = {};
    old.forEach(function (r) {
      if (!r || !r.instructions || r.instructions !== base.instructions) return;
      (((r.hit || {}).options) || []).forEach(function (k) {
        if (!k || seen[k]) return; seen[k] = 1;
        var desc = '';
        (r.criteria || []).forEach(function (o) { if (o && o.key === k) desc = o.desc || ''; });
        cats.push({ key: k, desc: desc, action: r.mode === 'highlight' ? 'highlight' : 'filter', color: r.color });
      });
    });
    (base.criteria || []).forEach(function (o) {
      if (o && o.key && !seen[o.key]) { seen[o.key] = 1; cats.push({ key: o.key, desc: o.desc || '', action: 'ignore', color: null }); }
    });
    if (!cats.length) return null;
    return { name: base.name || '分类', status: 'active', instructions: base.instructions, scope: base.scope || { type: 'global' }, categories: cats };
  }
  function migrateClassifier() { return classifierFromRules(gmGet(LEGACY_RULES_KEY, null)); }
  function normClassifier(obj) {
    obj = obj || {};
    return {
      name: obj.name || '分类',
      status: obj.status === 'draft' ? 'draft' : 'active',
      instructions: obj.instructions || '',
      scope: obj.scope || { type: 'global' },
      categories: (obj.categories || []).filter(function (c) { return c && c.key; }).map(function (c) {
        return { key: c.key, desc: c.desc || '', action: c.action === 'highlight' ? 'highlight' : (c.action === 'ignore' ? 'ignore' : 'filter'), color: c.color };
      })
    };
  }

  function reloadClassifier() {
    var raw = gmGet(CLASSIFIER_KEY, null);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.categories)) raw = migrateClassifier() || defaultClassifier();
    state.classifier = raw;
    state.CL = null;
    if (raw.status !== 'active' || !raw.instructions) return;
    var criteria = {}, cats = [], catByKey = {}, hlN = 0;
    (raw.categories || []).forEach(function (cat) {
      if (!cat || !cat.key) return;
      criteria[cat.key] = cat.desc || null;
      var action = cat.action === 'highlight' ? 'highlight' : (cat.action === 'ignore' ? 'ignore' : 'filter');
      var color = action === 'highlight' ? hlColorFor(cat, hlN++) : null;
      var c = { key: cat.key, desc: cat.desc || '', action: action, color: color };
      cats.push(c); catByKey[c.key] = c;
    });
    if (!cats.length) return;
    state.CL = {
      name: raw.name || '分类',
      instructions: raw.instructions,
      criteria: criteria,
      categories: cats,
      catByKey: catByKey,
      scope: raw.scope || { type: 'global' },
      key: 'c' + hashStr(JSON.stringify({ m: state.cfg.model, instructions: raw.instructions, criteria: criteria }))
    };
    log('分类编译：', cats.length, '类');
  }

  // 返回 null（忽略）/ {mode,...}（过滤/高亮）/ 'pending'（未判定）
  function jevDecide(t, pg) {
    if (!state.CL || !ruleAppliesToPage(state.CL, pg)) return null;
    var rec = cacheGet(state.CL.key, t.id);
    if (rec === undefined) return 'pending';
    var c = state.CL.catByKey[(rec.a || {}).choice];
    if (!c || c.action === 'ignore') return null;
    return { mode: c.action, color: c.color || '', name: c.key };
  }
  function jevPendingRules(t, pg) {
    if (!state.CL || !ruleAppliesToPage(state.CL, pg)) return [];
    return cacheGet(state.CL.key, t.id) === undefined ? [state.CL] : [];
  }

  // ───────────────────────── Jev：HTTP ─────────────────────────
  function jevHeaders(cfg) {
    cfg = cfg || state.cfg;
    var h = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) {
      var hn = cfg.authHeader || 'Authorization';
      var hp = (cfg.authPrefix == null) ? 'Bearer ' : cfg.authPrefix;
      h[hn] = hp + cfg.apiKey;
    }
    if (cfg.extraHeaders) {
      try {
        var extra = JSON.parse(cfg.extraHeaders);
        if (extra && typeof extra === 'object') Object.keys(extra).forEach(function (k) { h[k] = String(extra[k]); });
      } catch (e) { /* 非法 JSON 忽略 */ }
    }
    return h;
  }
  function httpViaFetch(method, url, headers, bodyStr, timeout) {
    return new Promise(function (resolve, reject) {
      var ctl = ('AbortController' in window) ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); }, timeout);
      var init = { method: method, headers: headers, signal: ctl ? ctl.signal : undefined };
      if (bodyStr != null) init.body = bodyStr;
      fetch(url, init)
        .then(function (r) { return r.text().then(function (t) { clearTimeout(timer); resolve({ status: r.status, text: t, via: 'fetch' }); }); })
        .catch(function (e) { clearTimeout(timer); reject(e); });
    });
  }
  function httpViaGM(method, url, headers, bodyStr, timeout) {
    return new Promise(function (resolve, reject) {
      try {
        GM_xmlhttpRequest({
          method: method, url: url, headers: headers, data: bodyStr, timeout: timeout,
          onload: function (r) { resolve({ status: r.status, text: r.responseText || '', via: 'gm' }); },
          onerror: function (r) {
            if (r && (r.status || r.responseText)) { resolve({ status: r.status || 0, text: r.responseText || '', via: 'gm' }); return; }
            var extra = [];
            if (r) { if (r.status) extra.push('status=' + r.status); if (r.statusText) extra.push('statusText=' + r.statusText); if (r.error) extra.push('error=' + r.error); }
            var e = new Error('网络错误（跨域或被拦截）：' + (extra.join(', ') || '无详情') + '\n请求：' + method + ' ' + url);
            e.jevTimeout = false; reject(e);
          },
          ontimeout: function () { var e = new Error('请求超时（' + timeout + 'ms）\n请求：' + method + ' ' + url); e.jevTimeout = true; reject(e); },
          onabort: function () { reject(new Error('请求已取消')); }
        });
      } catch (e) { reject(e); }
    });
  }
  function httpRequest(method, url, headers, bodyStr, timeout) {
    timeout = clampNum(timeout || JEV_TIMEOUT, 3000, 180000, JEV_TIMEOUT);
    if (typeof GM_xmlhttpRequest === 'function') {
      return httpViaGM(method, url, headers, bodyStr, timeout).catch(function (e) {
        if (e && e.jevTimeout) throw e;
        log('GM_xmlhttpRequest 失败，回退 fetch：', (e && e.message) || e);
        return httpViaFetch(method, url, headers, bodyStr, timeout).catch(function (e2) {
          throw new Error('GM_xmlhttpRequest 与 fetch 都失败。\nGM：' + ((e && e.message) || '') + '\nfetch：' + ((e2 && e2.message) || '') + '\n请求：' + method + ' ' + url);
        });
      });
    }
    return httpViaFetch(method, url, headers, bodyStr, timeout);
  }
  function jevErrorText(res) {
    var t = (res && res.text) || '';
    try {
      var j = JSON.parse(t);
      var e = (j.error && (j.error.message || j.error.type)) || j.message || j.detail;
      if (e) return String(typeof e === 'string' ? e : JSON.stringify(e));
    } catch (x) { }
    return trimText(t, 400);
  }
  function jevPost(body, cfgOverride) {
    var cfg = cfgOverride || state.cfg;
    var url = joinUrl(cfg.baseUrl || CFG_DEFAULT.baseUrl, jevEndpointPath(cfg));
    function attempt(n) {
      return httpRequest('POST', url, jevHeaders(cfg), JSON.stringify(body), JEV_TIMEOUT).then(function (res) {
        if (res && (res.status === 429 || res.status === 503 || res.status === 529) && n < 3) {
          var wait = (n + 1) * 1500;
          log('Jev 返回 ' + res.status + '，' + wait + 'ms 后重试（' + (n + 1) + '/3）');
          return new Promise(function (resolve) { setTimeout(resolve, wait); }).then(function () { return attempt(n + 1); });
        }
        if (!res || res.status < 200 || res.status >= 300) {
          var hint = (res && (res.status === 404 || res.status === 405)) ? '\n（该地址没有 /v1/systemone：OpenAI 兼容接口只有 /v1/chat/completions，需要直连 https://api.typesafe.ai）' : '';
          throw new Error('HTTP ' + ((res && res.status) || '?') + '（via ' + ((res && res.via) || '?') + '）：' + jevErrorText(res || {}) + hint);
        }
        var json;
        try { json = JSON.parse(res.text); } catch (e) { throw new Error('响应不是 JSON（via ' + res.via + '）：' + trimText(res.text, 300)); }
        return json;
      });
    }
    return attempt(0);
  }
  function jevParseModelEntries(res) {
    if (!res || res.status < 200 || res.status >= 300) throw new Error('HTTP ' + ((res && res.status) || '?') + '：' + jevErrorText(res || {}));
    var json; try { json = JSON.parse(res.text); } catch (e) { throw new Error('响应不是 JSON：' + trimText(res.text, 200)); }
    return Array.isArray(json) ? json : (json.models || json.data || []);
  }
  function modelIdOf(m) { return typeof m === 'string' ? m : (m && (m.id || m.name || m.model)); }
  // 只保留决策（System One / evaluation）模型
  function isDecisionModel(m) {
    if (typeof m === 'string') return true;
    var meta = m.type || m.modalities || m.output_modalities || m.architecture;
    if (!meta) return true; // 决策端点（如 TypeSafe）没有这些字段，全保留
    if (m.type === 'evaluation' || m.type === 'decision' || m.type === 'decisions') return true;
    var out = (m.modalities && m.modalities.output) || m.output_modalities || (m.architecture && m.architecture.output_modalities) || [];
    if (out.indexOf('decisions') !== -1 || out.indexOf('decision') !== -1) return true;
    return /jev/i.test(String(m.id || m.name || ''));
  }
  function jevFetchModels(p) {
    var base = p.baseUrl || '';
    if (!base) return Promise.reject(new Error('未填写 Base URL'));
    // OpenRouter 只有加 output_modalities=decisions 才是决策模型；否则会返回 400+ 个聊天模型
    var url = joinUrl(base, 'v1/models') + (/openrouter/i.test(base) ? '?output_modalities=decisions' : '');
    return httpRequest('GET', url, jevHeaders(p), null, JEV_TIMEOUT).then(function (res) {
      var entries = jevParseModelEntries(res);
      var list = entries.filter(isDecisionModel).map(modelIdOf).filter(Boolean);
      var seen = {}, out = [];
      list.forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } });
      if (!out.length) throw new Error('该端点没有决策模型（原始响应：' + trimText(res.text, 200) + '）');
      return out;
    });
  }

  // ───────────────────────── Jev：判定流程 ─────────────────────────
  function jevRecord(kind, model, obj) {
    state.jevLog.unshift({ t: Date.now(), kind: kind, model: model || '', text: JSON.stringify(obj, null, 2) });
    if (state.jevLog.length > 50) state.jevLog.length = 50;
    try { console.log('%c[LDJ Jev ' + kind + ']', 'color:#6b46c1;font-weight:bold', obj); } catch (e) { }
    refreshJevLog();
  }

  // 把一批帖子放进一次请求：每个（帖子, 规则）一个问题，
  // 按官方 structured instructions 模式把帖子数据放进该问题的 instructions。
  function jevEvaluateBatch(pg, topics) {
    if (!state.CL) return Promise.resolve(0);
    var seen = {}, pending = [];
    topics.forEach(function (t) {
      if (!t || t.id == null || seen[t.id]) return;
      seen[t.id] = 1;
      if (cacheGet(state.CL.key, t.id) === undefined) pending.push(t);
    });
    if (!pending.length) return Promise.resolve(0);
    var body;
    if (pending.length === 1) {
      // 单条：直接以帖子为 state，问题用原文（官方推荐形态，最准）
      body = { model: state.cfg.model, state: jevStateOf(pending[0]), questions: { q0: jevQuestionOf() } };
    } else {
      // 多条：每条帖子放进各自问题的 instructions，并且问题必须用反引号引用 `post`（文档要求）
      var questions = {};
      pending.forEach(function (t, i) {
        var q = jevQuestionOf();
        q.instructions = { post: jevStateOf(t), question: '针对 `post`：' + state.CL.instructions };
        questions['p' + i] = q;
      });
      body = { model: state.cfg.model, state: JEV_BATCH_STATE, questions: questions };
    }
    return jevPost(body).then(function (json) {
      jevRecord('响应', json.model || state.cfg.model, json);
      var answers = json.answers || {};
      pending.forEach(function (t, i) {
        var a = answers[pending.length === 1 ? 'q0' : ('p' + i)];
        if (a) cacheSet(state.CL.key, t.id, a);
      });
      return pending.length;
    });
  }

  function jevFinalizeTopic(pg, t) {
    if (!state.CL) return;
    var rec = cacheGet(state.CL.key, t.id);
    if (rec === undefined) return;
    var c = state.CL.catByKey[(rec.a || {}).choice];
    var name = c ? c.key : ((rec.a && rec.a.choice) || '未分类');
    var action = c ? c.action : 'ignore';
    if (!state.jevVerdicts[pg.key]) state.jevVerdicts[pg.key] = new Map();
    state.jevVerdicts[pg.key].set(t.id, { mode: action, color: c ? c.color : '', name: name });
    if (action === 'filter') {
      bucketAdd(pg.key, t);
      if (state.currentPage && pg.key === state.currentPage.key) pendingSelfEmpty = bucketCount();
      log('Jev 过滤：', t.title, '←', name);
    } else if (action === 'highlight') {
      if (!state.pageHighlights[pg.key]) state.pageHighlights[pg.key] = new Map();
      state.pageHighlights[pg.key].set(t.id, c.color);
      log('Jev 高亮：', t.title, '←', name);
    }
  }
  // 当前页已分类的帖子总数
  function classCount() {
    var pg = state.currentPage;
    var v = pg ? state.jevVerdicts[pg.key] : null;
    return v ? v.size : 0;
  }

  var jevQueue = [];
  function jevEnqueueBatch(pg, topics) {
    if (!topics.length) return;
    var keys = topics.map(function (t) { return pg.key + ':' + t.id; });
    keys.forEach(function (k) { state.jevInflight[k] = 1; });
    state.jevPending += topics.length;
    jevQueue.push({ pg: pg, topics: topics, keys: keys });
    updateCount();
    jevPump();
  }
  function jevPump() {
    while (state.jevRunning < JEV_CONCURRENCY && jevQueue.length) {
      var item = jevQueue.shift();
      state.jevRunning++;
      jevRunBatch(item);
    }
  }
  function jevRunBatch(item) {
    var done = function (e) {
      item.keys.forEach(function (k) { delete state.jevInflight[k]; });
      state.jevPending = Math.max(0, state.jevPending - item.topics.length);
      state.jevRunning = Math.max(0, state.jevRunning - 1);
      if (e) {
        var msg = (e && e.message) ? e.message : String(e);
        err('Jev 判定失败', msg);
        if (state.jevError !== msg) { state.jevError = msg; ldfToast('Jev 判定失败：' + msg, 'err'); }
        if (/HTTP (401|403)/.test(msg)) state.jevBlocked = true;
      }
      updateCount();
      applyJevVerdictsToDom();
      tryRenderSelfEmpty();
      jevPump();
    };
    var p;
    try { p = jevEvaluateBatch(item.pg, item.topics); } catch (e) { p = Promise.reject(e); }
    p.then(function () { item.topics.forEach(function (t) { jevFinalizeTopic(item.pg, t); }); done(null); }, function (e) { done(e); });
  }
  var jevScheduled = {};
  function jevSchedule(pg, topics) {
    var sig = pg.key + ':' + topics.map(function (t) { return t.id; }).join(',');
    if (jevScheduled[sig]) return;
    jevScheduled[sig] = 1;
    setTimeout(function () {
      delete jevScheduled[sig];
      if (state.jevBlocked || !state.CL) return;
      var seen = {}, uniq = [];
      topics.forEach(function (t) {
        if (!t || seen[t.id]) return;
        if (state.jevInflight[pg.key + ':' + t.id]) return;
        if (!jevPendingRules(t, pg).length) return;
        seen[t.id] = 1; uniq.push(t);
      });
      var size = clampInt(state.cfg.batchSize, 1, 50, 10);
      for (var i = 0; i < uniq.length; i += size) jevEnqueueBatch(pg, uniq.slice(i, i + size));
    }, 0);
  }

  // ───────────────────────── 已过滤桶 ─────────────────────────
  function pageBucket(key) { if (!state.buckets[key]) state.buckets[key] = { map: new Map(), order: [] }; return state.buckets[key]; }
  function bucketAdd(key, topic) {
    if (!topic || topic.id == null) return false;
    var b = pageBucket(key);
    if (b.map.has(topic.id)) return false;
    b.map.set(topic.id, topic); b.order.push(topic.id);
    while (b.order.length > BUCKET_MAX) { var old = b.order.shift(); b.map.delete(old); }
    return true;
  }
  function bucketAddMany(key, topics) {
    var added = 0;
    (topics || []).forEach(function (t) { if (bucketAdd(key, t)) added++; });
    if (added && state.currentPage && key === state.currentPage.key) updateCount();
    return added;
  }
  function bucketCount() { if (!state.currentPage) return 0; var b = state.buckets[state.currentPage.key]; return b ? b.order.length : 0; }
  function currentBucketOrder() { if (!state.currentPage) return []; var b = state.buckets[state.currentPage.key]; return b ? b.order : []; }
  function currentBucketMap() { if (!state.currentPage) return new Map(); var b = state.buckets[state.currentPage.key]; return b ? b.map : new Map(); }

  // ───────────────────────── 切分 / 处理 ─────────────────────────
  // 记录帖子的分类（包括忽略类），供分类面板展示；同步命中缓存时也要补上
  function recordVerdicts(pg, topics) {
    if (!state.CL || !topics || !topics.length) return;
    if (!state.jevVerdicts[pg.key]) state.jevVerdicts[pg.key] = new Map();
    var vmap = state.jevVerdicts[pg.key];
    topics.forEach(function (t) {
      if (!t || t.id == null) return;
      var rec = cacheGet(state.CL.key, t.id);
      if (rec === undefined) return;
      var c = state.CL.catByKey[(rec.a || {}).choice];
      vmap.set(t.id, { mode: c ? c.action : 'ignore', color: c ? c.color : '', name: c ? c.key : ((rec.a && rec.a.choice) || '未分类') });
    });
  }
  function splitTopics(topics, pg) {
    var highlighted = [], kept = [], filtered = [], pending = [], hlColors = new Map();
    (topics || []).forEach(function (t) {
      var d = jevDecide(t, pg);
      if (d === 'pending') { pending.push(t); kept.push(t); return; }
      if (!d) { kept.push(t); return; }
      if (d.mode === 'highlight') { highlighted.push(t); hlColors.set(t.id, d.color); }
      else filtered.push(t);
    });
    return { kept: kept, filtered: filtered, highlighted: highlighted, hlColors: hlColors, pending: pending };
  }
  function processTopicList(pg, obj) {
    if (!obj || !obj.topic_list || !Array.isArray(obj.topic_list.topics)) return null;
    if (!state.pageTopics[pg.key]) state.pageTopics[pg.key] = new Map();
    var seen = state.pageTopics[pg.key];
    obj.topic_list.topics.forEach(function (t) { if (t && t.id != null) seen.set(t.id, t); });
    while (seen.size > 2000) { var oldest = seen.keys().next().value; seen.delete(oldest); }
    // 记录 topic_list.users，用于把 posters 里的 user_id 解析成昵称
    if (obj.topic_list.users && Array.isArray(obj.topic_list.users)) {
      obj.topic_list.users.forEach(function (u) { if (u && u.id != null) state.users[u.id] = u; });
    }
    var allTopics = obj.topic_list.topics;
    var sp = splitTopics(allTopics, pg);
    if (sp.filtered.length) bucketAddMany(pg.key, sp.filtered);
    recordVerdicts(pg, allTopics);
    obj.topic_list.topics = sp.highlighted.concat(sp.kept);
    if (sp.hlColors.size) {
      if (!state.pageHighlights[pg.key]) state.pageHighlights[pg.key] = new Map();
      sp.hlColors.forEach(function (color, id) { state.pageHighlights[pg.key].set(id, color); });
    }
    if (sp.pending.length) jevSchedule(pg, sp.pending);
    return sp;
  }
  function rescanCurrentPage() {
    var pg = state.currentPage;
    if (!pg || !isFilterablePage(pg)) return;
    var seen = state.pageTopics[pg.key];
    if (!seen || !seen.size) return;
    var topics = []; seen.forEach(function (t) { topics.push(t); });
    var sp = splitTopics(topics, pg);
    if (sp.filtered.length) {
      bucketAddMany(pg.key, sp.filtered);
      recordVerdicts(pg, topics);
      pendingSelfEmpty = bucketCount();
    }
    if (sp.hlColors.size) {
      if (!state.pageHighlights[pg.key]) state.pageHighlights[pg.key] = new Map();
      sp.hlColors.forEach(function (color, id) { state.pageHighlights[pg.key].set(id, color); });
    }
    applyJevVerdictsToDom();
    tryApplyHighlights();
    if (sp.pending.length) jevSchedule(pg, sp.pending);
    tryRenderSelfEmpty();
    updateCount();
  }

  // ───────────────────────── 拦截 ─────────────────────────
  function shouldIntercept(url) {
    var pg = pageContext(url);
    if (!isFilterablePage(pg)) return null;
    if (!pageHasActiveRule(pg)) return null;
    return pg;
  }
  function bodyLooksLikeTopicList(text) { return !!text && text.indexOf('"topic_list"') !== -1 && text.indexOf('"topics"') !== -1; }
  function syncCurrentPage() { state.currentPage = pageContext(location.href); }

  // ───────────────────────── fetch hook ─────────────────────────
  var _fetch = window.fetch;
  if (typeof _fetch === 'function') {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url) ? input.url : '';
      var pg = shouldIntercept(url);
      if (!pg) return _fetch.apply(this, arguments);
      return _fetch.apply(this, arguments).then(function (resp) {
        var ct = resp.headers.get('content-type') || '';
        if (ct.indexOf('json') === -1) return resp;
        return resp.clone().text().then(function (text) {
          if (!bodyLooksLikeTopicList(text)) return resp;
          try {
            var obj = JSON.parse(text);
            var sp = processTopicList(pg, obj);
            if (!sp) return resp;
            var rewriter = new Response(JSON.stringify(obj), { status: resp.status, statusText: resp.statusText, headers: resp.headers });
            if (state.currentPage && pg.key === state.currentPage.key) selfEmptyGuard(sp);
            return rewriter;
          } catch (e) { err('fetch 处理失败', e); return resp; }
        });
      });
    };
  }

  // ───────────────────────── XHR hook ─────────────────────────
  try {
    if (typeof XMLHttpRequest === 'undefined') throw new Error('环境无 XMLHttpRequest');
    var _open = XMLHttpRequest.prototype.open;
    var _send = XMLHttpRequest.prototype.send;
    var descText = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
    var descResp = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
    XMLHttpRequest.prototype.open = function (method, url) { this.__ldj_url = url; this.__ldj_done = false; return _open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      var pg = shouldIntercept(xhr.__ldj_url || '');
      if (pg && descText) {
        var install = function () {
          if (xhr.__ldj_done) return; xhr.__ldj_done = true;
          try {
            Object.defineProperty(xhr, 'responseText', {
              get: function () {
                var orig = descText.get.call(xhr);
                if (xhr.__ldj_cached !== undefined) return xhr.__ldj_cached;
                if (!bodyLooksLikeTopicList(orig)) { xhr.__ldj_cached = orig; return orig; }
                try {
                  var obj = JSON.parse(orig);
                  var sp = processTopicList(pg, obj);
                  if (!sp) { xhr.__ldj_cached = orig; return orig; }
                  xhr.__ldj_cached = JSON.stringify(obj);
                  if (state.currentPage && pg.key === state.currentPage.key) selfEmptyGuard(sp);
                  return xhr.__ldj_cached;
                } catch (e) { err('XHR 处理失败', e); xhr.__ldj_cached = orig; return orig; }
              }
            });
            if (descResp) Object.defineProperty(xhr, 'response', {
              get: function () { if (xhr.responseType === '' || xhr.responseType === 'text') return xhr.responseText; return descResp.get.call(xhr); }
            });
          } catch (e) { }
        };
        xhr.addEventListener('readystatechange', function () { if (xhr.readyState === 4) install(); });
      }
      return _send.apply(this, arguments);
    };
  } catch (e) { err('XHR hook 安装失败', e); }

  // ───────────────────────── 预载块 ─────────────────────────
  var preloadedRewritten = false;
  function rewritePreloaded(script) {
    if (!script || preloadedRewritten) return;
    var text = script.textContent;
    if (!text || text.indexOf('"topic_list"') === -1) return;
    try {
      var outer = JSON.parse(text);
      if (outer.site && typeof outer.site === 'string') { try { ensureCatMapFromSite(JSON.parse(outer.site)); } catch (e) { } }
      else if (outer.site && typeof outer.site === 'object') ensureCatMapFromSite(outer.site);
      reloadClassifier();
      var firstPg = pageContext(location.href);
      state.currentPage = firstPg;
      if (isFilterablePage(firstPg) && pageHasActiveRule(firstPg)) {
        if (outer.topic_list && typeof outer.topic_list === 'string') {
          var tl = JSON.parse(outer.topic_list);
          var sp = processTopicList(firstPg, tl);
          if (sp) { outer.topic_list = JSON.stringify(tl); selfEmptyGuard(sp); }
        }
      }
      script.textContent = JSON.stringify(outer);
      preloadedRewritten = true;
      log('预载块已改写，首屏：', firstPg.kind, firstPg.key);
    } catch (e) { err('预载块改写失败', e); }
  }

  var preObs = null;
  try {
    preObs = new MutationObserver(function (mutations) {
      if (preloadedRewritten) { if (preObs) preObs.disconnect(); return; }
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.id === 'data-preloaded' && node.tagName === 'SCRIPT') rewritePreloaded(node);
          else if (node.querySelectorAll) { var s = node.querySelector('script#data-preloaded'); if (s) rewritePreloaded(s); }
        }
      }
      if (preloadedRewritten && preObs) preObs.disconnect();
    });
    preObs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { err('预载 MO 安装失败', e); }

  document.addEventListener('DOMContentLoaded', function () {
    if (!preloadedRewritten) { var s = document.querySelector('script#data-preloaded'); if (s) rewritePreloaded(s); }
    if (preObs) preObs.disconnect();
    if (!state.catMap) ensureCatMapFallback().then(reloadClassifier);
    syncCurrentPage();
    bootUI();
  });

  // ───────────────────────── 自空护栏 ─────────────────────────
  var pendingSelfEmpty = 0;
  function selfEmptyGuard(sp) { if (sp.kept.length === 0 && sp.filtered.length > 0) pendingSelfEmpty = sp.filtered.length; }
  function tryRenderSelfEmpty() {
    if (!pendingSelfEmpty) return;
    if (!state.currentPage) return;
    var body = document.querySelector('.topic-list-body');
    if (!body) return;
    if (body.querySelector('.ldj-selfempty')) return;
    var rows = body.querySelectorAll('tr[data-topic-id], .topic-list-item');
    var visible = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.style.display === 'none') continue;
      if (r.classList.contains('ldj-jev-hidden')) continue;
      visible++;
    }
    if (visible > 0) return;
    var n = pendingSelfEmpty;
    var tr = document.createElement('tr');
    tr.className = 'ldj-selfempty';
    tr.innerHTML = '<td colspan="5" style="padding:24px;text-align:center;color:var(--primary-medium,#888)">本页 ' + n + ' 条主题已归入分类。<a href="#" class="ldj-open-filtered" style="margin-left:8px">按分类查看</a></td>';
    body.appendChild(tr);
    var a = tr.querySelector('.ldj-open-filtered');
    if (a) a.addEventListener('click', function (e) { e.preventDefault(); openDrawer(); });
    pendingSelfEmpty = 0;
  }

  // ───────────────────────── DOM 应用 ─────────────────────────
  function tryApplyHighlights() {
    if (!state.currentPage) return;
    var hlMap = state.pageHighlights[state.currentPage.key];
    if (!hlMap || !hlMap.size) return;
    document.querySelectorAll('.topic-list-body tr[data-topic-id]').forEach(function (tr) {
      var id = parseInt(tr.getAttribute('data-topic-id'), 10);
      var color = hlMap.get(id);
      if (color) {
        if (!tr.classList.contains('ldj-highlight')) tr.classList.add('ldj-highlight');
        tr.style.setProperty('--ldj-hl', color);
      }
    });
  }
  function applyJevVerdictsToDom() {
    if (!state.currentPage) return;
    var key = state.currentPage.key;
    var vmap = state.jevVerdicts[key];
    var prefix = key + ':';
    document.querySelectorAll('.topic-list-body tr[data-topic-id], .topic-list-body .topic-list-item[data-topic-id]').forEach(function (row) {
      var id = parseInt(row.getAttribute('data-topic-id'), 10);
      var v = vmap ? vmap.get(id) : null;
      if (v) {
        row.classList.remove('ldj-jev-pending');
        if (v.mode === 'filter') {
          row.classList.add('ldj-jev-hidden');
          row.classList.remove('ldj-highlight');
        } else if (v.mode === 'highlight') {
          row.classList.remove('ldj-jev-hidden');
          if (!row.classList.contains('ldj-highlight')) row.classList.add('ldj-highlight');
          row.style.setProperty('--ldj-hl', v.color || '#ffb000');
        } else {
          row.classList.remove('ldj-jev-hidden');
          row.classList.remove('ldj-highlight');
        }
        return;
      }
      row.classList.remove('ldj-jev-hidden');
      if (state.jevInflight[prefix + id] && !(state.cfg && state.cfg.dimPending === false)) row.classList.add('ldj-jev-pending');
      else row.classList.remove('ldj-jev-pending');
    });
  }

  // ───────────────────────── UI：顶栏 + 抽屉 ─────────────────────────
  var ui = { group: null, topBtn: null, drawer: null };
  var drawerCat = '';   // '' = 全部

  var GEAR_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  var ICON_UP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6"/><path d="M6 12l6-6 6 6"/><path d="M4 3h16"/></svg>';
  var ICON_DOWN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v13"/><path d="M6 12l6 6 6-6"/><path d="M4 21h16"/></svg>';

  function ensureTopBtn() {
    var cont = document.querySelector('.header-buttons, .d-header .icons, ul.d-header-icons');
    if (!cont || !state.currentPage || !isFilterablePage(state.currentPage)) {
      if (ui.group && ui.group.parentNode) ui.group.parentNode.removeChild(ui.group);
      return;
    }
    if (ui.group && ui.group.parentNode === cont) { updateCount(); return; }
    if (!ui.group) {
      if (document.querySelector('#ldj-header-group')) {
        ui.group = document.querySelector('#ldj-header-group');
        ui.topBtn = document.querySelector('#ldj-topbtn');
      } else {
        var group = document.createElement('div');
        group.id = 'ldj-header-group';
        var gear = document.createElement('button');
        gear.id = 'ldj-settings-btn'; gear.type = 'button'; gear.className = 'ldj-icon-btn';
        gear.title = 'Jev 过滤器设置'; gear.setAttribute('aria-label', 'Jev 过滤器设置');
        gear.innerHTML = GEAR_SVG;
        gear.addEventListener('click', function () { openModal(); });
        var btn = document.createElement('button');
        btn.id = 'ldj-topbtn'; btn.type = 'button'; btn.className = 'ldj-count-btn';
        btn.innerHTML = '<span class="ldj-count">分类 (0)</span>';
        btn.addEventListener('click', function () { toggleDrawer(); });
        group.appendChild(gear); group.appendChild(btn);
        ui.group = group; ui.topBtn = btn;
      }
    }
    cont.appendChild(ui.group);
    updateCount();
  }

  function buildDrawer() {
    if (ui.drawer) return ui.drawer;
    var el = document.createElement('div');
    el.id = 'ldj-drawer';
    el.style.display = 'none';
    el.innerHTML = '<div class="ldj-drawer-overlay"></div><div class="ldj-drawer-panel"><div class="ldj-drawer-header"><span class="ldj-drawer-title">分类 <b class="ldj-drawer-count">0</b></span><button class="ldj-drawer-close">×</button></div><div class="ldj-drawer-body"></div></div>';
    document.body.appendChild(el);
    ui.drawer = el;
    el.querySelector('.ldj-drawer-overlay').addEventListener('click', closeDrawer);
    el.querySelector('.ldj-drawer-close').addEventListener('click', closeDrawer);
    return el;
  }
  var savedBodyOverflow = null;
  function openDrawer() {
    buildDrawer(); renderDrawer();
    ui.drawer.style.display = 'block';
    if (savedBodyOverflow === null) savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(function () { ui.drawer.classList.add('ldj-drawer-open'); });
  }
  function closeDrawer() {
    if (!ui.drawer) return;
    ui.drawer.classList.remove('ldj-drawer-open');
    if (savedBodyOverflow !== null) { document.body.style.overflow = savedBodyOverflow; savedBodyOverflow = null; }
    setTimeout(function () { if (ui.drawer && !ui.drawer.classList.contains('ldj-drawer-open')) ui.drawer.style.display = 'none'; }, 220);
  }
  function toggleDrawer() { buildDrawer(); if (ui.drawer.classList.contains('ldj-drawer-open')) closeDrawer(); else openDrawer(); }

  function renderDrawer() {
    if (!ui.drawer) return;
    var body = ui.drawer.querySelector('.ldj-drawer-body');
    var countEl = ui.drawer.querySelector('.ldj-drawer-count');
    var pg = state.currentPage;
    var vmap = pg ? state.jevVerdicts[pg.key] : null;
    var tmap = pg ? state.pageTopics[pg.key] : null;
    var bmap = pg ? currentBucketMap() : null;
    var total = vmap ? vmap.size : 0;
    countEl.textContent = total;
    var groups = new Map();
    if (vmap) vmap.forEach(function (v, id) {
      var t = (tmap && tmap.get(id)) || (bmap && bmap.get(id));
      if (!t) return;
      var cat = v.name || '未分类';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(t);
    });
    // 分类顺序：先列分类表里的全部类别，再补上出现过的其他类别
    var catOrder = ((state.classifier && state.classifier.categories) || []).map(function (c) { return c.key; });
    groups.forEach(function (_, cat) { if (catOrder.indexOf(cat) < 0) catOrder.push(cat); });
    var html = '<div class="ldj-chips">';
    html += '<button type="button" class="ldj-chip' + (drawerCat === '' ? ' ldj-chip-on' : '') + '" data-cat="">全部<span class="ldj-chip-n">' + total + '</span></button>';
    catOrder.forEach(function (cat) {
      var n = (groups.get(cat) || []).length;
      html += '<button type="button" class="ldj-chip' + (drawerCat === cat ? ' ldj-chip-on' : '') + '" data-cat="' + escAttr(cat) + '">' + escHtml(cat) + '<span class="ldj-chip-n">' + n + '</span></button>';
    });
    html += '</div>';
    catOrder.forEach(function (cat) {
      var items = groups.get(cat) || [];
      html += '<div class="ldj-group" data-cat="' + escAttr(cat) + '"><div class="ldj-group-head">' + escHtml(cat) + '<span class="ldj-group-n">' + items.length + '</span></div>';
      if (items.length) items.forEach(function (t) { html += renderDrawerItem(t, cat); });
      else html += '<div class="ldj-group-empty">无</div>';
      html += '</div>';
    });
    if (!catOrder.length) html += '<div class="ldj-drawer-empty">还没有分类，先去设置里添加。</div>';
    body.innerHTML = html;
    body.querySelectorAll('.ldj-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        var c = b.getAttribute('data-cat') || '';
        drawerCat = (drawerCat === c) ? '' : c;
        renderDrawer();
      });
    });
    applyDrawerFilter();
  }
  function applyDrawerFilter() {
    if (!ui.drawer) return;
    ui.drawer.querySelectorAll('.ldj-group').forEach(function (g) {
      var show = !drawerCat || g.getAttribute('data-cat') === drawerCat;
      g.style.display = show ? '' : 'none';
    });
  }
  function renderDrawerItem(t, groupName) {
    var cat = state.catMap && state.catMap.id2.get(t.category_id);
    var catName = cat ? cat.name : ('#' + t.category_id);
    var catHref = cat ? ('/c/' + (cat.slug || ('category/' + t.category_id)) + '/' + t.category_id) : '#';
    var tags = (t.tags || []).map(function (x) { return '<a class="discourse-tag ldj-tag" href="/tag/' + encodeURIComponent(x.slug || x.name) + '">' + escHtml(x.name) + '</a>'; }).join(' ');
    var replies = Math.max(0, (t.posts_count ? t.posts_count - 1 : 0));
    var who = posterName(t);
    return '<div class="ldj-item"><a class="ldj-item-title" href="/t/topic/' + t.id + '/1">' + escHtml(t.title) + '</a><div class="ldj-item-meta"><a class="ldj-item-cat" href="' + catHref + '">' + escHtml(catName) + '</a>' + (tags ? ' · <span class="ldj-item-tags">' + tags + '</span>' : '') + '</div><div class="ldj-item-stats">' + (who ? (escHtml(who) + ' · ') : '') + '回复 ' + replies + ' · 浏览 ' + (t.views || 0) + '</div></div>';
  }
  function updateCount() {
    var n = classCount();
    var suffix = '';
    if (jevEnabled() && state.jevPending > 0) suffix = ' ⏳' + state.jevPending;
    else if (jevEnabled() && state.jevError) suffix = ' ⚠';
    var txt = '分类 (' + n + ')' + suffix;
    if (ui.topBtn) {
      var span = ui.topBtn.querySelector('.ldj-count');
      if (span && span.textContent !== txt) span.textContent = txt;
      ui.topBtn.title = (jevEnabled() && state.jevError) ? ('Jev 最近错误：' + state.jevError) : '按分类查看';
    }
    if (ui.drawer) { var c = ui.drawer.querySelector('.ldj-drawer-count'); if (c && c.textContent !== String(n)) c.textContent = n; }
  }

  // ───────────────────────── UI：设置弹窗 ─────────────────────────
  var modal = null, editView = null;

  function buildModal() {
    if (modal) return modal;
    var el = document.createElement('div');
    el.id = 'ldj-modal';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;display:none;align-items:flex-start;justify-content:center;padding:40px 16px 16px';
    el.innerHTML = '<div class="ldj-modal-box"><div id="ldj-view-list" class="ldj-view" style="display:none"></div><div id="ldj-view-cfg" class="ldj-view" style="display:none"></div></div>';
    document.body.appendChild(el);
    modal = el;
    return modal;
  }

  function catRowHtml(cat) {
    cat = cat || {};
    var action = cat.action === 'highlight' ? 'highlight' : (cat.action === 'filter' ? 'filter' : 'ignore');
    return '<div class="ldj-cat-row" data-cat>'
      + '<input type="text" data-f="key" placeholder="分类名" value="' + escAttr(cat.key || '') + '">'
      + '<input type="text" data-f="desc" placeholder="说明（判定边界）" value="' + escAttr(cat.desc || '') + '">'
      + '<select data-f="action">' + [['filter', '过滤'], ['highlight', '高亮'], ['ignore', '忽略']].map(function (o) { return '<option value="' + o[0] + '"' + (action === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>'
      + '<span class="ldj-cat-colorwrap" data-f="colorwrap"' + (action === 'highlight' ? '' : ' style="display:none"') + '><input type="color" data-f="color" value="' + escAttr(/^#[0-9a-f]{6}$/i.test(cat.color || '') ? cat.color : '#ffb000') + '" title="高亮颜色"></span>'
      + '<button type="button" class="ldj-cat-del" title="删除">✕</button>'
      + '</div>';
  }
  function renderCatRows(box, cats) {
    var wrap = box.querySelector('#ldj-cl-cats');
    if (wrap) wrap.innerHTML = (cats || []).map(catRowHtml).join('');
    bindCatRows(box);
  }
  function readCatRows(box) {
    var cats = [];
    box.querySelectorAll('#ldj-cl-cats .ldj-cat-row').forEach(function (row) {
      var val = function (f) { var el = row.querySelector('[data-f="' + f + '"]'); return el ? el.value : ''; };
      var key = (val('key') || '').trim();
      if (!key) return;
      var action = val('action') || 'ignore';
      cats.push({ key: key, desc: (val('desc') || '').trim(), action: action, color: action === 'highlight' ? val('color') : null });
    });
    return cats;
  }
  function bindCatRows(box) {
    box.querySelectorAll('#ldj-cl-cats .ldj-cat-row').forEach(function (row) {
      var act = row.querySelector('[data-f="action"]');
      var wrap = row.querySelector('[data-f="colorwrap"]');
      if (act && wrap) act.addEventListener('change', function () { wrap.style.display = (act.value === 'highlight') ? '' : 'none'; });
      var del = row.querySelector('.ldj-cat-del');
      if (del) del.addEventListener('click', function () { if (row.parentNode) row.parentNode.removeChild(row); });
    });
  }

  function renderListView() {
    editView = 'list';
    buildModal();
    modal.querySelector('#ldj-view-list').style.display = 'flex';
    modal.querySelector('#ldj-view-cfg').style.display = 'none';
    var box = modal.querySelector('#ldj-view-list');
    var c = state.classifier || defaultClassifier();
    var scopeType = (c.scope && c.scope.type) || 'global';
    var includeHome = (c.scope && c.scope.includeHome) ? 'checked' : '';
    box.innerHTML = ''
      + '<div class="ldj-modal-header"><div class="ldj-modal-titles"><div class="ldj-modal-title">Jev 分类</div></div><span class="ldj-close-icon" data-act="close" title="关闭">✕</span></div>'
      + '<div class="ldj-edit-body">'
      + '<div class="ldj-field"><label>状态</label><div class="ldj-segmented">'
      + '<label class="ldj-seg"><input type="radio" name="ldj-cl-status" value="active"' + ((c.status || 'active') === 'active' ? ' checked' : '') + '><span>启用</span></label>'
      + '<label class="ldj-seg"><input type="radio" name="ldj-cl-status" value="draft"' + (c.status === 'draft' ? ' checked' : '') + '><span>草稿</span></label>'
      + '</div></div>'
      + '<div class="ldj-field"><label>作用域</label><div class="ldj-segmented">'
      + '<label class="ldj-seg"><input type="radio" name="ldj-cl-scope" value="global"' + (scopeType === 'global' ? ' checked' : '') + '><span>全局</span></label>'
      + '<label class="ldj-seg"><input type="radio" name="ldj-cl-scope" value="home"' + (scopeType === 'home' ? ' checked' : '') + '><span>仅首页流</span></label>'
      + '<label class="ldj-seg"><input type="radio" name="ldj-cl-scope" value="category"' + (scopeType === 'category' ? ' checked' : '') + '><span>类别页</span></label>'
      + '</div><div id="ldj-cat-tree" class="ldj-cat-tree" style="display:' + (scopeType === 'category' ? 'block' : 'none') + '"><div class="ldj-cat-hint">勾选父类别自动含子孙</div>' + buildCatTreeHtml(c.scope) + '<label class="ldj-include-home"><input type="checkbox" id="ldj-include-home" ' + includeHome + '> 同时作用于首页流</label></div></div>'
      + '<div class="ldj-field"><label>问题（instructions）</label><textarea id="ldj-cl-instr">' + escHtml(c.instructions || '') + '</textarea></div>'
      + '<div class="ldj-field"><div class="ldj-label-row"><label>分类与动作</label><button type="button" class="ldj-btn-ghost ldj-btn-mini" id="ldj-cl-example">填充示例</button></div>'
      + '<div id="ldj-cl-cats">' + (c.categories || []).map(catRowHtml).join('') + '</div>'
      + '<button type="button" class="ldj-btn-ghost ldj-btn-mini" id="ldj-cl-add">+ 新增分类</button></div>'
      + '<div class="ldj-field"><label>测试</label><div class="ldj-pv-bar"><input type="text" id="ldj-cl-test-title" placeholder="标题"><button class="btn btn-primary" id="ldj-cl-test">测试</button></div><div class="ldj-test-result" id="ldj-cl-test-result"></div></div>'
      + '</div>'
      + '<div class="ldj-modal-footer"><div class="ldj-footer-left"><button id="ldj-cfg-open" class="ldj-icon-btn" title="Jev 设置">' + GEAR_SVG + '</button><button id="ldj-import" class="ldj-icon-btn" title="导入备份">' + ICON_UP + '</button><button id="ldj-export" class="ldj-icon-btn" title="导出备份">' + ICON_DOWN + '</button><input type="file" id="ldj-import-file" accept=".json,application/json" style="display:none"></div><div class="ldj-footer-btns"><button id="ldj-cl-save" class="btn btn-primary">保存</button></div></div>';
    bindClassifier(box);
  }

  function bindClassifier(box) {
    box.querySelector('.ldj-close-icon[data-act="close"]').addEventListener('click', function () { modal.style.display = 'none'; });
    box.querySelectorAll('input[name="ldj-cl-scope"]').forEach(function (r) {
      r.addEventListener('change', function () { box.querySelector('#ldj-cat-tree').style.display = (r.value === 'category' && r.checked) ? 'block' : 'none'; });
    });
    bindCatRows(box);
    box.querySelector('#ldj-cl-add').addEventListener('click', function () {
      var cats = readCatRows(box); cats.push({ key: '', desc: '', action: 'ignore' });
      renderCatRows(box, cats);
    });
    box.querySelector('#ldj-cl-example').addEventListener('click', function () {
      var d = defaultClassifier();
      box.querySelector('#ldj-cl-instr').value = d.instructions;
      renderCatRows(box, d.categories);
    });
    box.querySelector('#ldj-cl-test').addEventListener('click', function () { runClassifierTest(box); });
    box.querySelector('#ldj-cfg-open').addEventListener('click', function () { renderCfgView(); });
    box.querySelector('#ldj-export').addEventListener('click', exportRules);
    box.querySelector('#ldj-import').addEventListener('click', function () { box.querySelector('#ldj-import-file').click(); });
    box.querySelector('#ldj-import-file').addEventListener('change', importRules);
    box.querySelector('#ldj-cl-save').addEventListener('click', function () { if (saveClassifier(box)) renderListView(); });
  }

  function readClassifier(box) {
    var scopeType = box.querySelector('input[name="ldj-cl-scope"]:checked').value;
    var scope;
    if (scopeType === 'global') scope = { type: 'global' };
    else if (scopeType === 'home') scope = { type: 'home' };
    else {
      var ids = [];
      box.querySelectorAll('.ldj-cat-check:checked').forEach(function (cb) { ids.push(parseInt(cb.dataset.catId, 10)); });
      scope = { type: 'category', categoryIds: ids, includeHome: box.querySelector('#ldj-include-home').checked };
    }
    return {
      name: (state.classifier && state.classifier.name) || '分类',
      status: (box.querySelector('input[name="ldj-cl-status"]:checked') || {}).value || 'active',
      instructions: (box.querySelector('#ldj-cl-instr').value || '').trim(),
      scope: scope,
      categories: readCatRows(box)
    };
  }
  function saveClassifier(box) {
    var c = readClassifier(box);
    if (!c.instructions) { alert('请填写问题'); return false; }
    if (c.categories.length < 2) { alert('至少需要两个分类（含“其他”）'); return false; }
    state.classifier = c;
    persistClassifier();
    return true;
  }
  function persistClassifier() {
    gmSet(CLASSIFIER_KEY, state.classifier);
    reloadClassifier();
    rescanCurrentPage();
  }

  function buildCatTreeHtml(scope) {
    if (!state.catMap) return '<div class="ldj-cat-hint">类别映射未就绪</div>';
    var selected = new Set((scope && scope.categoryIds) || []);
    var roots = [];
    state.catMap.id2.forEach(function (c) { if (c.parentId === null) roots.push(c); });
    roots.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    var html = '<div class="ldj-cat-list">';
    roots.forEach(function (c) {
      html += '<label class="ldj-cat-item"><input type="checkbox" class="ldj-cat-check" data-cat-id="' + c.id + '" ' + (selected.has(c.id) ? 'checked' : '') + '> ' + escHtml(c.name) + '</label>';
    });
    return html + '</div>';
  }

  function runClassifierTest(box) {
    var out = box.querySelector('#ldj-cl-test-result');
    if (!state.cfg.apiKey) { out.textContent = '请先在 Jev 设置里填 API Key。'; return; }
    var c = readClassifier(box);
    if (!c.instructions || c.categories.length < 2) { out.textContent = '请先填问题和至少两个分类。'; return; }
    var criteria = {};
    c.categories.forEach(function (cat) { criteria[cat.key] = cat.desc || null; });
    var title = (box.querySelector('#ldj-cl-test-title').value || '').trim() || '测试标题：低价出售闲置物品，联系微信';
    var t = { id: -1, title: title, tags: [], category_id: null };
    var q = { type: 'choice', instructions: { post: jevStateOf(t), question: c.instructions }, criteria: criteria };
    out.textContent = '请求中… ' + state.cfg.model;
    jevPost({ model: state.cfg.model, state: JEV_BATCH_STATE, questions: { q0: q } }).then(function (json) {
      jevRecord('测试响应', json.model || state.cfg.model, json);
      var a = (json.answers || {}).q0;
      var chosen = a && a.choice, cat = null;
      c.categories.forEach(function (x) { if (x.key === chosen) cat = x; });
      var act = cat ? ({ filter: '过滤', highlight: '高亮', ignore: '忽略' }[cat.action] || cat.action) : '未匹配分类';
      out.textContent = '回答：' + JSON.stringify(a) + '\n分类：' + (chosen || '?') + ' → ' + act + '\n\n' + JSON.stringify(json, null, 2);
    }, function (e) { out.textContent = '请求失败：' + ((e && e.message) || e); });
  }

  // ───────────────────────── Jev 设置 ─────────────────────────
  function jevLogHtml() {
    if (!state.jevLog.length) return '<div class="ldj-pv-idle">暂无记录；判定或测试后会显示在这里。</div>';
    return state.jevLog.map(function (r) {
      var d = new Date(r.t);
      var hh = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
      return '<div class="ldj-log-item"><div class="ldj-log-head">' + hh + ' · ' + escHtml(r.kind) + (r.model ? ' · ' + escHtml(r.model) : '') + '</div><pre>' + escHtml(trimText(r.text, 4000)) + '</pre></div>';
    }).join('');
  }
  function refreshJevLog() {
    if (editView !== 'cfg' || !modal) return;
    var el = modal.querySelector('#ldj-log');
    if (el) el.innerHTML = jevLogHtml();
  }

  function pickModelValue(cfg) { return (cfg.providerKey || '') + '|' + (cfg.model || ''); }
  function selectedUnion(box) {
    var sel = box.querySelector('#ldj-model-union');
    if (!sel || !sel.options) return null;
    var opt = sel.options[sel.selectedIndex];
    if (!opt || !opt.getAttribute || !opt.getAttribute('data-k')) return null;
    return { key: opt.getAttribute('data-k'), id: opt.getAttribute('data-m') };
  }
  function authModeOf(p) {
    var h = p.authHeader || 'Authorization';
    var pre = (p.authPrefix == null) ? 'Bearer ' : p.authPrefix;
    if (h === 'Authorization' && pre === 'Bearer ') return 'bearer';
    if (h === 'x-api-key' && pre === '') return 'xapikey';
    if (h === 'Authorization' && pre === '') return 'rawauth';
    return 'custom';
  }
  function authFromMode(mode, scopeEl) {
    if (mode === 'bearer') return { authHeader: 'Authorization', authPrefix: 'Bearer ' };
    if (mode === 'xapikey') return { authHeader: 'x-api-key', authPrefix: '' };
    if (mode === 'rawauth') return { authHeader: 'Authorization', authPrefix: '' };
    var h = scopeEl.querySelector('[data-f="authHeader"]');
    var pre = scopeEl.querySelector('[data-f="authPrefix"]');
    return { authHeader: (h && h.value.trim()) || 'Authorization', authPrefix: pre ? pre.value : 'Bearer ' };
  }
  function providerKeys(cfg) {
    var keys = Object.keys(JEV_PROVIDERS).filter(function (k) { return k !== 'custom'; });
    Object.keys(cfg.providers || {}).forEach(function (k) { if (!JEV_PROVIDERS[k] && keys.indexOf(k) === -1) keys.push(k); });
    return keys;
  }
  function providerCardHtml(cfg, key) {
    var pc = providerConf(cfg, key);
    var def = JEV_PROVIDERS[key];
    var count = providerModels(cfg, key).length;
    var head, body;
    if (def) {
      head = '<label class="ldj-card-check"><input type="checkbox" data-f="enabled"' + (pc.enabled ? ' checked' : '') + '><span class="ldj-card-title">' + escHtml(def.label) + '</span></label>';
      body = '<div class="ldj-card-sub">' + escHtml(def.baseUrl) + ' · /' + escHtml(def.endpoint) + '</div>'
        + '<input type="password" data-f="apiKey" placeholder="API Key" value="' + escAttr(pc.apiKey || '') + '" autocomplete="off">';
    } else {
      head = '<label class="ldj-card-check"><input type="checkbox" data-f="enabled"' + (pc.enabled ? ' checked' : '') + '></label>'
        + '<input type="text" class="ldj-card-name" data-f="name" placeholder="名称" value="' + escAttr(pc.name || '自定义') + '">'
        + '<button class="ldj-btn-ghost ldj-btn-mini ldj-del-provider" data-key="' + escAttr(key) + '" title="删除">✕</button>';
      var am = authModeOf(pc);
      var ep = pc.endpoint || (pc.apiStyle === 'vercel' ? 'v1/evaluate' : 'v1/systemone');
      body = '<div class="ldj-card-grid">'
        + '<input type="text" data-f="baseUrl" placeholder="Base URL" value="' + escAttr(pc.baseUrl || '') + '">'
        + '<input type="text" data-f="endpoint" placeholder="/v1/systemone" value="' + escAttr(ep) + '">'
        + '<select data-f="authMode">' + [['bearer', 'Authorization: Bearer'], ['xapikey', 'x-api-key'], ['rawauth', 'Authorization:'], ['custom', '自定义…']].map(function (o) { return '<option value="' + o[0] + '"' + (am === o[0] ? ' selected' : '') + '>' + escHtml(o[1]) + '</option>'; }).join('') + '</select>'
        + '<input type="password" data-f="apiKey" placeholder="API Key（可空）" value="' + escAttr(pc.apiKey || '') + '" autocomplete="off">'
        + '<div class="ldj-row-2 full" data-f="authCustom" style="display:' + (am === 'custom' ? 'flex' : 'none') + '"><input type="text" data-f="authHeader" placeholder="头名称" value="' + escAttr(pc.authHeader || 'Authorization') + '"><input type="text" data-f="authPrefix" placeholder="前缀" value="' + escAttr(pc.authPrefix == null ? 'Bearer ' : pc.authPrefix) + '"></div>'
        + '<textarea class="full" data-f="extraHeaders" placeholder="额外请求头 JSON">' + escHtml(pc.extraHeaders || '') + '</textarea>'
        + '</div>';
    }
    return '<div class="ldj-card' + (pc.enabled ? ' ldj-card-on' : '') + (def ? '' : ' ldj-card-custom') + '" data-key="' + escAttr(key) + '">'
      + '<div class="ldj-card-head">' + head + '</div>' + body
      + '<div class="ldj-card-foot"><button class="ldj-btn-ghost ldj-btn-mini ldj-pull" data-key="' + escAttr(key) + '">拉取模型</button><span class="ldj-count" data-count="' + escAttr(key) + '">' + (count ? (count + ' 个') : '未拉取') + '</span></div>'
      + '</div>';
  }
  function renderUnionOptions(box) {
    var sel = box.querySelector('#ldj-model-union');
    if (!sel) return;
    var q = (modelFilterText || '').trim().toLowerCase();
    var list = modelUnion(state.cfg);
    if (q) list = list.filter(function (o) { return String(o.id).toLowerCase().indexOf(q) !== -1 || String(o.label).toLowerCase().indexOf(q) !== -1; });
    if (!list.length) {
      sel.innerHTML = '<option value="">None</option>';
      return;
    }
    var cur = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === state.cfg.providerKey && list[i].id === state.cfg.model) { cur = i; break; }
    }
    if (cur === null) { cur = 0; state.cfg.providerKey = list[0].key; state.cfg.model = list[0].id; }
    sel.innerHTML = list.map(function (o, idx) {
      return '<option value="' + idx + '" data-k="' + escAttr(o.key) + '" data-m="' + escAttr(o.id) + '"' + (idx === cur ? ' selected' : '') + '>' + escHtml(o.id + '  ·  ' + o.label) + '</option>';
    }).join('');
    sel.selectedIndex = cur;
  }

  function renderCfgView() {
    editView = 'cfg';
    buildModal();
    modal.querySelector('#ldj-view-list').style.display = 'none';
    modal.querySelector('#ldj-view-cfg').style.display = 'none';
    var box = modal.querySelector('#ldj-view-cfg');
    box.style.display = 'flex';
    var c = state.cfg;
    var cards = providerKeys(c).map(function (k) { return providerCardHtml(c, k); }).join('');
    box.innerHTML = ''
      + '<div class="ldj-modal-header"><div class="ldj-modal-titles"><div class="ldj-modal-title">Jev 设置</div></div><span class="ldj-close-icon" data-act="back" title="返回列表">✕</span></div>'
      + '<div class="ldj-edit-body">'
      + '<div class="ldj-field"><label>供应商</label><div class="ldj-cards">' + cards + '</div><button class="ldj-btn-ghost ldj-btn-mini" id="ldj-add-provider">+ 添加自定义供应商</button></div>'
      + '<div class="ldj-field"><label>模型</label><input type="text" id="ldj-model-filter" placeholder="筛选模型…" value="' + escAttr(modelFilterText) + '"><select id="ldj-model-union" class="ldj-mt"></select></div>'
      + '<div class="ldj-field"><label>连通性诊断</label><button class="ldj-btn-ghost" id="ldj-diag-btn">测试选定模型</button><div class="ldj-test-result" id="ldj-diag"></div></div>'
      + '<div class="ldj-field"><label>每批帖子数</label><input type="number" id="ldj-batch" min="1" max="50" value="' + escAttr(c.batchSize || 10) + '"></div>'
      + '<div class="ldj-field"><label class="ldj-switch-line"><input type="checkbox" id="ldj-dim"' + (c.dimPending ? ' checked' : '') + '> 判定中的帖子暂时降低透明度</label></div>'
      + '<div class="ldj-field"><label>最近 Jev 响应（最近 50 条）</label><div class="ldj-log" id="ldj-log">' + jevLogHtml() + '</div><div><button class="ldj-btn-ghost ldj-btn-mini" id="ldj-log-clear">清空记录</button></div></div>'
      + '</div>'
      + '<div class="ldj-modal-footer"><span class="ldj-footer-hint">保存后立即重算当前页</span><div class="ldj-footer-btns"><button id="ldj-cfg-save" class="btn btn-primary">保存</button></div></div>';
    renderUnionOptions(box);
    bindCfgView(box);
  }

  function bindCfgView(box) {
    box.querySelector('.ldj-close-icon[data-act="back"]').addEventListener('click', function () { renderListView(); });
    box.querySelectorAll('.ldj-card').forEach(function (card) {
      var key = card.getAttribute('data-key');
      var am = card.querySelector('[data-f="authMode"]');
      if (am) am.addEventListener('change', function () {
        var cust = card.querySelector('[data-f="authCustom"]');
        if (cust) cust.style.display = (am.value === 'custom') ? 'flex' : 'none';
      });
      var en = card.querySelector('[data-f="enabled"]');
      if (en) en.addEventListener('change', function () {
        readCfgForm(box);
        card.classList.toggle('ldj-card-on', en.checked);
        renderUnionOptions(box);
      });
      var pull = card.querySelector('.ldj-pull');
      if (pull) pull.addEventListener('click', function () {
        readCfgForm(box);
        var p = resolveProvider(state.cfg, key);
        if (!p.baseUrl) { ldfToast('请先填 Base URL', 'err'); return; }
        pull.disabled = true;
        ldfToast('正在拉取「' + p.label + '」的模型…');
        jevFetchModels(p).then(function (list) {
          state.cfg.models[key] = list;
          var cnt = box.querySelector('[data-count="' + key + '"]');
          if (cnt) cnt.textContent = list.length + ' 个';
          renderUnionOptions(box);
          ldfToast(p.label + '：已拉取 ' + list.length + ' 个模型', 'ok');
        }).catch(function (e) { ldfToast(p.label + ' 拉取失败：' + ((e && e.message) || e), 'err'); })
          .then(function () { pull.disabled = false; });
      });
      var del = card.querySelector('.ldj-del-provider');
      if (del) del.addEventListener('click', function () {
        if (!confirm('删除该自定义供应商？')) return;
        readCfgForm(box);
        delete state.cfg.providers[key];
        delete state.cfg.models[key];
        if (state.cfg.providerKey === key) state.cfg.providerKey = 'typesafe';
        renderCfgView();
      });
    });
    box.querySelector('#ldj-add-provider').addEventListener('click', function () {
      readCfgForm(box);
      var key = 'custom_' + Date.now().toString(36);
      state.cfg.providers[key] = { enabled: true, apiKey: '', name: '自定义', baseUrl: '', endpoint: 'v1/systemone', authHeader: 'Authorization', authPrefix: 'Bearer ', extraHeaders: '' };
      state.cfg.models[key] = [];
      renderCfgView();
    });
    box.querySelector('#ldj-model-filter').addEventListener('input', function () {
      modelFilterText = box.querySelector('#ldj-model-filter').value || '';
      renderUnionOptions(box);
    });
    box.querySelector('#ldj-model-union').addEventListener('change', function () {
      var sp = selectedUnion(box);
      if (sp) { state.cfg.providerKey = sp.key; state.cfg.model = sp.id; }
    });
    box.querySelector('#ldj-diag-btn').addEventListener('click', function () { runDiag(box); });
    box.querySelector('#ldj-log-clear').addEventListener('click', function () { state.jevLog = []; refreshJevLog(); });
    box.querySelector('#ldj-cfg-save').addEventListener('click', function () { readCfgForm(box); saveCfg(); renderListView(); });
  }

  function runDiag(box) {
    var out = box.querySelector('#ldj-diag');
    readCfgForm(box);
    var cfg = state.cfg;
    var p = resolveProvider(cfg, cfg.providerKey);
    var lines = [];
    lines.push('供应商：' + p.label + (p.custom ? '（自定义）' : ''));
    lines.push('模型：' + cfg.model);
    lines.push('请求：POST ' + joinUrl(p.baseUrl || '', jevEndpointPath(cfg)));
    if (cfg.apiKey) {
      lines.push('认证头：' + (cfg.authHeader || 'Authorization') + ': ' + ((cfg.authPrefix == null ? 'Bearer ' : cfg.authPrefix)) + cfg.apiKey.slice(0, 6) + '…');
      if (/openrouter/i.test(p.baseUrl || '') && !/^sk-or-/.test(cfg.apiKey)) lines.push('⚠ OpenRouter 的 Key 应以 sk-or-v1- 开头');
    } else {
      lines.push('认证头：（未填 Key，不会发送认证头）');
    }
    lines.push('GM_xmlhttpRequest：' + (typeof GM_xmlhttpRequest === 'function' ? '可用' : '不可用（将用 fetch）'));
    out.textContent = lines.join('\n') + '\n\n测试中…';
    var q = { q0: jevQuestionOf({ qtype: 'noul', instructions: 'Does this text say it is a test?', criteria: {} }) };
    jevPost({ model: cfg.model, state: 'This is a test message.', questions: q }, cfg)
      .then(function (json) { lines.push('判定 ✓ ' + JSON.stringify((json.answers && json.answers.q0) || json)); out.textContent = lines.join('\n'); },
        function (e) { lines.push('判定 ✗ ' + ((e && e.message) || e)); out.textContent = lines.join('\n'); });
  }

  function readCfgForm(box) {
    var cfg = state.cfg;
    var providers = {};
    box.querySelectorAll('.ldj-card').forEach(function (card) {
      var key = card.getAttribute('data-key');
      if (!key) return;
      var val = function (f) { var el = card.querySelector('[data-f="' + f + '"]'); return el ? el.value : undefined; };
      var en = card.querySelector('[data-f="enabled"]');
      var pc = { enabled: en ? en.checked : false, apiKey: (val('apiKey') || '').trim() };
      if (!JEV_PROVIDERS[key]) {
        pc.name = (val('name') || '').trim() || '自定义';
        pc.baseUrl = (val('baseUrl') || '').trim();
        pc.endpoint = (val('endpoint') || '').trim() || 'v1/systemone';
        var af = authFromMode(val('authMode') || 'bearer', card);
        pc.authHeader = af.authHeader;
        pc.authPrefix = af.authPrefix;
        pc.extraHeaders = (val('extraHeaders') || '').trim();
      }
      providers[key] = pc;
    });
    cfg.providers = providers;
    var sel = box.querySelector('#ldj-model-union');
    var su = selectedUnion(box);
    if (su) { cfg.providerKey = su.key; cfg.model = su.id; }
    cfg.dimPending = box.querySelector('#ldj-dim').checked;
    cfg.batchSize = clampInt(box.querySelector('#ldj-batch').value, 1, 50, 10);
    applyActiveProvider(cfg, cfg.providerKey, cfg.model);
    return cfg;
  }

  // ───────────────────────── 导入 / 导出 ─────────────────────────
  // 导出：分类 + 供应商设置（含 Key、模型）全部持久化内容
  function exportCfg() {
    var c = state.cfg || {};
    return {
      batchSize: c.batchSize,
      dimPending: c.dimPending,
      providerKey: c.providerKey,
      model: c.model,
      providers: c.providers || {},
      models: c.models || {}
    };
  }
  function exportRules() {
    var data = {
      type: 'linuxdo-jev-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      classifier: state.classifier || defaultClassifier(),
      cfg: exportCfg()
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'linuxdo-jev-backup.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }
  function importRules(evt) {
    var file = evt.target.files && evt.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        var done = [];
        if (data && data.type === 'linuxdo-jev-backup') {
          if (data.cfg && typeof data.cfg === 'object') { state.cfg = cfgFromSaved(data.cfg); gmSet(CFG_KEY, state.cfg); done.push('供应商设置'); }
          if (data.classifier && Array.isArray(data.classifier.categories)) { state.classifier = normClassifier(data.classifier); gmSet(CLASSIFIER_KEY, state.classifier); done.push('分类'); }
        } else if (data && Array.isArray(data.categories)) {
          state.classifier = normClassifier(data); gmSet(CLASSIFIER_KEY, state.classifier); done.push('分类');
        } else if (Array.isArray(data)) {
          var c = classifierFromRules(data);
          if (!c) throw new Error('旧规则数组无法转换成分类');
          state.classifier = c; gmSet(CLASSIFIER_KEY, state.classifier); done.push('分类（旧规则迁移）');
        } else {
          throw new Error('无法识别的文件格式');
        }
        if (!done.length) throw new Error('文件里没有可用内容');
        reloadClassifier();
        applyActiveProvider(state.cfg, state.cfg.providerKey, state.cfg.model);
        rescanCurrentPage();
        renderListView();
        alert('已导入：' + done.join(' + ') + '。');
      } catch (e) { alert('导入失败：' + e.message); }
    };
    reader.readAsText(file);
    evt.target.value = '';
  }

  function openModal() { buildModal(); renderListView(); modal.style.display = 'flex'; }
  function openCfg() { buildModal(); renderCfgView(); modal.style.display = 'flex'; }

  // ───────────────────────── UI 启动 ─────────────────────────
  function bootUI() {
    var css = document.createElement('style');
    css.textContent = [
      '#ldj-modal,#ldj-drawer,#ldj-toast{--nb-bg:var(--secondary,#fff);--nb-soft:var(--primary-very-low,#f7f7f5);--nb-hover:var(--primary-low,#f1f1ef);--nb-fg:var(--primary,#37352f);--nb-muted:var(--primary-medium,#787774);--nb-faint:var(--primary-low-mid,#9b9a97);--nb-border:var(--primary-low,#e9e9e7);--nb-accent:#2383e2;--nb-accent-hover:#0b6bcb;--nb-danger:#eb5757}',
      '.ldj-highlight{background:color-mix(in srgb,var(--ldj-hl,#ffb000) 14%,transparent)!important;box-shadow:inset 3px 0 0 var(--ldj-hl,#ffb000)}',
      '.ldj-highlight:hover{background:color-mix(in srgb,var(--ldj-hl,#ffb000) 20%,transparent)!important}',
      '.ldj-jev-hidden{display:none!important}',
      '.ldj-jev-pending{opacity:.45}',
      '.ldj-hl-dot{display:inline-block;width:10px;height:10px;border-radius:3px;vertical-align:middle;box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)}',
      '#ldj-toast{position:fixed;right:20px;bottom:20px;z-index:100002;max-width:360px;padding:11px 14px;border-radius:8px;font-size:13.5px;line-height:1.5;color:var(--nb-fg);background:var(--nb-bg);border:1px solid var(--nb-border);box-shadow:0 8px 32px -8px rgba(15,15,15,.35);display:none;white-space:pre-wrap;word-break:break-word}',
      '#ldj-toast.ldj-toast-err{color:#fff;background:var(--nb-danger);border-color:transparent}',
      '#ldj-toast.ldj-toast-ok{color:#fff;background:#0f7b6c;border-color:transparent}',
      '#ldj-header-group{display:inline-flex;align-items:stretch;margin-left:6px;border:1px solid var(--nb-border);border-radius:6px;background:var(--secondary,#fff);overflow:hidden;height:28px}',
      '#ldj-settings-btn.ldj-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:34px;padding:0;border:none;background:transparent;color:var(--primary-medium,#888);cursor:pointer}',
      '#ldj-settings-btn.ldj-icon-btn:hover{background:var(--primary-low,#eee);color:var(--primary,#222)}',
      '#ldj-settings-btn.ldj-icon-btn svg{display:block}',
      '#ldj-topbtn.ldj-count-btn{display:inline-flex;align-items:center;padding:0 12px;border:none;border-left:1px solid var(--nb-border);background:transparent;color:var(--primary,#222);font-size:13.5px;white-space:nowrap;cursor:pointer}',
      '#ldj-topbtn.ldj-count-btn:hover{background:var(--primary-low,#eee)}',
      '#ldj-drawer{position:fixed;inset:0;z-index:100001;pointer-events:none}',
      '#ldj-drawer .ldj-drawer-overlay{position:absolute;inset:0;background:rgba(15,15,15,0);transition:background .18s;pointer-events:auto}',
      '#ldj-drawer .ldj-drawer-panel{position:absolute;top:0;right:0;height:100vh;width:440px;max-width:92vw;background:var(--nb-bg);color:var(--nb-fg);box-shadow:-12px 0 40px -12px rgba(15,15,15,.4);transform:translateX(100%);transition:transform .2s ease;display:flex;flex-direction:column;overflow:hidden}',
      '#ldj-drawer.ldj-drawer-open{pointer-events:auto}',
      '#ldj-drawer.ldj-drawer-open .ldj-drawer-overlay{background:rgba(15,15,15,.4)}',
      '#ldj-drawer.ldj-drawer-open .ldj-drawer-panel{transform:translateX(0)}',
      '.ldj-drawer-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;flex-shrink:0}',
      '.ldj-drawer-title{font-size:15px;font-weight:600}.ldj-drawer-count{color:var(--nb-muted);font-weight:400}',
      '.ldj-drawer-close{background:none;border:none;font-size:20px;cursor:pointer;color:var(--nb-faint);padding:2px 6px;border-radius:5px;line-height:1}',
      '.ldj-drawer-close:hover{background:var(--nb-hover);color:var(--nb-fg)}',
      '.ldj-chips{display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px 6px;position:sticky;top:0;background:var(--nb-bg);z-index:1}',
      '.ldj-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 11px;font:inherit;font-size:12.5px;color:var(--nb-muted);background:var(--nb-soft);border:1px solid transparent;border-radius:999px;cursor:pointer;transition:background .12s,color .12s}',
      '.ldj-chip:hover{background:var(--nb-hover);color:var(--nb-fg)}',
      '.ldj-chip.ldj-chip-on{background:var(--nb-accent);color:#fff}',
      '.ldj-chip-n{font-size:11px;color:var(--nb-faint)}',
      '.ldj-chip.ldj-chip-on .ldj-chip-n{color:rgba(255,255,255,.85)}',
      '.ldj-group{margin-bottom:4px}',
      '.ldj-group-head{padding:8px 14px 4px;font-size:12px;font-weight:600;color:var(--nb-muted);letter-spacing:.02em;display:flex;align-items:center;gap:6px}',
      '.ldj-group-n{font-weight:400;color:var(--nb-faint)}',
      '.ldj-group-empty{padding:0 14px 8px;font-size:12.5px;color:var(--nb-faint)}',
      '.ldj-drawer-body{flex:1;overflow-y:auto;padding:4px 8px 12px}',
      '.ldj-drawer-empty{padding:48px 20px;text-align:center;color:var(--nb-muted);font-size:13.5px}',
      '.ldj-item{padding:10px 12px;border-radius:6px;margin-bottom:2px}',
      '.ldj-item:hover{background:var(--nb-soft)}',
      '.ldj-item-title{display:block;font-size:14px;color:var(--nb-fg);text-decoration:none;margin-bottom:4px;font-weight:500}',
      '.ldj-item-title:hover{color:var(--nb-accent)}',
      '.ldj-item-meta{font-size:12.5px;color:var(--nb-muted);margin-bottom:2px}',
      '.ldj-item-cat{color:var(--nb-accent);text-decoration:none}',
      '.ldj-item-stats{font-size:12px;color:var(--nb-faint)}',
      '.ldj-tag{display:inline-block;background:var(--nb-hover);color:var(--nb-muted);border-radius:3px;padding:1px 6px;font-size:11.5px;text-decoration:none}',
      '#ldj-modal .ldj-modal-box{background:var(--nb-bg);color:var(--nb-fg);width:760px;max-width:100%;max-height:88vh;border-radius:10px;border:1px solid var(--nb-border);box-shadow:0 0 0 1px rgba(15,15,15,.02),0 20px 60px -16px rgba(15,15,15,.5);overflow:hidden;display:flex;flex-direction:column;font-family:inherit;font-size:14px;line-height:1.5}',
      '#ldj-modal .ldj-view{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
      '#ldj-modal .ldj-modal-header{padding:16px 20px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '#ldj-modal .ldj-modal-title{font-size:16px;font-weight:600;letter-spacing:-.01em}',
      '#ldj-modal .ldj-modal-sub{font-size:12.5px;color:var(--nb-muted);margin-top:2px}',
      '#ldj-modal .ldj-close-icon{cursor:pointer;font-size:15px;color:var(--nb-faint);line-height:1;padding:5px 7px;border-radius:5px;user-select:none}',
      '#ldj-modal .ldj-close-icon:hover{color:var(--nb-fg);background:var(--nb-hover)}',
      '#ldj-modal .ldj-modal-footer{padding:12px 20px;border-top:1px solid var(--nb-border);display:flex;justify-content:space-between;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap}',
      '#ldj-modal .ldj-footer-hint{font-size:12.5px;color:var(--nb-muted)}',
      '#ldj-modal .ldj-footer-btns{display:flex;gap:8px}',
      '#ldj-modal .ldj-edit-body{flex:1;overflow-y:auto;padding:8px 20px 20px}',
      '#ldj-modal .btn,#ldj-modal .ldj-btn-ghost{font:inherit;font-size:13.5px;line-height:1.3;padding:6px 12px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--nb-fg);cursor:pointer;transition:background .12s,color .12s;white-space:nowrap}',
      '#ldj-modal .ldj-btn-ghost:hover,#ldj-modal .btn:not(.btn-primary):hover{background:var(--nb-hover)}',
      '#ldj-modal .btn-primary{background:var(--nb-accent);color:#fff;border-color:transparent}',
      '#ldj-modal .btn-primary:hover{background:var(--nb-accent-hover)}',
      '#ldj-modal .ldj-btn-ghost.ldj-on{color:var(--nb-accent)}',
      '#ldj-modal .ldj-btn-mini{font-size:12.5px;padding:3px 9px}',
      '#ldj-modal .ldj-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:none;background:transparent;border-radius:6px;color:var(--nb-muted);cursor:pointer;transition:background .12s,color .12s}',
      '#ldj-modal .ldj-icon-btn:hover{background:var(--nb-hover);color:var(--nb-fg)}',
      '#ldj-modal .ldj-icon-btn svg{display:block}',
      '#ldj-modal .ldj-footer-left{display:flex;align-items:center;gap:6px}',
      '#ldj-modal .ldj-field{margin-bottom:16px}',
      '#ldj-modal .ldj-field>label{display:block;font-weight:500;font-size:13px;color:var(--nb-muted);margin-bottom:6px}',
      '#ldj-modal .ldj-field input[type=text],#ldj-modal .ldj-field input[type=password],#ldj-modal .ldj-field input[type=number],#ldj-modal .ldj-field textarea,#ldj-modal .ldj-field select,#ldj-modal .ldj-card input,#ldj-modal .ldj-card select,#ldj-modal .ldj-card textarea,#ldj-modal .ldj-cat-row input,#ldj-modal .ldj-cat-row select{width:100%;box-sizing:border-box;padding:6px 10px;font:inherit;font-size:13.5px;line-height:1.4;color:var(--nb-fg);background:var(--nb-bg);border:1px solid var(--nb-border);border-radius:6px;transition:border-color .12s,box-shadow .12s}',
      '#ldj-modal input::placeholder,#ldj-modal textarea::placeholder{color:var(--nb-faint)}',
      '#ldj-modal .ldj-field input:focus,#ldj-modal .ldj-field textarea:focus,#ldj-modal .ldj-field select:focus,#ldj-modal .ldj-card input:focus,#ldj-modal .ldj-card select:focus,#ldj-modal .ldj-card textarea:focus,#ldj-modal .ldj-cat-row input:focus,#ldj-modal .ldj-cat-row select:focus{outline:none;border-color:var(--nb-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--nb-accent) 18%,transparent)}',
      '#ldj-modal .ldj-field textarea{font-family:inherit;min-height:76px;resize:vertical}',
      '#ldj-modal .ldj-field input[type=color]{width:40px;height:30px;padding:2px;border:1px solid var(--nb-border);border-radius:6px;background:var(--nb-bg);cursor:pointer}',
      '#ldj-modal .ldj-note{font-size:12.5px;color:var(--nb-muted);margin-top:6px;line-height:1.6}',
      '#ldj-modal .ldj-row-2{display:flex;gap:12px}',
      '#ldj-modal .ldj-row-2>*{flex:1;min-width:0}',
      '#ldj-modal .ldj-inline{display:flex;gap:8px;align-items:stretch}',
      '#ldj-modal .ldj-inline>input,#ldj-modal .ldj-inline>select{flex:1;min-width:0}',
      '#ldj-modal .ldj-mt{margin-top:10px;display:block}',
      '#ldj-modal .ldj-label-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}',
      '#ldj-modal .ldj-label-row>label{margin:0}',
      '#ldj-modal .ldj-segmented{display:inline-flex;gap:2px;padding:2px;background:var(--nb-hover);border-radius:7px}',
      '#ldj-modal .ldj-seg{position:relative;display:flex;cursor:pointer}',
      '#ldj-modal .ldj-seg input{position:absolute;opacity:0;width:0;height:0;margin:0}',
      '#ldj-modal .ldj-seg span{display:flex;align-items:center;padding:4px 12px;font-size:13px;color:var(--nb-muted);border-radius:5px;white-space:nowrap;transition:background .12s,color .12s}',
      '#ldj-modal .ldj-seg span:hover{color:var(--nb-fg)}',
      '#ldj-modal .ldj-seg input:checked+span{background:var(--nb-bg);color:var(--nb-fg);font-weight:500;box-shadow:0 1px 2px rgba(15,15,15,.12)}',
      '#ldj-modal .ldj-field>label.ldj-switch-line{display:flex;align-items:center;gap:8px;font-size:13.5px;color:var(--nb-fg);font-weight:400;cursor:pointer;margin-bottom:0}',
      '#ldj-modal .ldj-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;align-items:stretch}',
      '#ldj-modal .ldj-card{border:1px solid var(--nb-border);border-radius:10px;padding:13px;display:flex;flex-direction:column;gap:9px;background:var(--nb-bg);min-width:0;height:100%;box-sizing:border-box;transition:border-color .12s,background .12s}',
      '#ldj-modal .ldj-card:hover{background:var(--nb-soft)}',
      '#ldj-modal .ldj-card.ldj-card-on{border-color:var(--nb-accent);background:color-mix(in srgb,var(--nb-accent) 6%,var(--nb-bg))}',
      '#ldj-modal .ldj-card-custom{grid-column:1/-1}',
      '#ldj-modal .ldj-card-head{display:flex;align-items:center;gap:8px;min-width:0;min-height:20px}',
      '#ldj-modal .ldj-card-check{display:flex;align-items:center;gap:8px;margin:0;font-weight:500;font-size:13.5px;min-width:0;cursor:pointer;color:var(--nb-fg)}',
      '#ldj-modal .ldj-card-check input[type=checkbox]{width:15px;height:15px;margin:0;flex-shrink:0;accent-color:var(--nb-accent)}',
      '#ldj-modal .ldj-card-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#ldj-modal .ldj-card-name{flex:1;min-width:0;padding:4px 8px;font-size:13.5px}',
      '#ldj-modal .ldj-card-sub{font-size:11.5px;line-height:1.4;color:var(--nb-faint);word-break:break-all;margin:0}',
      '#ldj-modal .ldj-card-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '#ldj-modal .ldj-card-grid .full{grid-column:1/-1}',
      '#ldj-modal .ldj-card textarea{min-height:46px;resize:vertical}',
      '#ldj-modal .ldj-card-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:2px}',
      '#ldj-modal .ldj-count{font-size:12px;color:var(--nb-faint);white-space:nowrap}',
      '#ldj-modal .ldj-cat-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.6fr) 104px auto 30px;column-gap:12px;row-gap:6px;align-items:center;margin-bottom:6px}',
      '#ldj-modal .ldj-cat-colorwrap{display:flex;align-items:center;justify-content:center}',
      '#ldj-modal .ldj-cat-row input[type=color]{width:40px;height:32px;padding:2px;flex-shrink:0}',
      '#ldj-modal .ldj-cat-del{border:none;background:transparent;color:var(--nb-faint);cursor:pointer;font-size:13px;padding:5px;border-radius:5px;line-height:1}',
      '#ldj-modal .ldj-cat-del:hover{color:var(--nb-danger);background:color-mix(in srgb,var(--nb-danger) 12%,transparent)}',
      '#ldj-modal .ldj-cat-tree{margin-top:10px;padding:12px;border:1px solid var(--nb-border);border-radius:8px;max-height:240px;overflow-y:auto;background:var(--nb-soft)}',
      '#ldj-modal .ldj-cat-hint{font-size:12px;color:var(--nb-muted);margin-bottom:8px}',
      '#ldj-modal .ldj-cat-list{display:flex;flex-wrap:wrap;gap:6px 14px}',
      '#ldj-modal .ldj-cat-item{font-size:13.5px;cursor:pointer;white-space:nowrap}',
      '#ldj-modal .ldj-include-home{display:block;margin-top:10px;padding-top:8px;border-top:1px solid var(--nb-border);font-size:13.5px;cursor:pointer}',
      '#ldj-modal .ldj-pv-bar{display:flex;gap:8px}',
      '#ldj-modal .ldj-pv-bar input[type=text]{flex:1;min-width:0}',
      '#ldj-modal .ldj-test-result{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;background:var(--nb-soft);border:1px solid var(--nb-border);border-radius:8px;padding:10px;margin-top:8px;color:var(--nb-fg)}',
      '#ldj-modal .ldj-test-result:empty{display:none}',
      '#ldj-modal .ldj-log{max-height:280px;overflow:auto;border:1px solid var(--nb-border);border-radius:8px;background:var(--nb-soft);padding:10px}',
      '#ldj-modal .ldj-log-item{margin-bottom:10px}',
      '#ldj-modal .ldj-log-head{font-size:12px;color:var(--nb-accent);font-weight:500;margin-bottom:3px}',
      '#ldj-modal .ldj-log pre{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--nb-fg)}',
      '#ldj-modal .ldj-pv-idle{color:var(--nb-muted);font-size:13px}',
      '#ldj-modal .ldj-switch{position:relative;display:inline-block;width:34px;height:20px;flex-shrink:0}',
      '#ldj-modal .ldj-switch input{opacity:0;width:0;height:0}',
      '#ldj-modal .ldj-slider{position:absolute;cursor:pointer;inset:0;background:var(--nb-hover);border-radius:20px;transition:.15s}',
      '#ldj-modal .ldj-slider:before{content:"";position:absolute;height:16px;width:16px;left:2px;top:2px;background:#fff;border-radius:50%;transition:.15s;box-shadow:0 1px 3px rgba(15,15,15,.3)}',
      '#ldj-modal .ldj-switch input:checked+.ldj-slider{background:var(--nb-accent)}',
      '#ldj-modal .ldj-switch input:checked+.ldj-slider:before{transform:translateX(14px)}',
    ].join('\n');
    document.head.appendChild(css);

    syncCurrentPage();
    ensureTopBtn();

    var mo = null, scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        if (!mo) return;
        var prevKey = state.currentPage ? state.currentPage.key : null;
        syncCurrentPage();
        ensureTopBtn();
        tryRenderSelfEmpty();
        tryApplyHighlights();
        applyJevVerdictsToDom();
        var curKey = state.currentPage ? state.currentPage.key : null;
        if (curKey !== prevKey) { updateCount(); if (ui.drawer && ui.drawer.classList.contains('ldj-drawer-open')) renderDrawer(); }
      });
    }
    try {
      mo = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.id && String(n.id).indexOf('ldj-') === 0) continue;
            if (n.classList && (n.classList.contains('ldj-selfempty') || n.classList.contains('ldj-item'))) continue;
            schedule();
            return;
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) { err('UI MO 安装失败', e); }

    try { GM_registerMenuCommand('设置', openModal); } catch (e) { }
    try { GM_registerMenuCommand('Jev 设置', openCfg); } catch (e) { }
  }

  try { window.__LDJ = { state: state, pageContext: pageContext, ruleAppliesToPage: ruleAppliesToPage, splitTopics: splitTopics, processTopicList: processTopicList, rescanCurrentPage: rescanCurrentPage, reloadClassifier: reloadClassifier, jevQuestionOf: jevQuestionOf, jevDecide: jevDecide, posterName: posterName, jevEvaluateBatch: jevEvaluateBatch, jevFetchModels: jevFetchModels, openModal: openModal, openCfg: openCfg, openDrawer: openDrawer, renderDrawer: renderDrawer, cfg: function () { return state.cfg; }, cache: function () { return state.cache; }, log: function () { return state.jevLog; } }; } catch (e) { }

})();
