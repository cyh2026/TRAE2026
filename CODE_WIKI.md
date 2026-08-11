# 车辆助理 - Code Wiki

## 项目概述

**车辆助理**是一款基于 Capacitor 框架开发的混合 Android 应用，用于车辆养护管理。应用采用单文件 HTML 架构，所有业务逻辑、UI 和样式均封装在 `index.html` 中，通过 WebView 运行在 Android 原生壳内。

### 核心特性

- 🚗 多车辆管理与切换
- 🔧 养护记录（保养/维修/加油）
- 📊 智能保养建议计算引擎
- 🛡️ 车险管家与应急处理指南
- 🔍 故障排查知识库
- 🔐 生物识别登录（指纹/面容/屏幕锁）
- 📦 数据导出/导入与备份恢复
- 🌓 深色/浅色/跟随系统主题
- 🔄 双通道更新（APK + PWA 热更新）

### 技术栈

- **前端框架**: 原生 JavaScript（无框架依赖）
- **混合框架**: Capacitor 5.x
- **数据存储**: localStorage + IndexedDB（Capacitor Filesystem 备份）
- **安全机制**: PBKDF2 密码哈希 + ECDSA 签名校验
- **UI 渲染**: 原生 DOM 操作 + CSS 变量主题系统
- **数据可视化**: SVG 原生绘制（费用饼图、油耗趋势图）

---

## 项目架构

### 目录结构

```
extracted_apk/
├── AndroidManifest.xml          # Android 应用清单
├── assets/
│   ├── capacitor.config.json    # Capacitor 配置
│   ├── native-bridge.js         # 原生桥接层
│   └── public/
│       ├── index.html           # 主应用文件（单文件架构）
│       ├── capacitor-runtime.js # Capacitor 运行时
│       ├── capacitor-filesystem.js # 文件系统插件
│       ├── pwa-hot-update.js    # PWA 热更新管理器
│       ├── app-update-manager.js # APK 更新管理器
│       └── minixlsx.js          # Excel 导出/导入工具
└── res/                         # 资源文件（图标、启动图等）
```

### 架构层次

```
┌─────────────────────────────────────┐
│         Android Native Shell        │  ← Java/Kotlin 原生层
│  (Capacitor Runtime + Plugins)      │
├─────────────────────────────────────┤
│         WebView Container           │  ← Android WebView
├─────────────────────────────────────┤
│      Capacitor Bridge Layer         │  ← 原生插件桥接
│  (Filesystem, BiometricAuth, etc.)  │
├─────────────────────────────────────┤
│      Web Application Layer          │  ← 单文件 HTML 应用
│  (index.html - 所有业务逻辑)         │
├─────────────────────────────────────┤
│         Data Storage Layer          │  ← localStorage + IndexedDB
│  (车辆数据、用户信息、养护记录)       │
└─────────────────────────────────────┘
```

---

## 核心模块详解

### 1. 应用命名空间与全局状态

**位置**: `index.html` 第 1700-1800 行

```javascript
var APP_VERSION = '1.5.7';
window.App = window.App || {
  Version: APP_VERSION,
  BuildDate: '2026-07-29',
  State: {
    currentPage: 'dashboard',
    isDarkMode: false,
    hasOnboarded: localStorage.getItem('hasOnboarded') === 'true',
    Timers: { _stTimer: null, _resizeTimer: null, _recSeq: 0, _dataRestored: false },
    Update: { _updateApkUrl: '', _updateVersion: '', _updateNotes: [] },
    Filters: { _recFilterType: '全部', _fuelDays: 90 }
  },
  Utils: { /* 工具函数集合 */ }
};
```

**职责**:
- 定义全局应用命名空间，避免命名冲突
- 管理应用状态（当前页面、主题、引导状态等）
- 提供通用工具函数（防抖、节流、存储封装等）

### 2. 工具函数模块 (App.Utils)

#### 2.1 防抖与节流

```javascript
debounce: function(func, wait) {
  var timeout;
  return function executedFunction(...args) {
    const later = () => { clearTimeout(timeout); func(...args); };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

throttle: function(func, limit) {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}
```

**用途**: 优化高频触发事件（搜索输入、窗口缩放等）的性能。

#### 2.2 存储封装 (App.Utils.Storage)

