# STORY.md — 桥体卫士 答辩演示文稿叙事

## ① 用户意图对齐

- **目标受众**：职业院校技能竞赛评审现场，评委（技术评委 + 教学评委），5–8 分钟答辩。
- **核心目标**：让评委相信——这是一个「采集 → 判断 → 存储 → 展示 → 处置」完整闭环的、可解释、可追溯、不造假、可兜底的桥梁健康监测缩尺原型；团队有真实工程能力。
- **PPT 长度**：10 页（Hero 页配额 3 页：封面、可解释报警、结束页）。
- **视觉调性**：学术严谨 / 证据驱动 / 蓝白克制 / 结构清晰 / 诚实可信。
- **内容边界**：必讲——双模式数据源、可解释报警、设备健康度、数据可靠与审计、安全工程化、硬件闭环；不讲——营销话术；禁碰——AI/大数据/数字孪生、工程级精度、虚构评分项。

## ② 页面布局骨架

10 页，无目录页、无章节扉页（紧凑答辩，封面直入正文，结束页收尾）。章节隐含三段：项目定位(2)、技术实现(3–8)、总结展望(9–10)。

| 页 | 类型 | role | rhythm | 版式 |
|---|---|---|---|---|
| 01 封面 | cover | hero | peak | 全幅视觉+大标题 |
| 02 背景痛点 | content | supporting | valley | 左大图+右侧文字 |
| 03 系统架构 | content | supporting | valley | 左标题+右内容 |
| 04 双模式数据源 | content | supporting | transition | 非对称双栏 |
| 05 可解释报警 | content | hero | peak | 巨型数字+洞察 |
| 06 数据可靠审计 | content | supporting | valley | 左标题+右内容 |
| 07 安全工程化 | content | supporting | valley | 非对称双栏 |
| 08 硬件闭环 | content | supporting | transition | 上大图+下方卡片 |
| 09 演示与验证 | content | supporting | valley | 左大图+右侧文字 |
| 10 创新总结 | ending | hero | peak | 居中金句/巨型数字 |

校验：Hero 3 页(30%)✅；连续 valley ≤2 页✅；非对称 9/10=90%✅；相邻页版式不重复✅；`左大图+右侧文字`+`非对称双栏` = 4 页(40%)✅；对称 1 页(≤2)✅。

## ③ 页面大纲

### 01 封面
- title：桥体卫士 · 桥梁结构健康监测缩尺原型
- type: cover | role: hero | rhythm: peak | layout: 全屏视觉+大标题
- visual: L1 深蓝渐变顶条 + 中央论文式标题（无配图，用色块+文字）；L3 项目名
- visual_role: atmosphere
- density: 字数约 45 / 图 0 / 留白约 30%
- anti_pattern: 禁党政红金/印章/烟花；禁人物大头照；禁卡通插画
- description: 主标「桥体卫士」，副标「桥梁结构健康监测缩尺原型」，汇报人 + 日期。

### 02 背景与痛点
- title：为什么做 —— 桥梁受载监测的痛点
- type: content | role: supporting | rhythm: valley | layout: 左大图+右侧文字
- visual: L1 左栏「真实桥梁 vs 缩尺原型」SVG 对照示意（占左 55%）
- visual_role: anchor
- density: 字数约 200 / 图 1 / 留白约 15%
- anti_pattern: 禁等宽卡片横排；禁把痛点塞进 3 张等宽卡
- description: 桥梁长期受载下结构健康关乎安全——真实监测设备贵、部署难；我们用低成本缩尺原型演示完整监测闭环（数据+判断）。

### 03 系统架构
- title：六层架构 —— 数据源可插拔
- type: content | role: supporting | rhythm: valley | layout: 左标题+右内容
- visual: L1 右侧分层架构 SVG（硬件→采集→规则→数据→服务→展示，占右 60%）
- visual_role: anchor
- density: 字数约 160 / 图 1 / 留白约 15%
- anti_pattern: 禁单栏线性列表堆砌层级；禁等宽四卡
- description: 六层解耦，核心是采集层 DataSource 抽象——换数据源不改上层（数据+判断）。

