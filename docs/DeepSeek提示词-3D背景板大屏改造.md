# DeepSeek 提示词套装 —— 大屏「3D 可操控背景板」改造

> **用途**：把「桥体卫士」大屏改造成参考图（bilibili 智慧桥梁大屏）效果——3D 桥梁模型铺满全屏作为可操控背景板，所有数据面板半透明悬浮，支持一键全屏观看背景板。
> **用法**：按下面「发送流程」把项目材料 + 提示词发给 DeepSeek。本文中所有提示词块都可以整块直接复制。

---

## 〇、发送流程（这部分给你看，不要发给 DeepSeek）

### 需要一起发给 DeepSeek 的材料

| 顺序 | 材料 | 说明 |
|---|---|---|
| 1 | `templates/dashboard.html` 全文 | 约 1070 行，主战场，数据刷新逻辑全在里面 |
| 2 | `static/js/twin/mount.js` 全文 | 134 行，3D 挂载约定（按 id 找容器） |
| 3 | 主提示词（见「一」） | 整块复制 |
| 4 | 参考截图（可选） | 若你用的 DeepSeek 入口支持传图，把那张智慧桥梁截图一起传 |

DeepSeek 的长上下文足够装下这两个文件 + 提示词，不用担心截断输入；要防的是**输出**截断，所以主提示词里已限定输出格式。

### 不要发的材料

- `static/app.css` **不要整份发**（1047 行，容易让 DeepSeek 整份重打时丢样式）。主提示词已要求它只输出「追加到 app.css 末尾的 CSS 片段」。
- 后端 Python（app.py / rules.py / db.py）不发，本次不允许改。
- `static/js/twin/` 目录其他文件（scene.js / bridge.js 等）不发，本次不允许改。

### 对话流程

1. **第一条消息**：材料 1 + 材料 2 + 主提示词（+ 参考图）。
2. 拿到输出后：整份替换 `templates/dashboard.html`，把 CSS 片段追加到 `static/app.css` 末尾，启动 Flask 实际运行看效果。
3. **第二条消息**：发「补充提示词 A（自检修复）」，让 DeepSeek 对着验收清单自查并修补。
4. 之后遇到具体故障：从「补充提示词 B」里挑对应那一条发，哪坏修哪。

---

## 一、主提示词（复制下面整块发给 DeepSeek）