```javascript
Storage: {
  get: function(key, defaultValue = null) {
    try { 
      const value = localStorage.getItem(key); 
      return value ? JSON.parse(value) : defaultValue; 
    } catch (e) { 
      console.warn(`[App.Utils.Storage] 读取失败: ${key}`, e); 
      return defaultValue; 
    }
  },
  set: function(key, value) {
    try { 
      localStorage.setItem(key, JSON.stringify(value)); 
      return true; 
    } catch (e) { 
      console.warn(`[App.Utils.Storage] 写入失败: ${key}`, e); 
      return false; 
    }
  },
  remove: function(key) {
    try { 
      localStorage.removeItem(key); 
      return true; 
    } catch (e) { 
      console.warn(`[App.Utils.Storage] 删除失败: ${key}`, e); 
      return false; 
    }
  }
}
```

**职责**:
- 封装 localStorage 操作，统一异常处理
- 自动序列化/反序列化 JSON 数据
- 提供安全的默认值机制

### 3. 用户认证模块

#### 3.1 密码安全机制

**位置**: `index.html` 第 2935-3035 行

```javascript
var PWD_ITER = 120000; // PBKDF2 迭代次数

async function pwdVerifier(plain) {
  var salt = _randBytes(16);
  try {
    var km = await crypto.subtle.importKey('raw', _toUtf8(plain), 'PBKDF2', false, ['deriveBits']);
    var bits = await crypto.subtle.deriveBits(
      { name:'PBKDF2', salt:salt, iterations:PWD_ITER, hash:'SHA-256' }, 
      km, 256
    );
    return { 
      salt: _b64uFromBytes(salt), 
      hash: _b64uFromBytes(new Uint8Array(bits)), 
      algo: 'pbkdf2' 
    };
  } catch(e) { 
    // 降级到 SHA-256 兜底方案
    var sb = _b64uFromBytes(salt);
    return { salt: sb, hash: _jsSha256Hex(_toUtf8(sb + ':' + plain)), algo: 'sha256' };
  }
}

async function pwdVerify(plain, v) {
  if (!v) return false;
  if (v.pwd !== undefined && !v.hash) return v.pwd === plain; // 旧明文兼容
  if (!v.hash) return false;
  
  if (v.algo === 'sha256' || !_subtleOk()) {
    return _jsSha256Hex(_toUtf8((v.salt || '') + ':' + plain)) === v.hash;
  }
  
  var salt = _bytesFromB64u(v.salt);
  try {
    var km = await crypto.subtle.importKey('raw', _toUtf8(plain), 'PBKDF2', false, ['deriveBits']);
    var bits = await crypto.subtle.deriveBits(
      { name:'PBKDF2', salt:salt, iterations:PWD_ITER, hash:'SHA-256' }, 
      km, 256
    );
    return _b64uFromBytes(new Uint8Array(bits)) === v.hash;
  } catch(e) { 
    return false; 
  }
}
```

**安全特性**:
- 使用 PBKDF2 算法（120,000 次迭代）防止暴力破解
- 每用户使用独立随机盐值（16 字节）
- 支持 Web Crypto API 不可用时降级到纯 JS SHA-256 实现
- 旧账号自动迁移（明文 → 哈希）

#### 3.2 生物识别登录

**位置**: `index.html` 第 3309-3368 行

```javascript
function biometricLogin() {
  if (!requireConsent()) return;
  var B = getBiometricPlugin();
  if (!B) { toast('当前环境不支持生物识别登录'); return; }
  
  var phone = _bioRememberedPhone();
  if (!phone) { toast('请先使用密码登录一次'); return; }
  
  B.internalAuthenticate({
    androidTitle: '车辆助理',
    reason: '验证身份以登录车辆助理',
    allowDeviceCredential: true  // 允许回退到屏幕锁
  })
  .then(function() {
    directLogin(phone);  // 原生验证成功即登录
  })
  .catch(function(err) {
    var msg = (err && (err.message || err.errorMessage)) || '';
    if (msg && /cancel/i.test(msg)) return; // 用户取消不报错
    toast('生物识别验证未通过，请使用密码登录');
  });
}
```

**支持的生物识别方式**:
- 指纹识别
- 面容识别
- 屏幕锁 PIN/图案/密码（回退方案）

#### 3.3 账号管理

