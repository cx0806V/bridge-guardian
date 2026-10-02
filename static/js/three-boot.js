/*!
 * three-boot.js —— 桥体卫士大屏 3D 场景的 three.js 引导脚本（普通脚本，非 module）
 *
 * 设计目标
 *   1) 完全离线可用：three.js r160 与 OrbitControls 均已本地化到 /static/vendor/，
 *      现场演示断网也能加载；CDN 只是"本地失败"时的兜底，永远不是首选。
 *   2) importmap 必须在任何模块加载之前注入（浏览器规范要求），因此本文件应在
 *      <head> 中、早于任何 <script type="module"> 引入。
 *   3) OrbitControls.js 内部写的是 `import {...} from 'three'`（裸模块名），
 *      必须靠 importmap 解析；本文件因此提供两级本地加载策略：
 *        a. importmap + 动态 import('three')   —— 规范做法
 *        b. 本地 .js 文本重写 + Blob URL 导入   —— importmap 被占用/不支持时仍可离线
 *
 * 用法：
 *   <script src="/static/js/three-boot.js"></script>
 *   <script>
 *     window.BridgeThree.load().then(function (mods) {
 *       // mods = { THREE, OrbitControls, source: 'local' | 'cdn' }
 *     }).catch(function (err) { ... });
 *   </script>
 *
 * 暴露的 API（全部挂在 window.BridgeThree 上）：
 *   .load()            -> Promise<{THREE, OrbitControls, source, revision}>（结果缓存，可重复调用）
 *   .status            -> { ready:false, source:null, error:null }（原地更新）
 *   .fallbackUsed      -> boolean，是否用到了 CDN
 *   .fallbackReason    -> string|null，本地失败原因（CDN 兜底时才有值）
 *   .importMapMode     -> 'injected' | 'existing' | 'appended-after-existing' | 'unsupported' | null
 *   .ensureImportMap() -> 供诊断/测试调用，返回本次判定结果
 *   .reset()           -> 清除缓存，允许重新尝试加载（测试用）
 */
