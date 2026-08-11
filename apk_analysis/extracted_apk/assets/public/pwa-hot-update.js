/**
 * 统一升级工具包（三端通用：家电维修助手 / 车辆助理 / LexiMaster）
 * ------------------------------------------------------------
 * 统一方案：APK + SHA-256 校验 + 内嵌 PWA 热更新
 *
 * 两条升级通道：
 *   1) 壳更新（APK）：远程 versionCode 更大 → 下载 apk → SHA-256 校验 → 拉起系统安装器
 *   2) Web 热更新（PWA）：壳不变、web 资源版本更大 → 下载 zip → SHA-256 校验
 *      → 原生解压到 filesDir/hot/public → 切换资源根 → 重载 WebView
 *
 * 远程清单统一 schema：
 *   {
 *     "version": "2.2.0", "versionCode": 20200,
 *     "url":     "https://.../app.apk",       // apk 直链
 *     "sha256":  "<apk 的 sha256>",            // 缺省则跳过校验（不推荐）
 *     "pwa": { "version": 3, "url": "https://.../web.zip", "sha256": "<zip 的 sha256>" }
 *   }
 *
 * 网络层说明（重要）：
 *   Gitee raw 不返回 Access-Control-Allow-Origin，原生壳内（origin=https://localhost）
 *   直接 fetch 会被 CORS 拦截。因此原生环境统一走 Capacitor 内置 CapacitorHttp 插件
 *   （原生发起请求，不受 CORS 约束）；纯浏览器环境回退到标准 fetch。
 *
 * 依赖：原生插件 HotUpdate（含 saveBase64 落盘能力）+ UpdateInstaller
 *       不强依赖 @capacitor/filesystem（避免额外 Kotlin 工具链），
 *       若工程内恰好装了 Filesystem 则作为兜底写入通道。
 *       纯浏览器环境自动降级为跳转下载。
 */
