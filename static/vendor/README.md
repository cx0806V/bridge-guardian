# static/vendor —— 离线 three.js 运行环境（r160）

> **离线演示红线：现场断网也必须能出 3D 场景。本目录下的文件必须随仓库一起保留，
> 不要删除、不要改成从 CDN 热链。** 加载顺序是 `/static/js/three-boot.js` 先注入
> importmap，再由 `window.BridgeThree.load()` 动态 `import('three')`；只有本地两级
> 加载（importmap → Blob 改写）全部失败时才会回退 `unpkg.com`，回退时
> `window.BridgeThree.fallbackUsed === true`、失败原因在 `.fallbackReason`。

## 版本

- three.js **0.160.0**（r160；MIT License，Copyright © 2010-2023 three.js authors）
- 两个上游文件为**原样原件，未做任何改写**（`three.module.min.js` 保持 minified）。

## 文件清单（字节数与 sha256 由 Python `hashlib` 实测生成，非手写）

| 文件 | 来源 URL | 字节数 | sha256 |
| --- | --- | ---: | --- |
| `three.module.min.js` | `https://unpkg.com/three@0.160.0/build/three.module.min.js` | 670681 | `3e690ac7d180b0aadf0891bea39eec643e29e2d3e75c99b18689518665f69ba6` |
| `OrbitControls.js` | `https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js` | 29868 | `5a44a9e86a2a0fb11933eed69bc2cd33c76a496854c1aed6ed776efa87d7b064` |
| `three-boot.js` | `（本项目自建，非下载）` | 10023 | `6b194cfd1036f49cb1e2ab5bc1b78e069382ba369353d2e405b558eda42be93c` |

## 接入大屏（给 templates/dashboard.html 的参考写法）

```html
<!-- 必须放在所有 <script type="module"> 之前：importmap 只在模块解析前有效 -->
<script src="/static/js/three-boot.js"></script>
<script>
  window.BridgeThree.load().then(function (mods) {
    var THREE = mods.THREE;                  // source === 'local' 表示走的是本地文件
    var OrbitControls = mods.OrbitControls;
    // ……在这里建 Scene / Camera / WebGLRenderer
  }).catch(function (err) {
    console.error('three.js 加载失败', err, window.BridgeThree.status);
  });
</script>
```

- `mods.source`：`'local'` 或 `'cdn'`；`mods.revision === '160'`。
- `window.BridgeThree.status`：`{ready, source, error}`，原地更新，可在调试时直接看。
- 大屏的 3D 代码若是 `<script type="module">`，务必保证 three-boot.js 在它**之前**执行完，
  否则浏览器可能已经解析过模块、拒绝后注入的 importmap（此时会自动走 Blob 兜底，仍能离线）。

## 验证记录（全部实测，命令可复现）

### 1. 静态访问（真实 Flask）——HTTP 200 且字节/哈希与磁盘一致

```
$ python -m flask --app app run --host 127.0.0.1 --port 5099 --no-reload
 * Serving Flask app 'app'
 * Running on http://127.0.0.1:5099

# Flask 访问日志（原始输出）
127.0.0.1 - - "GET /static/vendor/three.module.min.js HTTP/1.1" 200 -
127.0.0.1 - - "GET /static/vendor/OrbitControls.js HTTP/1.1" 200 -
127.0.0.1 - - "GET /static/js/three-boot.js HTTP/1.1" 200 -
```

```json
{{"url": "/static/vendor/three.module.min.js", "http_status": 200, "content_type": "text/javascript; charset=utf-8",
 "cache_control": "no-store", "http_bytes": 670681, "disk_bytes": 670681, "bytes_match": true}}
{{"url": "/static/vendor/OrbitControls.js", "http_status": 200, "http_bytes": 29868, "disk_bytes": 29868, "bytes_match": true}}
{{"url": "/static/js/three-boot.js", "http_status": 200, "http_bytes": 10023, "disk_bytes": 10023, "bytes_match": true}}
```

### 2. 模块自检（node ESM）

```
$ node --input-type=module -e "import('file:///.../static/vendor/three.module.min.js')"
{{"step": "export-count", "count": 416}}
{{"step": "REVISION", "value": "160"}}
{{"step": "named-export", "name": "WebGLRenderer", "type": "function", "present": true}}
{{"step": "named-export", "name": "Scene", "type": "function", "present": true}}
{{"step": "named-export", "name": "PerspectiveCamera", "type": "function", "present": true}}
{{"step": "orbitcontrols-construct", "ok": true, "instanceUpdate": "function", "instanceDispose": "function"}}
```

`OrbitControls.js` 的裸导入 `from 'three'` 通过临时 `node_modules/three` 垫片解析验证通过
（`bare-specifier-three: ok, REVISION "160"`）。

