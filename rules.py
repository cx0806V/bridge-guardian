"""桥体卫士 —— 报警规则引擎

设计目标：每条报警都能回答"为什么触发"（输出 rule + reason），且不重复刷屏。

5 类采样值规则（按评估顺序；另「设备离线」事件规则在采集层 app.py 实现）：
1. 阈值超限   —— 进入超限状态的瞬间触发一次（边沿触发）
2. 变化率突变 —— 相邻采样周期变化量 |Δ| 超过变化率阈值（瞬时事件）
3. 持续超限   —— 连续 N 个采样点超过阈值时触发一次（区别于单点毛刺）
4. 短时波动   —— 短窗口内峰谷差超过波动阈值（滞回：回落后才可再次触发）
5. 基线偏移   —— 近期均值相对历史基线偏移超过阈值（滞回）

所有阈值集中在构造函数，便于答辩讲解与后续配置化。
"""
from collections import deque


class RuleEngine:
    def __init__(self, threshold=120.0, rate_limit=10.0, duration_points=5,
                 volatility_window=10, volatility_limit=30.0,
                 baseline_window=30, drift_limit=20.0):
        self.threshold = float(threshold)
        self.rate_limit = float(rate_limit)
        self.duration_points = int(duration_points)
        self.volatility_window = int(volatility_window)
        self.volatility_limit = float(volatility_limit)
        self.baseline_window = int(baseline_window)
        self.drift_limit = float(drift_limit)

        self._prev_value = None
        self._window = deque(maxlen=self.baseline_window)  # (ts, value)
        self._over = False            # 当前是否处于超限状态
        self._over_count = 0          # 连续超限计数
        self._duration_fired = False  # 持续超限是否已触发
        self._vol_fired = False       # 短时波动是否已触发（滞回）
        self._drift_fired = False     # 基线偏移是否已触发（滞回）

    def set_threshold(self, threshold):
        self.threshold = float(threshold)

    @staticmethod
    def _level(value, threshold):
        if value >= threshold * 1.2:
            return "严重报警"
        if value >= threshold * 1.1:
            return "报警"
        return "预警"

    def evaluate(self, ts, value):
        """评估一个采样点，返回报警列表（可能为空）。"""
        value = float(value)
        alarms = []
        self._window.append((ts, value))

        # 1. 阈值超限（边沿触发：仅在进入超限的瞬间报一次）
        if value > self.threshold:
            if not self._over:
                self._over = True
                alarms.append({
                    "rule": "阈值超限",
                    "level": self._level(value, self.threshold),
                    "reason": "应变指标 %.2f 超过阈值 %.2f（相对应变指标，无量纲）" % (value, self.threshold),
                })
            self._over_count += 1
        else:
            if self._over:
                self._over = False
                self._over_count = 0
                self._duration_fired = False  # 回到安全区，允许下次持续超限再报

        # 2. 变化率突变（瞬时事件，满足即报）
        if self._prev_value is not None:
            delta = value - self._prev_value
            if abs(delta) >= self.rate_limit:
                alarms.append({
                    "rule": "变化率突变",
                    "level": "严重报警" if abs(delta) >= self.rate_limit * 2 else "报警",
                    "reason": "单周期变化 %+.2f，超过变化率阈值 ±%.2f（相对应变指标）" % (delta, self.rate_limit),
                })

        # 3. 持续超限（连续达到 N 点报一次，回到安全区后重置）
        if self._over_count >= self.duration_points and not self._duration_fired:
            self._duration_fired = True
            alarms.append({
                "rule": "持续超限",
                "level": "严重报警",
                "reason": "连续 %d 个采样点超过阈值 %.2f（相对应变指标）" % (self._over_count, self.threshold),
            })

        values = [v for _, v in self._window]

        # 4. 短时波动（滞回）
        if len(values) >= self.volatility_window:
            recent = values[-self.volatility_window:]
            span = max(recent) - min(recent)
            if span >= self.volatility_limit and not self._vol_fired:
                self._vol_fired = True
                alarms.append({
                    "rule": "短时波动",
                    "level": "预警",
                    "reason": "近 %d 点峰谷差 %.2f，超过波动阈值 %.2f（相对应变指标）" % (
                        self.volatility_window, span, self.volatility_limit),
                })
            elif span < self.volatility_limit * 0.5:
                self._vol_fired = False  # 回落到阈值一半以下才解除滞回

        # 5. 基线偏移（滞回）
        if len(values) >= self.baseline_window:
            half = self.baseline_window // 2
            front = values[-self.baseline_window:-half]
            back = values[-half:]
            if front:
                baseline = sum(front) / len(front)
                recent_mean = sum(back) / len(back)
                drift = recent_mean - baseline
                if abs(drift) >= self.drift_limit and not self._drift_fired:
                    self._drift_fired = True
                    alarms.append({
                        "rule": "基线偏移",
                        "level": "预警" if abs(drift) < self.drift_limit * 2 else "报警",
                        "reason": "近期均值 %.2f 相对基线 %.2f 偏移 %+.2f，超过阈值 %.2f（相对应变指标）" % (
                            recent_mean, baseline, drift, self.drift_limit),
                    })
                elif abs(drift) < self.drift_limit * 0.5:
                    self._drift_fired = False

        self._prev_value = value
        return alarms

    def reset(self):
        """清除内部状态（切换阈值/清除数据/切换模式时调用）。"""
        self._prev_value = None
        self._window.clear()
        self._over = False
        self._over_count = 0
        self._duration_fired = False
        self._vol_fired = False
        self._drift_fired = False