```javascript
var ACC_KEY = 'clz_accounts';
var SESSION_KEY = 'clz_session';

function getAccounts() {
  try { 
    var v = App.Utils.Storage.get(ACC_KEY); 
    if (v && v.length) return v; 
  } catch(e) {}
  return [];
}

function saveAccounts(a) {
  try { App.Utils.Storage.set(ACC_KEY, a); } catch(e) {}
  // 同时写一份到 Filesystem 作为冗余备份
  try {
    var Fs = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
    if (Fs && Fs.writeFile) {
      Fs.writeFile({ 
        path: 'ycj_accounts_backup.json', 
        data: JSON.stringify(a), 
        directory: 'DATA', 
        encoding: 'utf8' 
      }).catch(function(){});
    }
  } catch(e) {}
  backupFullData();
}
```

**数据备份策略**:
- 主存储：localStorage（快速访问）
- 冗余备份：Capacitor Filesystem（防止 WebView 数据被清空）
- 全量备份：账号 + 车辆 + 会话信息

### 4. 车辆管理模块

#### 4.1 数据结构

```javascript
// 车辆对象结构
{
  id: 'v_1234567890',
  name: '本田XR-V',
  plate: '沪A12345',
  brand: '本田',
  model: 'XR-V 2021款',
  year: 2021,
  mileage: 45280,           // 当前里程（km）
  fuel: '92',               // 燃油标号
  oil: '全合成',            // 机油类型
  photo: 'data:image/...',  // 车辆照片（Base64）
  
  // 保险信息
  insuranceDue: '2026-12-31',
  insuranceCompany: '平安保险',
  
  // 保养记录
  records: [
    {
      id: 'r_1234567890',
      type: '保养',         // 保养/维修/加油
      date: '2026-07-15',
      mileage: 45000,
      project: '更换机油机滤',
      amount: 450,
      note: '4S店保养',
      receipt: 'data:image/...'  // 小票照片
    }
  ],
  
  // 缓存字段
  _cachedSugs: null,        // 保养建议缓存
  _cachedStats: null        // 统计数据缓存
}
```

#### 4.2 核心函数

```javascript
// 获取当前车辆
function getCurrentVehicle() {
  var vehicles = App.Utils.Storage.get('clz_vehicles', {});
  var currentId = App.Utils.Storage.get('clz_current_vehicle');
  return vehicles[currentId] || null;
}

// 保存车辆
function saveVehicle(vehicle) {
  var vehicles = App.Utils.Storage.get('clz_vehicles', {});
  vehicles[vehicle.id] = vehicle;
  App.Utils.Storage.set('clz_vehicles', vehicles);
  backupFullData();
}

// 切换车辆
function switchVehicle(vehicleId) {
  App.Utils.Storage.set('clz_current_vehicle', vehicleId);
  renderDashboard();
}
```

### 5. 保养建议计算引擎

**位置**: `index.html` 第 5149-5207 行

#### 5.1 保养周期配置

```javascript
var CYCLES = [
  { key: 'oil', name: '机油机滤', icon: '🛢️', km: 5000, mon: 6, oilBased: true, note: '以机油类型为准' },
  { key: 'air', name: '空气滤芯', icon: '🌬️', km: 20000, mon: 12 },
  { key: 'ac', name: '空调滤芯', icon: '❄️', km: 20000, mon: 12 },
  { key: 'fuel', name: '燃油滤芯', icon: '⛽', km: 40000, mon: 24 },
  { key: 'spark', name: '火花塞', icon: '⚡', km: 40000, mon: 24 },
  { key: 'brake', name: '刹车油', icon: '🛑', km: 40000, mon: 24 },
  { key: 'trans', name: '变速箱油', icon: '⚙️', km: 60000, mon: 48 },
  { key: 'coolant', name: '防冻液', icon: '🌡️', km: 40000, mon: 24 },
  { key: 'belt', name: '正时皮带', icon: '🔗', km: 80000, mon: 60 },
  { key: 'tire', name: '轮胎换位', icon: '🛞', km: 10000, mon: 6 }
];

var OIL_CYCLE = {
  '矿物质': { km: 5000, mon: 6 },
  '半合成': { km: 7500, mon: 9 },
  '全合成': { km: 10000, mon: 12 }
};
```

#### 5.2 计算逻辑