(function (global) {
  'use strict';

  /* ---------------- 环境探测 ---------------- */

  function plugins() {
    return (typeof global.Capacitor !== 'undefined' && global.Capacitor.Plugins) ? global.Capacitor.Plugins : null;
  }

  // 是否运行在原生壳内（Capacitor WebView）
  function isNativeShell() {
    var C = global.Capacitor;
    if (!C) return false;
    var native = typeof C.isNativePlatform === 'function' ? C.isNativePlatform() : !!C.isNative;
    return !!native;
  }

  /* ---------------- 编解码与摘要 ---------------- */

  function base64ToBytes(b64) {
    var bin = global.atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bufToHex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  // 计算 SHA-256（十六进制小写）。环境不支持时返回 null（调用方据此跳过校验）
  function sha256FromBytes(bytes) {
    if (!global.crypto || !global.crypto.subtle || !global.crypto.subtle.digest) return Promise.resolve(null);
    return global.crypto.subtle.digest('SHA-256', bytes).then(bufToHex).catch(function () { return null; });
  }

  function sha256Base64(b64) {
    try {
      return sha256FromBytes(base64ToBytes(b64));
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function sha256Hex(blob) {
    if (typeof blob === 'string') return sha256Base64(blob);
    if (!blob || typeof blob.arrayBuffer !== 'function') return Promise.resolve(null);
    return blob.arrayBuffer().then(function (buf) { return sha256FromBytes(new Uint8Array(buf)); });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('读取文件失败')); };
      reader.onloadend = function () {
        var result = reader.result || '';
        var comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.readAsDataURL(blob);
    });
  }

  // 统一完整性校验：期望值为空 / 环境算不出摘要 → 放行；不一致 → 抛错
  function verifyBase64(b64, expected, label) {
    if (!expected) return Promise.resolve(b64);
    return sha256Base64(b64).then(function (got) {
      if (!got) return b64;
      if (got.toLowerCase() !== String(expected).toLowerCase()) {
        throw new Error(label + '校验失败（SHA-256 不匹配），已终止以防被篡改');
      }
      return b64;
    });
  }

  /* ---------------- 网络层（原生绕 CORS） ---------------- */

  function bust(url) {
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now();
  }

  /** 拉取 JSON 清单：原生走 CapacitorHttp，浏览器走 fetch */
  function httpGetJson(url) {
    var P = plugins();
    if (isNativeShell() && P && P.CapacitorHttp) {
      return P.CapacitorHttp.get({ url: bust(url), responseType: 'json', readTimeout: 15000, connectTimeout: 15000 })
        .then(function (res) {
          if (!res || res.status < 200 || res.status >= 300) throw new Error('HTTP ' + (res && res.status));
          return (typeof res.data === 'string') ? JSON.parse(res.data) : res.data;
        });
    }
    return fetch(url, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  /** 下载二进制并返回 base64：原生走 CapacitorHttp（blob→base64），浏览器走 fetch */
  function httpGetBase64(url) {
    var P = plugins();
    if (isNativeShell() && P && P.CapacitorHttp) {
      return P.CapacitorHttp.get({ url: bust(url), responseType: 'blob', readTimeout: 120000, connectTimeout: 30000 })
        .then(function (res) {
          if (!res || res.status < 200 || res.status >= 300) throw new Error('下载失败 HTTP ' + (res && res.status));
          return String(res.data || '');
        });
    }
    return fetch(url, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
        return res.blob();
      })
      .then(blobToBase64);
  }

  function toast(msg, ms) {
    if (global.App && typeof global.App.showToast === 'function') {
      try { global.App.showToast(msg, ms || 2000); } catch (e) { /* ignore */ }
    }
  }

  /**
   * base64 落盘：优先用自研 HotUpdate.saveBase64（纯 Java，无额外依赖），
   * 工程若装了 @capacitor/filesystem 则作为兜底。
   * @returns Promise<string> 文件绝对路径
   */
  function writeBase64(b64, fileName) {
    var P = plugins();
    if (P && P.HotUpdate && typeof P.HotUpdate.saveBase64 === 'function') {
      return P.HotUpdate.saveBase64({ fileName: fileName, data: b64 })
        .then(function (r) {
          var p = String((r && r.path) || '');
          if (!p) throw new Error('写入失败：未返回路径');
          return p;
        });
    }
    if (P && P.Filesystem) {
      return P.Filesystem.writeFile({ path: fileName, data: b64, directory: 'CACHE', recursive: true })
        .then(function () { return P.Filesystem.getUri({ path: fileName, directory: 'CACHE' }); })
        .then(function (res) { return String((res && res.uri) || '').replace(/^file:\/\//, ''); });
    }
    return Promise.reject(new Error('缺少文件写入能力（HotUpdate / Filesystem 均不可用）'));
  }

  /** 下载 → 校验 → 写入原生目录，返回本地绝对路径 */
  function downloadVerifyWrite(url, expectedSha, fileName, label) {
    return httpGetBase64(url)
      .then(function (b64) {
        if (!b64) throw new Error(label + '下载内容为空');
        toast('校验完整性…', 1500);
        return verifyBase64(b64, expectedSha, label);
      })
      .then(function (b64) {
        return writeBase64(b64, fileName);
      });
  }

  /* ---------------- 通道一：APK 更新 ---------------- */

  /**
   * 下载 APK → SHA-256 校验 → 拉起系统安装器
   * 非原生环境（浏览器 / PWA）自动降级为新窗口打开下载页。
   * @returns Promise<boolean> true=已进入安装流程
   */
  function installApk(url, expectedSha256) {
    if (!url) return Promise.reject(new Error('缺少安装包地址'));
    var P = plugins();
    if (!isNativeShell() || !P || !P.UpdateInstaller) {
      global.open(url, '_blank');
      return Promise.resolve(false);
    }
    toast('正在下载安装包…', 2000);
    return downloadVerifyWrite(url, expectedSha256, 'app-update.apk', '安装包')
      .then(function (path) {
        toast('校验通过，即将安装', 2000);
        return P.UpdateInstaller.installApk({ path: path });
      })
      .then(function () { return true; });
  }

  /* ---------------- 通道二：内嵌 PWA 热更新 ---------------- */

  /**
   * @param remotePwa    远程清单的 pwa 字段 { version, url, sha256 }
   * @param localVersion 本地 web 资源版本（整数）
   * @returns Promise<boolean> 是否执行了热更新
   */
  function checkPwa(remotePwa, localVersion) {
    if (!remotePwa || !remotePwa.url) return Promise.resolve(false);
    if (!(Number(remotePwa.version) > Number(localVersion || 0))) return Promise.resolve(false);
    var P = plugins();
    if (!isNativeShell() || !P || !P.HotUpdate) return Promise.resolve(false);

    toast('发现 Web 资源更新，正在下载…', 2000);
    return downloadVerifyWrite(remotePwa.url, remotePwa.sha256, 'pwa-hot.zip', 'Web 资源')
      .then(function (path) {
        toast('校验通过，正在应用更新…', 2000);
        return P.HotUpdate.applyHotUpdate({ path: path, version: String(remotePwa.version) });
      })
      .then(function () { return true; });
  }

  /** 读取当前生效的 web 资源版本（未热更新过返回 ''） */
  function getHotVersion() {
    var P = plugins();
    if (!P || !P.HotUpdate) return Promise.resolve('');
    return P.HotUpdate.getHotVersion()
      .then(function (r) { return (r && r.version) || ''; })
      .catch(function () { return ''; });
  }

  /** 热更新出问题时回滚到 APK 内置资源 */
  function resetToBundled() {
    var P = plugins();
    if (!P || !P.HotUpdate) return Promise.resolve(false);
    return P.HotUpdate.resetToBundled().then(function () { return true; });
  }

  /* ---------------- 对外 API ---------------- */

  var Kit = {
    isNativeShell: isNativeShell,
    httpGetJson: httpGetJson,
    httpGetBase64: httpGetBase64,
    sha256Hex: sha256Hex,
    sha256Base64: sha256Base64,
    blobToBase64: blobToBase64,
    verifyBase64: verifyBase64,
    installApk: installApk,
    check: checkPwa,          // 兼容旧调用名
    checkPwa: checkPwa,
    getHotVersion: getHotVersion,
    resetToBundled: resetToBundled
  };

  global.PwaHotUpdate = Kit;
  global.AppUpdateKit = Kit;
})(window);