```
【角色】
你是一名资深数据大屏前端工程师，擅长 Three.js 数字孪生场景与 ECharts 大屏布局重构。

【项目背景】
这是竞赛项目「桥体卫士 —— 桥梁结构健康监测大屏」。Flask + SQLite 后端，前端为 1920×1080 固定设计稿（JS transform scale 等比缩放铺满窗口，窗口 <1100px 时回退为纵向滚动布局）。页面每秒轮询 /api/data 刷新全部面板。
页面已集成本地化 Three.js r160 的 3D 数字孪生场景（花江峡谷大桥程序化模型，含峡谷地形；OrbitControls 支持旋转/缩放/平移/双击聚焦；桥面吊索随风险等级变色）。但目前它被限制在中栏一个面板容器（.twin-stage）内，只占画面中央一小块。
我现在把两个文件发给你：
1. templates/dashboard.html —— 大屏模板（含内联 CSS 与内联 JS，数据刷新逻辑全部在其中）
2. static/js/twin/mount.js —— 3D 场景挂载入口（通过 getElementById 找容器，挂载后暴露 window.TwinScene）

【改造目标】
把大屏改造成「3D 可操控背景板」方案，参考一张智慧桥梁大屏截图（布局描述见下）：
1. 3D 桥梁场景从面板内释放出来，铺满整个 1920×1080 设计稿，成为最底层背景板，且保持完全可操控（旋转/缩放/平移/双击聚焦）。
2. 所有数据面板改为半透明悬浮层，按参考图布局摆放在 3D 背景之上：左列 3 个面板、右列 3 个面板、顶部指标带、底部通栏。3D 桥体在中央区域完整可见、不被面板遮挡。
3. 新增「全屏观看背景板」功能：一键隐藏全部悬浮面板，仅留 3D 背景全屏观赏，可随时退出并恢复原布局。

【参考图布局描述】
深色科技风大屏。中央是一整座发光的悬索桥 3D 模型横跨画面，占满中间视野，桥下是峡谷/水面。左侧一列 3 个半透明面板，右侧一列 3 个半透明面板，顶部中央是大标题与页签，左上角有时钟，右上角有状态图标与时间。所有面板浮在 3D 场景之上，面板之间留出让 3D 透出的间隙，画面中央除了桥什么都没有。

【技术规格】

一、背景层（3D 全屏化）
1. 在 #bigscreen 根级（与 .screen 同级，放在它前面）新建 3D 背景容器，沿用现有 id 结构：twinStage > twinCanvas + twinLabels + twinHud + twinStatus。mount.js 按 getElementById 工作，DOM 位置可以动，但这 5 个 id 一个都不能丢、不能改名。
2. 背景容器样式：position:absolute; inset:0; z-index:0。画布跟随 CSS 尺寸即自动变为 1920×1080 满幅（mount.js 的 resize 逻辑会跟随容器 clientWidth/clientHeight，不用改）。
3. WebGL 降级图 #sceneFallback 一并移到背景层：WebGL 不可用时全屏显示 2D 桥梁线稿 + 原因文案，绝不留一块黑屏。
4. 跨中测点标签 #sceneLabel 保留在背景层（它由 3D 场景每帧投影定位）。
5. 原中栏 scene-panel 的面板外壳（标题栏、角落装饰、透视地台 scene-floor）删除；扫描光带 scan-beam 与漂浮粒子 particles 保留为全屏氛围层，z-index 介于背景(0)与悬浮层(2)之间。
6. 风险联动不能断：内联脚本中 $('scene').className = 'scene sev-' + risk.key、$('scenePanel').classList.toggle('scene-crit', ...)、window.TwinScene.setData(...) 这些调用涉及的 id/class，要么保留原 id，要么同步更新 JS 引用。严重报警的红色氛围改到全屏背景层实现（例如给 #bigscreen 加 sev-crit 类，画面边缘出现红色呼吸辉光）。

二、悬浮层与布局映射
1. .screen 保持现有 grid 骨架与 fitScreen 缩放系统不变，整体作为 z-index:2 的悬浮层。
2. 事件穿透：悬浮层容器及其中间布局容器 pointer-events:none；每个 .panel、按钮、链接、表格、图表容器、跑马灯 pointer-events:auto。目标：鼠标在面板间隙的空白处可直接拖拽旋转 3D 桥。
3. 面板半透明化：背景改为 rgba(8,22,40,.55) ~ rgba(8,22,40,.68)，加 backdrop-filter: blur(6px)（带 -webkit- 前缀）；用 @supports 检测，不支持 backdrop-filter 时背景不透明度提到 .88 兜底。保留现有四角装饰 .corner 与边框风格。
4. 布局映射（现有面板整体搬家，面板内部结构、id、数据逻辑一律不动）：
   - 左列（宽 400px，从上到下）：全局风险态势 → 设备健康度 → 系统运行
   - 右列（宽 460px，从上到下）：阈值仪表盘 → 报警分级统计 → 近段采样
   - 顶部中央横条（顶栏之下）：核心指标带的 6 张指标卡横排，整体半透明
   - 底部通栏改为左右结构：左侧放「桥梁受载趋势」图（约 40% 宽），右侧放「报警处置队列」表格（约 60% 宽）；告警跑马灯压在它们上方通栏一行
   - 场景底部读数条（footLevel / footThreshold / footRate / footSource / footClock）改为悬浮在 3D 底部中央的胶囊条；场景标签 #sceneTag 悬浮在指标带下方居中
   - 页脚口径说明保留在最底部一行
5. 中栏清空：原中栏的 3D 场景面板移除后，指标带与趋势图按上条各就各位，不再保留"中列"容器。

三、顶栏页签
在顶栏中部标题下方（或右侧导航之前）加入三个页签，样式仿参考图（小胶囊形、当前页高亮描边发光）：
- 综合态势 → /dashboard（当前页，active 高亮）
- 安全管理 → /history
- 桥梁监控 → /settings
注意：history / settings 页面本次不改，只在大屏页加这组页签。

四、全屏观看背景板
1. 顶栏右侧加按钮「⛶ 全屏观看」。
2. 点击后：document.documentElement.requestFullscreen()（做 webkit 前缀兼容）+ 给 body 添加 class view-3d-only。该 class 的效果：.screen 悬浮层 visibility:hidden + opacity:0（200ms 过渡）——必须用 visibility 而不是 display:none，这样 ECharts 容器尺寸不坍缩，退出后图表无需重建或 resize；同时显示一个固定在右上角的半透明「✕ 退出全屏」浮动按钮。
3. 退出途径：点击退出按钮 / 按 ESC。必须监听 fullscreenchange 事件：当浏览器全屏被系统层面退出（用户按 ESC 或 F11）时，同步移除 body 的 view-3d-only 并隐藏退出按钮，绝不允许出现"面板已隐藏但浏览器已退出全屏"的死锁状态。
4. 全屏观赏期间 OrbitControls 交互与 TwinScene.setData 风险联动照常工作。

五、必须原样保留的系统（动了任何一处都算失败）
- fitScreen() 缩放适配与 <1100px 窄屏回退
- 每秒轮询 /api/data 的 refresh() 及其引用的全部面板 id
- ECharts 四个图表（chart / gauge / donut / miniChart）的初始化、签名节流、resize() 调用
- sim 模式水印「模拟演示 · 非真实硬件数据」与场景切换条（serial 模式下隐藏的逻辑）
- 报警跑马灯、报警队列点击行看详情、确认处理 / 清除按钮（含 X-CSRF-Token 头）
- window.TwinScene.setData({riskKey, strain, threshold}) 每秒推送链路
- three-boot.js 的本地 three.js 加载链路（不得改为 CDN 首选）

【红线约束】（违反任何一条即返工）
1. 所有数值只准来自 /api/data；禁止新增任何写死数字的面板、禁止编造数据。
2. 设备离线时一律显示 --，禁止伪造在线状态或伪造读数。
3. 模拟模式水印必须保留且醒目。
4. 页面文案与代码注释不得声称工程级精度，统一口径「缩尺模型受载变化模拟」。
5. 修改范围仅限：templates/dashboard.html（整份重构）与 static/app.css（仅追加）。不改任何 Python 文件，不改 history / settings / login 模板，不改 static/js/twin/ 目录下任何文件。

【输出要求】
1. 输出完整可替换的 templates/dashboard.html（整份输出，禁止省略号、禁止"此处不变"）。
2. 输出需要追加到 static/app.css 末尾的 CSS 片段（不要整份重打 app.css），片段开头写注释标明用途。
3. 用一张表列出：改了哪些 DOM 结构、哪些 id 被移动但保留、风险联动是如何重新接上的。
4. 输出末尾附你对照下方【验收清单】的逐条自检结论。

【验收清单】
- [ ] 3D 桥铺满整个设计稿背景；在面板间隙的空白处可拖拽旋转、滚轮缩放、双击聚焦
- [ ] 左 3 面板 / 右 3 面板 / 顶部指标带 / 底部趋势图与报警队列全部半透明悬浮，数值每秒刷新
- [ ] 点击「全屏观看」→ 浏览器进入全屏且所有面板隐藏、仅剩 3D；ESC 或退出按钮恢复后，所有图表尺寸正常、数据照常刷新
- [ ] fullscreenchange 监听已处理系统级退出，不会出现面板消失的死锁
- [ ] 三个页签可跳转，当前页高亮
- [ ] sim 模式水印与场景切换条照常；切到「设备离线」场景后数值显示 --、3D 联动变灰
- [ ] 窗口缩小到 <1100px 时窄屏纵向布局回退正常；浏览器控制台无报错
- [ ] 禁用 WebGL 时全屏显示 2D 降级示意图与原因文案
```