```javascript
function computeSuggestions(v) {
  if (v._cachedSugs) return v._cachedSugs;
  
  var today = new Date();
  var result = CYCLES.map(function(item) {
    // 根据机油类型调整周期
    var cyc = item.oilBased ? (OIL_CYCLE[v.oil] || OIL_CYCLE['全合成']) : { km: item.km, mon: item.mon };
    var itemKm = cyc.km, itemMon = cyc.mon;
    
    // 查找上次保养记录
    var ls = _lastService(v, item);
    var lastKm = ls.mileage || 0;
    var lastDate = ls.date ? new Date(ls.date) : null;
    
    // 计算剩余里程/时间
    var remainKm = itemKm - (v.mileage - lastKm);
    var remainMon = lastDate ? itemMon - _monthDiff(lastDate, today) : itemMon;
    
    // 判断状态
    var status, statusText, badgeShort, dueVal;
    if (remainKm <= 0 || remainMon <= 0) {
      status = 'red';
      statusText = '已超期';
      badgeShort = '超期';
      dueVal = Math.min(remainKm, remainMon);
    } else if (remainKm <= 1000 || remainMon <= 1) {
      status = 'amber';
      statusText = '即将到期';
      badgeShort = '临近';
      dueVal = Math.min(remainKm, remainMon);
    } else {
      status = 'green';
      statusText = '正常';
      badgeShort = '正常';
      dueVal = Math.min(remainKm, remainMon);
    }
    
    return {
      name: item.key,
      icon: item.icon,
      status: status,
      statusText: statusText,
      badgeShort: badgeShort,
      dueVal: dueVal,
      lastKm: lastKm.toLocaleString('en-US') + ' km',
      lastDate: lastDate ? _formatDate(lastDate) : '—',
      cycle: (itemKm > 0 ? ('每 ' + itemKm.toLocaleString('en-US') + ' km / ') : '') + itemMon + ' 个月',
      pct: Math.round(Math.max(0, Math.min(100, (1 - Math.min(remainKm, remainMon) / Math.max(itemKm, itemMon)) * 100))),
      cur: v.mileage.toLocaleString('en-US') + ' km',
      last: lastKm.toLocaleString('en-US'),
      remain: statusText,
      _remain: remainVal,
      note: item.note || ''
    };
  });
  
  v._cachedSugs = result;
  return result;
}
```

**算法说明**:
1. 根据机油类型动态调整机油保养周期
2. 查找每项保养的最后记录（按里程和时间）
3. 计算剩余里程和剩余月份
4. 根据阈值判断状态（红色超期、黄色临近、绿色正常）
5. 计算进度百分比用于可视化展示

### 6. 数据可视化模块

#### 6.1 费用构成环形图

**位置**: `index.html` 第 5400-5500 行

```javascript
function renderCostPie(items) {
  var chartEl = document.getElementById('costPieChart');
  if (!chartEl) return;
  
  // 计算各类费用总额
  var totals = { fuel: 0, maint: 0, repair: 0 };
  items.forEach(function(r) {
    if (r.type === '加油') totals.fuel += r.amount;
    else if (r.type === '保养') totals.maint += r.amount;
    else if (r.type === '维修') totals.repair += r.amount;
  });
  
  var total = totals.fuel + totals.maint + totals.repair;
  if (total === 0) {
    chartEl.innerHTML = '<div style="color:var(--gray2);text-align:center;padding:40px">暂无费用记录</div>';
    return;
  }
  
  // SVG 环形图参数
  var size = 200, cx = 100, cy = 100, r = 70, stroke = 30;
  var circumference = 2 * Math.PI * r;
  var offset = 0;
  
  var segments = [
    { key: 'fuel', label: '加油', color: 'var(--fuel)', value: totals.fuel },
    { key: 'maint', label: '保养', color: 'var(--maint)', value: totals.maint },
    { key: 'repair', label: '维修', color: 'var(--repair)', value: totals.repair }
  ];
  
  var groups = segments.map(function(seg) {
    if (seg.value === 0) return '';
    var pct = seg.value / total;
    var length = pct * circumference;
    var gap = circumference - length;
    var rotation = (offset / total) * 360 - 90;
    offset += seg.value;
    
    return '<g transform="rotate(' + rotation + ' ' + cx + ' ' + cy + ')">' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" ' +
      'fill="none" stroke="' + seg.color + '" stroke-width="' + stroke + '" ' +
      'stroke-dasharray="' + length + ' ' + gap + '" ' +
      'style="transition:stroke-dasharray .5s" />' +
      '</g>';
  }).join('');
  
  // 中心文字
  var centerText = '<text x="' + cx + '" y="' + (cy - 5) + '" ' +
    'text-anchor="middle" font-size="24" font-weight="700" fill="var(--ink)">' +
    '¥' + total.toLocaleString('en-US') + '</text>' +
    '<text x="' + cx + '" y="' + (cy + 15) + '" ' +
    'text-anchor="middle" font-size="12" fill="var(--gray2)">总费用</text>';
  
  var svgHtml = '<svg viewBox="-25 15 230 155" width="100%" style="max-width:210px;height:auto;overflow:visible" preserveAspectRatio="xMidYMid meet">' +
    groups + centerText + '</svg>';
  
  chartEl.innerHTML = svgHtml;
}
```