(function (global) {
  'use strict';

  var VERSION = '0.160.0';
  var LOCAL_THREE = '/static/vendor/three.module.min.js';
  var LOCAL_ORBIT = '/static/vendor/OrbitControls.js';
  var CDN_ROOT = 'https://unpkg.com/three@' + VERSION + '/';
  var CDN_THREE = CDN_ROOT + 'build/three.module.min.js';
  var CDN_ORBIT = CDN_ROOT + 'examples/jsm/controls/OrbitControls.js';

  var api = {
    version: VERSION,
    local: { three: LOCAL_THREE, orbitControls: LOCAL_ORBIT },
    cdn: { three: CDN_THREE, orbitControls: CDN_ORBIT },
    fallbackUsed: false,
    fallbackReason: null,
    importMapMode: null,
    importMapSupported: null,
    localErrors: [],
    cdnErrors: [],
    status: { ready: false, source: null, error: null }
  };

  var pending = null;

  function errText(err) {
    if (!err) return 'unknown error';
    var name = err.name || (err.constructor && err.constructor.name) || 'Error';
    var msg = err.message || String(err);
    return name + ': ' + msg;
  }

  function importMapSupported() {
    try {
      return !!(global.HTMLScriptElement && typeof global.HTMLScriptElement.supports === 'function'
        && global.HTMLScriptElement.supports('importmap'));
    } catch (e) {
      return null; // 无法探测（老浏览器无 supports()），交给实际加载结果说话
    }
  }

  function appendImportMap() {
    var doc = global.document;
    var host = doc.head || doc.getElementsByTagName('head')[0] || doc.documentElement;
    var s = doc.createElement('script');
    s.type = 'importmap';
    s.textContent = JSON.stringify({ imports: { three: LOCAL_THREE } });
    host.appendChild(s);
    return s;
  }

  /**
   * 确保页面存在能解析裸模块名 'three' 的 importmap。
   * 只注入一次；页面已有 importmap 时优先复用（不重复注入）。
   */
  function ensureImportMap() {
    if (api.importMapMode) return api.importMapMode;
    var doc = global.document;
    if (!doc) {
      api.importMapMode = 'unsupported';
      return api.importMapMode;
    }
    api.importMapSupported = importMapSupported();
    if (api.importMapSupported === false) {
      api.importMapMode = 'unsupported';
      return api.importMapMode;
    }
    var existing = doc.querySelector('script[type="importmap"]');
    if (existing) {
      var mapsThree = false;
      try {
        var parsed = JSON.parse(existing.textContent || '{}');
        mapsThree = !!(parsed && parsed.imports && parsed.imports.three);
      } catch (e) {
        mapsThree = false;
      }
      if (mapsThree) {
        api.importMapMode = 'existing';
        return api.importMapMode;
      }
      // 已有 importmap 但没有 'three'：追加第二个（Chromium 133+ 支持多 importmap）。
      // 若浏览器忽略它，下面的本地 Blob 兜底仍能离线加载。
      appendImportMap();
      api.importMapMode = 'appended-after-existing';
      return api.importMapMode;
    }
    appendImportMap();
    api.importMapMode = 'injected';
    return api.importMapMode;
  }

  function pickOrbitControls(mod) {
    if (!mod) return null;
    return mod.OrbitControls || mod.default || null;
  }

  function assertModules(THREE, OrbitControls, source) {
    if (!THREE || typeof THREE.WebGLRenderer !== 'function') {
      throw new Error(source + ': three 模块已加载但缺少 WebGLRenderer');
    }
    if (typeof OrbitControls !== 'function') {
      throw new Error(source + ': OrbitControls 不是构造函数');
    }
    return {
      THREE: THREE,
      OrbitControls: OrbitControls,
      source: source,
      revision: THREE.REVISION || null
    };
  }

  /** 策略 a：依赖 importmap 解析裸模块名（规范做法，本地首选）。 */
  function loadLocalViaImportMap() {
    return Promise.all([import('three'), import(LOCAL_ORBIT)]).then(function (mods) {
      return assertModules(mods[0], pickOrbitControls(mods[1]), 'local');
    });
  }

  /**
   * 策略 b：把本地 OrbitControls.js 的裸导入改写为绝对 URL 后用 Blob URL 导入。
   * 完全不依赖 importmap，也不需要外网——importmap 不可用时依然能离线。
   */
  function importPatchedOrbitControls(orbitUrl, threeUrl) {
    return global.fetch(orbitUrl).then(function (res) {
      if (!res.ok) throw new Error('OrbitControls 本地读取失败 HTTP ' + res.status + ' ' + orbitUrl);
      return res.text();
    }).then(function (src) {
      var patched = src
        .replace(/from\s*['"]three['"]/g, 'from ' + JSON.stringify(threeUrl))
        .replace(/import\s*\(\s*['"]three['"]\s*\)/g, 'import(' + JSON.stringify(threeUrl) + ')');
      var blobUrl = global.URL.createObjectURL(new global.Blob([patched], { type: 'text/javascript' }));
      return import(/* webpackIgnore: true */ blobUrl);
    });
  }

  function loadLocalViaShim() {
    return Promise.all([
      import(/* webpackIgnore: true */ LOCAL_THREE),
      importPatchedOrbitControls(LOCAL_ORBIT, LOCAL_THREE)
    ]).then(function (mods) {
      return assertModules(mods[0], pickOrbitControls(mods[1]), 'local');
    });
  }

  /** CDN 兜底策略 1：绝对 URL，直接 import（OrbitControls 的裸 'three' 仍靠 importmap）。 */
  function loadCdnViaImportMap() {
    return Promise.all([
      import(/* webpackIgnore: true */ CDN_THREE),
      import(/* webpackIgnore: true */ CDN_ORBIT)
    ]).then(function (mods) {
      return assertModules(mods[0], pickOrbitControls(mods[1]), 'cdn');
    });
  }

  /** CDN 兜底策略 2：不依赖 importmap 的文本重写导入（需要外网 + CORS，unpkg 允许）。 */
  function loadCdnViaShim() {
    return Promise.all([
      import(/* webpackIgnore: true */ CDN_THREE),
      importPatchedOrbitControls(CDN_ORBIT, CDN_THREE)
    ]).then(function (mods) {
      return assertModules(mods[0], pickOrbitControls(mods[1]), 'cdn');
    });
  }

  function attempt(label, bucket, fn) {
    return fn().catch(function (err) {
      var text = label + ' → ' + errText(err);
      bucket.push(text);
      throw new Error(text);
    });
  }

  function load() {
    if (pending) return pending;
    api.status.ready = false;
    api.status.source = null;
    api.status.error = null;
    api.localErrors = [];
    api.cdnErrors = [];

    try {
      ensureImportMap();
    } catch (e) {
      api.localErrors.push('注入 importmap 失败 → ' + errText(e));
    }

    pending = attempt('本地(importmap)', api.localErrors, loadLocalViaImportMap)
      .catch(function () {
        // 本地第二次尝试：Blob 改写，保持离线能力
        return attempt('本地(blob-shim)', api.localErrors, loadLocalViaShim);
      })
      .catch(function () {
        // 两级本地都失败，才允许走 CDN
        api.fallbackUsed = true;
        api.fallbackReason = api.localErrors.join(' | ');
        if (global.console && console.warn) {
          console.warn('[bridge-three] 本地 three.js 加载失败，回退 CDN。原因：' + api.fallbackReason);
        }
        return attempt('CDN(importmap)', api.cdnErrors, loadCdnViaImportMap)
          .catch(function () {
            return attempt('CDN(blob-shim)', api.cdnErrors, loadCdnViaShim);
          });
      })
      .then(function (mods) {
        api.status.ready = true;
        api.status.source = mods.source;
        api.status.error = null;
        if (mods.source === 'cdn') api.fallbackUsed = true;
        return mods;
      })
      .catch(function (err) {
        api.status.ready = false;
        api.status.source = null;
        api.status.error = api.localErrors.concat(api.cdnErrors).join(' | ') || errText(err);
        pending = null; // 允许后续重试
        throw err;
      });

    return pending;
  }

  api.load = load;
  api.ensureImportMap = ensureImportMap;
  api.reset = function reset() {
    pending = null;
    api.status.ready = false;
    api.status.source = null;
    api.status.error = null;
    return api;
  };

  // 立即注入 importmap：越早越好（必须在任何 module 解析之前）。
  try {
    ensureImportMap();
  } catch (e) {
    api.localErrors.push('启动时注入 importmap 失败 → ' + errText(e));
  }

  global.BridgeThree = api;
})(typeof window !== 'undefined' ? window : this);