---

## 二、补充提示词 A —— 自检修复（拿到第一轮输出、实际运行之后发）

```
你刚才输出的改造代码我已替换并运行。请对照上一轮提示词末尾的【验收清单】逐条自检你写的代码（不要凭印象，逐条回到代码里核对逻辑），输出：
1. 做到的条目（每条一句话说明依据）
2. 没做到或有隐患的条目（指出具体代码位置和原因）
3. 针对没做到的条目，直接给出修复后的完整代码（dashboard.html 给整份，CSS 给追加片段）

特别检查这三处高危点：
a. 事件穿透：pointer-events:none 是否只加在悬浮层容器上？所有可交互子元素（报警表格行点击、确认/清除按钮、ECharts 的 tooltip、跑马灯、页签、全屏按钮）是否都补了 pointer-events:auto？
b. 全屏隐藏用的是 visibility 还是 display？display:none 会让 ECharts 容器尺寸坍缩成 0，退出全屏后图表消失。
c. fullscreenchange 监听：浏览器全屏被系统退出（ESC/F11）的路径下，body 的 view-3d-only 是否一定会被移除？
```

---

## 三、补充提示词 B —— 常见故障定点修复（按需取用，一次发一条）

**B1. 3D 拖不动 / 转不了**

```
现在 3D 背景无法用鼠标拖拽旋转。请检查：.screen 悬浮层及其中间容器是否漏了 pointer-events:none（被一层透明 div 挡住了）；背景容器 z-index 层级是否正确；OrbitControls 绑定的元素是否仍是 twinCanvas 容器。给出修复后的完整代码。
```