**技术要点**:
- 使用 SVG `<circle>` 的 `stroke-dasharray` 实现环形图
- 通过 `transform="rotate()"` 调整各段起始角度
- 支持 CSS 变量主题适配
- 响应式缩放（`viewBox` + `preserveAspectRatio`）

#### 6.2 油耗趋势折线图

```javascript
function renderFuelTrend(records) {
  var chartEl = document.getElementById('fuelTrendChart');
  if (!chartEl) return;
  
  // 筛选加油记录并按时间排序
  var fuelRecords = records
    .filter(function(r) { return r.type === '加油'; })
    .sort(function(a, b) { return new Date(a.date) - new Date(b.date); });
  
  if (fuelRecords.length < 2) {
    chartEl.innerHTML = '<div style="color:var(--gray2);text-align:center;padding:40px">至少需要 2 条加油记录</div>';
    return;
  }
  
  // 计算每次加油的油耗（L/100km）
  var dataPoints = [];
  for (var i = 1; i < fuelRecords.length; i++) {
    var prev = fuelRecords[i - 1];
    var curr = fuelRecords[i];
    var distance = curr.mileage - prev.mileage;
    if (distance > 0) {
      var consumption = (curr.amount / distance) * 100; // L/100km
      dataPoints.push({
        date: curr.date,
        value: consumption,
        distance: distance
      });
    }
  }
  
  // SVG 折线图绘制
  var width = 600, height = 200, padding = 40;
  var maxVal = Math.max.apply(null, dataPoints.map(function(d) { return d.value; }));
  var minVal = Math.min.apply(null, dataPoints.map(function(d) { return d.value; }));
  var range = maxVal - minVal || 1;
  
  var points = dataPoints.map(function(d, i) {
    var x = padding + (i / (dataPoints.length - 1)) * (width - 2 * padding);
    var y = height - padding - ((d.value - minVal) / range) * (height - 2 * padding);
    return x + ',' + y;
  }).join(' ');
  
  var svgHtml = '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" style="max-width:600px;height:auto">' +
    '<polyline points="' + points + '" fill="none" stroke="var(--fuel)" stroke-width="2" />' +
    '</svg>';
  
  chartEl.innerHTML = svgHtml;
}
```

### 7. 更新管理模块

#### 7.1 APK 更新流程

**位置**: `app-update-manager.js`

```javascript
(function (global) {
  'use strict';

  var APK_FILE_NAME = 'yangcheji-update.apk';

  // 版本号比较
  function isNewer(serverCode, localCode) {
    return Number(serverCode) > Number(localCode);
  }

  // 检查更新
  function checkAppUpdate(opts) {
    opts = opts || {};
    var silent = !!opts.silent;
    
    return fetchUpdateManifest()
      .then(function(manifest) {
        if (!manifest) return false;
        
        // ECDSA 签名校验
        return verifyUpdateSignature(manifest)
          .then(function(valid) {
            if (!valid) throw new Error('更新包签名校验失败');
            
            if (isNewer(manifest.versionCode, localVersionCode)) {
              showUpdateDialog(manifest);
              return true;
            }
            return false;
          });
      })
      .catch(function(err) {
        if (!silent) toast('检查更新失败：' + err.message);
        return false;
      });
  }

  // 下载并安装 APK
  function downloadAndInstall(url, sha256) {
    toast('正在下载安装包…', 2000);
    
    return downloadVerifyWrite(url, sha256, APK_FILE_NAME, '安装包')
      .then(function(path) {
        toast('校验通过，即将安装', 2000);
        return Capacitor.Plugins.UpdateInstaller.installApk({ path: path });
      })
      .then(function() { return true; });
  }
})(window);
```

