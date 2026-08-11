/* ============================================================
 * 车辆助理 · 自建应用内更新管理器（无第三方插件依赖）
 * ------------------------------------------------------------
 * 更新流程：
 *   1. 启动/手动触发时请求 {updateServer}/version.json
 *   2. 比较 versionCode，若服务器更新则弹出更新弹窗
 *   3. 用户点击“立即更新”→ 下载 apk 到应用缓存目录
 *   4. 调用原生插件 UpdateInstaller 拉起系统安装器，覆盖安装
 *      （同包名 + 同签名 + versionCode 递增 ⇒ 用户数据保留，无需卸载）
 * ============================================================ */
(function (global) {
  'use strict';

  var APK_FILE_NAME = 'yangcheji-update.apk';

  // 版本号比较：返回 true 表示服务器版本比本地新
  function isNewer(serverCode, localCode) {
    return Number(serverCode) > Number(localCode);
  }

  function cfg() {
    return global.APP_CONFIG || {
      version: '1.0.0', versionCode: 1,
      updateServer: '', autoCheckOnLaunch: true
    };
  }

  // 判断是否为绝对地址（http:// 或 https://），用于支持 Gitee Releases 等跨目录托管
  function isAbsoluteUrl(u) {
    return /^https?:\/\//i.test(String(u || ''));
  }

  // 计算 Blob 的 SHA-256 十六进制串（用于升级包完整性校验）
  // 环境不支持 crypto.subtle 时返回 null（调用方跳过校验）
  function sha256Hex(blob) {
    var c = global.crypto;
    if (!c || !c.subtle || !c.subtle.digest || typeof blob.arrayBuffer !== 'function') {
      return Promise.resolve(null);
    }
    return blob.arrayBuffer().then(function (buf) {
      return c.subtle.digest('SHA-256', buf);
    }).then(function (digest) {
      return Array.prototype.map.call(new Uint8Array(digest), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    }).catch(function () { return null; });
  }

  // 将 Blob/ArrayBuffer 转为 base64 字符串（用于 Filesystem 写入）
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

  function setProgress(pct, text) {
    var bar = document.getElementById('updProgress');
    var label = document.getElementById('updProgressText');
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (label && text != null) label.textContent = text;
  }

  function setButtonsState(downloading) {
    var yes = document.getElementById('updBtnUpdate');
    var later = document.getElementById('updBtnLater');
    if (yes) { yes.disabled = downloading; yes.textContent = downloading ? '下载中…' : '立即更新'; }
    if (later) later.disabled = downloading;
  }

  // 拉起原生安装器（覆盖安装）
  function installApk(filePath) {
    return new Promise(function (resolve, reject) {
      var Plugins = global.Capacitor && global.Capacitor.Plugins;
      if (!Plugins || !Plugins.UpdateInstaller) {
        reject(new Error('原生安装插件不可用'));
        return;
      }
      Plugins.UpdateInstaller.installApk({ path: filePath })
        .then(function () { resolve(); })
        .catch(function (e) { reject(e); });
    });
  }

  // 下载 apk 并写入缓存目录，返回文件绝对路径
  function downloadApk(apkUrl, onProgress) {
    return fetch(apkUrl).then(function (resp) {
      if (!resp.ok) throw new Error('下载失败 HTTP ' + resp.status);
      var total = Number(resp.headers.get('content-length')) || 0;
      var reader = resp.body.getReader();
      var chunks = [];
      var received = 0;
      return new Promise(function (resolve, reject) {
        function pump() {
          reader.read().then(function (r) {
            if (r.done) {
              var blob = new Blob(chunks);
              if (onProgress) onProgress(100);
              resolve(blob);
              return;
            }
            chunks.push(r.value);
            received += r.value.length;
            if (total) onProgress && onProgress(Math.round((received / total) * 100));
            else onProgress && onProgress(-1);
            pump();
          }).catch(reject);
        }
        pump();
      });
    }).then(function (blob) {
      var shaPromise = sha256Hex(blob);
      return blobToBase64(blob).then(function (b64) {
        return shaPromise.then(function (sha) { return { b64: b64, sha256: sha }; });
      });
    }).then(function (obj) {
      return global.Capacitor.Plugins.Filesystem.writeFile({
        path: APK_FILE_NAME,
        data: obj.b64,
        directory: 'CACHE',
        recursive: true
      }).then(function () { return obj.sha256; });
    }).then(function (sha256) {
      return global.Capacitor.Plugins.Filesystem.getUri({
        path: APK_FILE_NAME,
        directory: 'CACHE'
      }).then(function (res) {
        // getUri 返回 file:// 形式的真实路径
        var uri = res && res.uri || '';
        return { path: uri.replace(/^file:\/\//, ''), sha256: sha256 };
      });
    });
  }

  // 执行完整更新：下载 + 安装
  function performUpdate(apkUrl, expectedSha256) {
    setButtonsState(true);
    var bar = document.getElementById('updBar');
    if (bar) bar.style.display = 'block';
    setProgress(0, '准备下载…');
    downloadApk(apkUrl, function (pct) {
      if (pct < 0) setProgress(0, '下载中…');
      else setProgress(pct, '下载中 ' + pct + '%');
    }).then(function (result) {
      var filePath = result && result.path ? result.path : result;
      setProgress(100, '校验完整性…');
      if (expectedSha256) {
        var got = (result && result.sha256 || '').toLowerCase();
        if (got && got !== String(expectedSha256).toLowerCase()) {
          throw new Error('安装包校验失败（SHA-256 不匹配），已终止以防被篡改');
        }
      }
      setProgress(100, '正在拉起安装…');
      return installApk(filePath);
    }).then(function () {
      // 系统安装器已拉起，本弹窗可关闭
      closeModal('updateModal');
    }).catch(function (err) {
      console.error('[更新] 失败:', err);
      setButtonsState(false);
      setProgress(0, '');
      var tip = document.getElementById('updTip');
      if (tip) {
        tip.textContent = '更新失败：' + (err && err.message ? err.message : err) + '。请检查网络或前往发布页手动下载。';
        tip.style.display = 'block';
      }
      // 若原生插件不可用，给出降级提示
      if (err && err.message === '原生安装插件不可用') {
        var p = document.getElementById('updApkPath');
        if (p) { p.style.display = 'block'; }
      }
    });
  }

  // 弹出更新弹窗
  function showUpdateModal(info) {
    var title = document.getElementById('updTitle');
    var log = document.getElementById('updChangelog');
    var tip = document.getElementById('updTip');
    var p = document.getElementById('updApkPath');
    if (title) title.textContent = '发现新版本 v' + info.version;
    if (log) {
      if (Array.isArray(info.changelog) && info.changelog.length) {
        log.innerHTML = info.changelog.map(function (s) {
          return '<li>' + String(s).replace(/</g, '&lt;') + '</li>';
        }).join('');
      } else if (typeof info.changelog === 'string' && info.changelog) {
        log.innerHTML = '<li>' + String(info.changelog).replace(/</g, '&lt;') + '</li>';
      } else {
        log.innerHTML = '<li>体验优化与问题修复</li>';
      }
    }
    if (tip) { tip.style.display = 'none'; tip.textContent = ''; }
    if (p) { p.style.display = 'none'; p.textContent = ''; }
    setProgress(0, '');
    setButtonsState(false);
    openModal('updateModal');
    // 绑定一次性事件
    var btn = document.getElementById('updBtnUpdate');
    if (btn) {
      btn.onclick = function () { performUpdate(info.apkUrl, info.sha256); };
    }
  }

  // 检查更新
  // showIfNone: 无更新时是否弹 toast 提示（手动检查用 true）
  function checkForUpdate(showIfNone) {
    var c = cfg();
    if (!c.updateServer) {
      if (showIfNone) toast('未配置更新服务器地址');
      return Promise.resolve(false);
    }
    var url = c.updateServer.replace(/\/+$/, '') + '/version.json?t=' + Date.now();
    // 原生壳内走 CapacitorHttp（Gitee raw 无 CORS 头，标准 fetch 会被拦截）
    var kit = global.PwaHotUpdate;
    var fetchManifest = (kit && kit.isNativeShell())
      ? kit.httpGetJson(url)
      : fetch(url).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        });
    return fetchManifest.then(function (info) {
      if (!info || !info.versionCode) throw new Error('version.json 格式错误');
      if (isNewer(info.versionCode, c.versionCode)) {
        showUpdateModal({
          version: info.version || String(info.versionCode),
          changelog: info.changelog || [],
          apkUrl: (isAbsoluteUrl(info.apk)
            ? String(info.apk)
            : (c.updateServer.replace(/\/+$/, '') + '/' + String(info.apk).replace(/^\/+/, ''))),
          sha256: info.sha256,
          force: !!info.force
        });
        return true;
      }
      // APK 无更新 → 尝试内嵌 PWA 热更新（仅原生壳）
      if (kit && kit.isNativeShell() && info.pwa && info.pwa.url) {
        return kit.checkPwa(info.pwa, Number(c.pwaVersion || 0)).then(function (applied) {
          if (applied) {
            toast('资源已更新，正在重启界面…');
            return true;
          }
          if (showIfNone) toast('已是最新版本 v' + c.version);
          return false;
        }).catch(function (e) {
          console.warn('[热更新] 失败:', e);
          if (showIfNone) toast('已是最新版本 v' + c.version);
          return false;
        });
      }
      if (showIfNone) toast('已是最新版本 v' + c.version);
      return false;
    }).catch(function (err) {
      console.warn('[更新] 检查失败:', err);
      if (showIfNone) toast('检查更新失败：' + (err && err.message ? err.message : err));
      return false;
    });
  }

  // 暴露到全局
  global.AppUpdate = {
    check: checkForUpdate,
    checkSilent: function () { return checkForUpdate(false); },
    checkManual: function () { return checkForUpdate(true); }
  };

  // 启动后自动检查（延迟一点，避免阻塞首屏）
  if (cfg().autoCheckOnLaunch) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(function () { checkForUpdate(false); }, 2500);
    } else {
      window.addEventListener('DOMContentLoaded', function () {
        setTimeout(function () { checkForUpdate(false); }, 2500);
      });
    }
  }
})(window);