### 3. 真实浏览器（headless Edge 154，`--dump-dom` + `--virtual-time-budget`）

三种页面场景均在 Chromium 内核里跑通，结论一致：`source === "local"`、`fallbackUsed === false`
（即**完全没有碰 CDN**）、`REVISION === "160"`、`OrbitControls` 能 `new` 出实例并 `update()`。

| 场景 | `importMapMode` | 页面 importmap 数量 | 结果 |
| --- | --- | ---: | --- |
| 页面无 importmap（默认） | `injected` | 1 | 本地加载成功 |
| 页面已有含 `three` 的 importmap | `existing` | 1（复用，未重复注入） | 本地加载成功 |
| 页面已有**不含** `three` 的 importmap | `appended-after-existing` | 2 | 本地加载成功 |

**断网实测**：加 `--host-resolver-rules="EXCLUDE 127.0.0.1, EXCLUDE localhost, MAP * ~NOTFOUND"`
（除回环外所有域名解析失败）后重跑，结果完全相同：`source: "local"`、`fallbackUsed: false`、
`revision: "160"`、`orbitControlsDistance: 7.0710678118654755`。

### 4. 完整性交叉校验

unpkg 与 jsDelivr 上 `three@0.160.0` 的同名文件与本地文件**字节完全一致**（sha256 相同），
可排除下载截断或串版本。

## 复现命令（PowerShell，工作目录 = 项目根）

```powershell
# 1) 下载（幂等，重复执行得到同样的 sha256）
python -c "import urllib.request,hashlib;u='https://unpkg.com/three@0.160.0/build/three.module.min.js';d=urllib.request.urlopen(u).read();open('static/vendor/three.module.min.js','wb').write(d);print(len(d),hashlib.sha256(d).hexdigest())"
python -c "import urllib.request,hashlib;u='https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js';d=urllib.request.urlopen(u).read();open('static/vendor/OrbitControls.js','wb').write(d);print(len(d),hashlib.sha256(d).hexdigest())"

# 2) 校验 sha256（与上表比对）
python -c "import hashlib;print(hashlib.sha256(open('static/vendor/three.module.min.js','rb').read()).hexdigest())"
python -c "import hashlib;print(hashlib.sha256(open('static/vendor/OrbitControls.js','rb').read()).hexdigest())"

# 3) ES module 与导出名自检（node 路径为本机 DSH 运行时内的 node）
& 'C:\Users\CX\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' --input-type=module -e "const m = await import('file:///C:/Users/CX/Documents/GitHub/bridge guardian/static/vendor/three.module.min.js'.replace(/ /g,'%20')); console.log(m.REVISION, typeof m.WebGLRenderer, typeof m.Scene, typeof m.PerspectiveCamera)"

# 4) 语法自检（three-boot.js 是普通脚本）
& 'C:\Users\CX\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' --check static/js/three-boot.js
```

## 关于 "文件以 export{ 结尾" 的说明

r160 的 minified 构建在文件末尾是 `export{...416 个导出名...};` 加一个换行，
即最后两个可见字符是 `};`（**不是**字面量 `export{`）。校验口径应为
"文件末尾是一个 `export{...};` 语句"，正则 `export\s*\{[^}]*\}\s*;?\s*$` 命中即通过；
`three.module.min.js` 中 `export{` 只出现 1 次（偏移 661559），是纯 ES module 构建。

## 许可

three.js 与 OrbitControls 均为 **MIT License**（Copyright © 2010-2023 three.js authors），
文件头保留原始 `@license` 注释，可再分发。本项目自建的 `static/js/three-boot.js` 同样按 MIT 使用。

## 维护提示

- 升级版本：替换两个文件 → 重算 sha256 → 更新上表 → 跑"复现命令"第 2–4 步。
- `OrbitControls.js` 内部是 `import {...} from 'three'`（裸模块名），
  改路径/换目录时必须同步改 `/static/js/three-boot.js` 里的 importmap 映射。
- 删除本目录会导致大屏 3D 场景在断网演示时直接失败（CDN 兜底不可用）。
- **大屏实际接入方式（已落地）**：`templates/dashboard.html` 在 `<head>` 中引入
  `/static/js/three-boot.js`，页面末尾引入 `<script type="module" src="/static/js/twin/mount.js">`；
  `mount.js` 调用 `window.BridgeThree.load()` 后再动态 `import('./scene.js')`。
  即上文的"接入大屏"片段是**参考写法**，真实实现见 `static/js/twin/mount.js`。

<!-- generated by scripts: python 3.14.7 on 2026-09-29; hashes computed from disk bytes -->