#### 7.2 PWA 热更新

**位置**: `pwa-hot-update.js`

```javascript
function checkPwa(remotePwa, localVersion) {
  if (!remotePwa || !remotePwa.url) return Promise.resolve(false);
  if (!(Number(remotePwa.version) > Number(localVersion || 0))) return Promise.resolve(false);
  
  var P = plugins();
  if (!isNativeShell() || !P || !P.HotUpdate) return Promise.resolve(false);

  toast('发现 Web 资源更新，正在下载…', 2000);
  
  return downloadVerifyWrite(remotePwa.url, remotePwa.sha256, 'pwa-hot.zip', 'Web 资源')
    .then(function(path) {
      toast('校验通过，正在应用更新…', 2000);
      return P.HotUpdate.applyHotUpdate({ path: path, version: String(remotePwa.version) });
    })
    .then(function() { return true; });
}
```

**双通道更新策略**:
1. **APK 更新**：原生壳变更时，下载完整 APK 并拉起系统安装器
2. **PWA 热更新**：仅 Web 资源变更时，下载 zip 包并热替换，无需重装
3. **安全校验**：SHA-256 完整性校验 + ECDSA 签名校验（防篡改）

### 8. 数据导出/导入模块

**位置**: `index.html` 第 3487-3600 行

```javascript
function exportAllData() {
  var data = {
    _exportVersion: '1.0',
    _exportTime: new Date().toISOString(),
    _appName: '车辆助理',
    _appVersion: APP_VERSION,
    items: {}
  };
  
  // 收集所有 clz_ 开头的数据
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k.indexOf('clz_') === 0 || k === 'hasOnboarded') {
      try { 
        data.items[k] = JSON.parse(localStorage.getItem(k)); 
      } catch(e) { 
        data.items[k] = localStorage.getItem(k); 
      }
    }
  }
  
  // 导出为 JSON 文件
  var json = JSON.stringify(data, null, 2);
  var blob = new Blob([json], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var filename = '车辆助理_备份_' + new Date().toISOString().slice(0, 10) + '.json';
  
  // Capacitor 环境写入 Filesystem
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) {
    var reader = new FileReader();
    reader.onloadend = function() {
      var base64 = reader.result.split(',')[1];
      window.Capacitor.Plugins.Filesystem.writeFile({
        path: filename,
        data: base64,
        directory: 'DOCUMENTS',
        recursive: true
      }).then(function() {
        toast('备份已保存到 Documents/车辆助理');
      });
    };
    reader.readAsDataURL(blob);
  } else {
    // 浏览器环境下载
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}

function importAllData(evt) {
  var file = evt.target.files[0];
  if (!file) return;
  
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var data = JSON.parse(e.target.result);
      if (!data.items) throw new Error('无效的备份文件');
      
      // 恢复数据
      Object.keys(data.items).forEach(function(k) {
        try {
          localStorage.setItem(k, JSON.stringify(data.items[k]));
        } catch(e) {}
      });
      
      toast('数据已恢复，即将刷新');
      setTimeout(function() { location.reload(); }, 1500);
    } catch(err) {
      toast('导入失败：' + err.message);
    }
  };
  reader.readAsText(file);
}
```

**备份策略**:
- 导出所有 `clz_` 前缀的 localStorage 数据
- 不包含明文密码（仅哈希值）
- Capacitor 环境写入 `Documents/车辆助理` 目录
- 支持从 JSON 文件恢复

---

## UI 组件与页面

### 页面导航结构

```javascript
var NAV_CONFIG = [
  { page: 'dashboard', emoji: '📊', label: '仪表盘' },
  { page: 'add', emoji: '➕', label: '添加记录' },
  { page: 'advice', emoji: '💡', label: '保养建议' },
  { page: 'insurance', emoji: '🛡️', label: '车险管家' },
  { page: 'trouble', emoji: '🔍', label: '故障排查' },
  { page: 'profile', emoji: '👤', label: '个人中心' }
];
```