**B2. 页面出现滚动条 / 缩放错乱**

```
改造后大屏缩放失效或出现滚动条。请检查：fitScreen() 是否仍对 #bigscreen 做 translate+scale；3D 背景容器是否意外撑大了 #bigscreen 的固有 1920×1080 尺寸（背景容器必须用 position:absolute; inset:0 脱离文档流，不能参与 grid 布局）。给出修复后的完整代码。
```

**B3. 图表不刷新 / 尺寸错乱**

```
改造后 ECharts 不刷新或尺寸异常。请检查：四个图表的初始化与 resize() 逻辑是否被改动；图表容器是否被移出了设计稿坐标系；全屏切换是否误用了 display:none 导致容器尺寸坍缩为 0。给出修复后的完整代码。
```

**B4. 退出全屏后面板回不来**

```
退出全屏后悬浮面板仍然是隐藏的。请检查 fullscreenchange 监听：浏览器全屏被系统退出（ESC/F11）时，必须同步移除 body 的 view-3d-only 类并隐藏「退出全屏」浮动按钮。给出修复后的完整代码。
```

**B5. 3D 不随风险等级变色 / 测点数值不更新**

```
3D 场景不再随风险等级联动变色。请检查：refresh() 中 window.TwinScene.setData({riskKey, strain, threshold}) 调用是否还在每秒执行；scene / scenePanel / sceneTag / sceneLabel 相关 id 的 JS 引用是否因 DOM 重构而失效（移动到背景层后引用要同步更新）。给出修复后的完整代码。
```

**B6. 禁用 WebGL 后背景是一块黑屏**

```
禁用 WebGL 后背景是黑屏而不是 2D 降级示意图。请检查：#sceneFallback 是否随 3D 容器一起移到了背景层且样式适配全屏；mount.js 的 showFallback() 是否还能通过 getElementById 找到它。给出修复后的完整代码。
```

---

## 四、提示词设计说明（给你看的，可选读）

这套提示词针对 DeepSeek 的常见问题做了这些防护：

| 防护点 | 为什么 |
|---|---|
| 限定输出「整份 dashboard.html + 追加式 CSS」 | 防止整份重打 1047 行 app.css 时截断或丢样式 |
| 反复强调「id 一个不能丢」并列出关键 id | AI 重构 DOM 时最常见的翻车就是丢 id 导致 refresh() 报错 |
| 写明 visibility 与 display 的区别 | 全屏切换时 ECharts 尺寸坍缩是这类改造的最高发 bug |
| 写明 fullscreenchange 死锁场景 | AI 经常只处理"点按钮退出"，漏掉"ESC 系统退出"路径 |
| 红线约束前置到提示词内 | 防止 DeepSeek 为了"演示效果"在面板里写死假数据（违反项目真实性红线） |
| 验收清单要求 DeepSeek 自检并附结论 | 利用模型自查，第一轮输出质量明显更稳 |
| 补充提示词 B 按故障分条 | 第二轮以后只发故障对应的一条，省上下文、修得更准 |