### 04 双模式数据源 + 设备健康度
- title：双模式数据源 · 断线不造假
- type: content | role: supporting | rhythm: transition | layout: 非对称双栏
- visual: L1 左右两栏：模拟源 vs 串口源（60:40）+ 底部「心跳/超时/离线」三要素条
- visual_role: evidence
- density: 字数约 190 / 图 0(SVG 结构) / 留白约 15%
- anti_pattern: 禁 50:50 等分双栏；禁把三要素做成等宽三卡
- description: DATA_SOURCE 一键切换；设备健康度=心跳+超时+最近错误，断线如实「离线」（数据+判断）。

### 05 6 类可解释报警（Hero）
- title：6 类可解释规则 —— 每条报警说清「为什么」
- type: content | role: hero | rhythm: peak | layout: 巨型数字+洞察
- visual: L1 巨型数字「6」+ 规则清单（阈值/变化率/持续超限/短时波动/基线偏移/设备离线）+ 一条 reason 实例
- visual_role: anchor
- density: 字数约 180 / 图 0(巨型数字) / 留白约 20%
- anti_pattern: 禁把 6 规则塞进等宽六卡；禁 L3 角标顶替 L1 巨数字
- description: 不只报「超了」，每条报警带「触发规则+触发值+原因」，边沿触发防刷屏（数据+判断）。

### 06 数据可靠与审计
- title：SQLite 五表 + 全程审计
- type: content | role: supporting | rhythm: valley | layout: 左标题+右内容
- visual: L1 右侧五表结构 Table（采样/心跳/报警/设置/审计）
- visual_role: evidence
- density: 字数约 160 / 表 1 / 留白约 15%
- anti_pattern: 禁等宽五卡横排；禁表格无结论锚底
- description: 统一时间/设备/状态字段，参数变更留审计，历史可筛选可导出 CSV（数据+判断）。

### 07 安全与工程化
- title：安全与工程化 —— 能交付的程度
- type: content | role: supporting | rhythm: valley | layout: 非对称双栏
- visual: L1 左「安全」栏（env 密钥/统一鉴权/写接口保护）+ 右「工程化」栏（28 项测试/依赖清单/现场手册）60:40
- visual_role: evidence
- density: 字数约 180 / 图 0(结构) / 留白约 15%
- anti_pattern: 禁 50:50 等分；禁把测试项做成等宽卡片
- description: 密钥走环境变量、统一鉴权返回 401、28 项测试全绿——不是原型草稿（数据+判断）。

### 08 硬件闭环
- title：硬件本地双重预警
- type: content | role: supporting | rhythm: transition | layout: 上大图+下方卡片
- visual: L1 上半部硬件流程 SVG（HX711→OLED/LED/蜂鸣器→串口→Web，占上 60%）
- visual_role: anchor
- density: 字数约 150 / 图 1 / 留白约 15%
- anti_pattern: 禁把硬件流程缩小为小图标；禁 200×70 装饰小图
- description: 即使上位机没开，硬件也能本地声光报警，双重保障（数据+判断）。

### 09 演示与验证
- title：演示闭环 + 28 项测试证据
- type: content | role: supporting | rhythm: valley | layout: 左大图+右侧文字
- visual: L1 左栏演示流程 SVG（受载→预警→本地声光→Web 报警→处置→历史→离线，占左 55%）
- visual_role: anchor
- density: 字数约 170 / 图 1 / 留白约 15%
- anti_pattern: 禁等宽卡片横排演示步骤；禁把流程做成线性列表
- description: 现场从施压到报警到处置到离线降级，全链路可演示；28 项测试全绿（数据+判断）。

### 10 创新总结
- title：10 个可证明的创新点 · 诚实的展望
- type: ending | role: hero | rhythm: peak | layout: 居中金句/巨型数字
- visual: L1 巨型数字「10」+ 核心金句「说得出口，必拿得出证据」
- visual_role: anchor
- density: 字数约 120 / 图 0(巨型数字) / 留白约 25%
- anti_pattern: 禁把 10 个创新点全堆正文；禁烟花/金装饰
- description: 10 个创新点每个可被源码/测试/演示证明；展望 HTTP 备份、多测点（数据+判断）。