### 主要页面功能

#### 1. 仪表盘 (dashboard)

- 车辆概览卡片（车牌、品牌、里程）
- KPI 指标（本月费用、总费用、平均油耗）
- 最近养护记录列表
- 费用构成环形图
- 油耗趋势折线图

#### 2. 添加记录 (add)

- 记录类型选择（保养/维修/加油）
- 日期、里程、项目、费用输入
- 拍照记录小票（Base64 存储）
- 从历史模板快速填充
- 备注输入

#### 3. 保养建议 (advice)

- 车辆保养总览（超期/临近/正常统计）
- 各项保养建议卡片（机油、滤芯、刹车油等）
- 进度条可视化
- 一键添加保养记录

#### 4. 车险管家 (insurance)

- 车险到期提醒
- 保单信息管理
- 事故应急处理指南（城市/乡村/高速场景）
- 关键号码一键拨打（122/110/120/12122）
- 理赔注意事项

#### 5. 故障排查 (trouble)

- 故障现象搜索
- 热门故障标签（抖动、异响、亏电等）
- 分类筛选（发动机/电气/制动/空调/底盘）
- 故障原因与处理方案
- 收藏常用故障

#### 6. 个人中心 (profile)

- 个人资料编辑
- 车辆管理（添加/编辑/删除/切换）
- 设置中心（主题、通知、隐私）
- 账号安全（修改密码、生物识别、退出登录）
- 帮助与反馈
- 数据导出/导入
- 检查更新

---

## 依赖关系

### 原生插件依赖

```json
{
  "CapacitorHttp": { "enabled": true },
  "FileSystem": { "permissions": ["read", "write", "append"] },
  "Share": { "enabled": true },
  "Camera": { "enabled": true },
  "BiometricAuthNative": { "enabled": true },
  "UpdateInstaller": { "enabled": true },
  "HotUpdate": { "enabled": true }
}
```

### 外部资源依赖

- **字体**: Inter（Google Fonts）+ JetBrains Mono
- **图标**: Emoji（系统原生）
- **网络**: 更新服务器（version.json 清单）

### 浏览器 API 依赖

- `localStorage` - 本地数据存储
- `crypto.subtle` - Web Crypto API（PBKDF2、ECDSA）
- `FileReader` - 文件读取
- `Blob` + `URL.createObjectURL` - 文件下载
- `SVG` - 数据可视化

---

## 项目运行方式

### 开发环境

1. **前端开发**:
   - 直接修改 `index.html`（单文件架构）
   - 使用浏览器开发者工具调试
   - 本地 HTTP 服务器访问（如 `python -m http.server`）

2. **Android 构建**:
   ```bash
   # 安装依赖
   npm install @capacitor/core @capacitor/android
   
   # 同步 Web 资源到 Android
   npx cap sync android
   
   # 打开 Android Studio
   npx cap open android
   ```

3. **调试运行**:
   - Android Studio 连接设备/模拟器
   - 运行 App 并通过 Chrome DevTools 远程调试 WebView

### 生产环境

1. **构建 APK**:
   - Android Studio → Build → Generate Signed Bundle/APK
   - 签名配置（keystore）
   - 生成 release APK

2. **发布更新**:
   - 上传 APK 到更新服务器
   - 生成 `version.json` 清单文件
   - 使用私钥签名（ECDSA P-256）
   - 客户端检查更新并下载安装

### 数据迁移

**旧版本升级**:
```javascript
async function migrateAccountPasswords() {
  var accs = getAccounts();
  if (!accs.length) return;
  
  var changed = false;
  for (var i = 0; i < accs.length; i++) {
    // 旧明文账号迁移为 salt+hash
    if (accs[i].pwd !== undefined && !accs[i].hash) {
      var v = await pwdVerifier(accs[i].pwd);
      accs[i].salt = v.salt;
      accs[i].hash = v.hash;
      accs[i].algo = v.algo;
      delete accs[i].pwd;
      changed = true;
    }
  }
  
  if (changed) saveAccounts(accs);
}
```

---

## 安全机制

### 1. 密码安全

- **算法**: PBKDF2（120,000 次迭代）+ SHA-256
- **盐值**: 16 字节随机盐（每用户独立）
- **降级**: Web Crypto API 不可用时使用纯 JS SHA-256
- **迁移**: 旧明文账号自动迁移为哈希存储

### 2. 更新安全

- **完整性**: SHA-256 校验下载文件
- ** authenticity**: ECDSA P-256 签名校验更新清单
- **私钥保护**: 私钥不入库（`.gitignore`），仅存于开发者本地

### 3. 数据安全

- **本地存储**: 所有数据仅存于设备本地
- **备份加密**: 导出的 JSON 文件不包含明文密码
- **隐私协议**: 用户需同意隐私政策才能使用
- **撤回同意**: 支持撤回同意并清除所有本地数据

### 4. 生物识别

- **原生验证**: 调用 Android 生物识别 API
- **回退方案**: 支持屏幕锁 PIN/图案/密码
- **安全登录**: 原生验证成功即登录，不依赖本地明文密码

---

## 性能优化

### 1. 渲染优化

- **防抖/节流**: 搜索输入、窗口缩放等高频事件
- **缓存机制**: 保养建议、统计数据缓存到车辆对象
- **懒加载**: 页面按需渲染（`display: none/flex`）

### 2. 存储优化

- **JSON 序列化**: 仅在读写时序列化，内存中保持对象
- **增量备份**: 仅备份变化的数据
- **Base64 图片**: 小票照片压缩后存储

### 3. 网络优化

- **缓存破坏**: 更新请求添加时间戳参数
- **超时控制**: HTTP 请求设置 15s 连接/读取超时
- **静默检查**: 后台静默检查更新，不打扰用户

---

## 常见问题与解决方案

### 1. WebView 数据丢失

**问题**: Android 系统清理或应用更新后 localStorage 被清空

**解决**:
- 启动时从 Capacitor Filesystem 恢复备份
- 每次保存时同步写入 Filesystem 冗余备份
- 全量备份（账号 + 车辆 + 会话）

### 2. 生物识别不可用

**问题**: 设备不支持或未录入生物识别

**解决**:
- 检测插件可用性后再显示按钮
- 提供密码登录回退方案
- 允许回退到屏幕锁验证

### 3. 更新下载失败

**问题**: 网络不稳定导致 APK 下载中断

**解决**:
- SHA-256 校验完整性
- 校验失败则终止安装
- 提示用户重试

### 4. 大数据量性能

**问题**: 养护记录过多导致渲染卡顿

**解决**:
- 分页加载（最近 50 条）
- 虚拟滚动（未来优化）
- 数据缓存减少重复计算

---

## 开发规范

### 1. 代码风格

- **命名**: 驼峰命名法（`camelCase`）
- **常量**: 全大写下划线（`PWD_ITER`）
- **注释**: 关键函数必须注释，复杂逻辑添加行内注释
- **缩进**: 2 空格

### 2. 错误处理

- **try-catch**: 所有可能抛出异常的操作
- **降级方案**: Web Crypto API 不可用时降级到纯 JS 实现
- **用户提示**: `toast()` 函数统一提示

### 3. 兼容性

- **浏览器**: Chrome 80+（Android WebView）
- **API**: Web Crypto API、localStorage、FileReader
- **设备**: Android 7.0+（API 24+）

---

## 版本历史

### v1.5.7 (2026-07-29)

- 新增：生物识别登录（指纹/面容/屏幕锁）
- 新增：PWA 热更新支持
- 优化：密码安全升级为 PBKDF2
- 修复：数据导出在部分设备上失败

### v1.5.0 (2026-06-15)

- 新增：车险管家与应急处理指南
- 新增：故障排查知识库
- 优化：保养建议计算引擎
- 优化：费用构成环形图可视化

### v1.4.0 (2026-05-01)

- 新增：多车辆管理
- 新增：数据导出/导入
- 新增：深色模式
- 优化：UI 响应式布局

---

## 联系方式

- **开发人员**: 程远红
- **邮箱**: cyh2299@hotmail.com
- **项目仓库**: [GitHub](https://github.com/example/vehicle-assistant)

---

## 许可证

本项目为商业软件，版权所有归开发团队所有。

---

**文档生成时间**: 2026-08-11  
**文档版本**: 1.0  
**适用应用版本**: v1.5.7
