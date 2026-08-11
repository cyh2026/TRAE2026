/* ============================================================
 * 车辆助理 · 应用内更新配置（单一数据源）
 * ------------------------------------------------------------
 * 发版时请同步修改：
 *   1) 本文件的 version / versionCode
 *   2) android/app/build.gradle 的 versionCode / versionName
 *      （versionCode 必须单调递增，覆盖安装依赖它判断新旧）
 *   3) 更新服务器上的 version.json（见 update-server/version.json 示例）
 * ============================================================ */
window.APP_CONFIG = {
  // 展示版本号（与更新服务器 version.json 中的 version 对应）
  version: '1.5.7',

  // 整数版本号，必须单调递增，每次发版 +1
  versionCode: 10507,

  // 内嵌 PWA 资源包版本（热更新用）。只改 web 资源、不出新 APK 时 +1
  // 与远程 version.json 的 pwa.version 比较；远端更大 → 下载 zip → SHA256 校验 → 解压并切换资源根
  pwaVersion: 2,

  // 更新服务器基础地址：该目录下需放置 version.json 与新版 apk
  // 采用 Gitee 仓库 raw/master 直链（推上去即用，不依赖开启 Gitee Pages）
  //   updateServer: 'https://gitee.com/<账号>/<仓库名>/raw/master'
  // apk 下载地址见 version.json 的 apk 字段。
  updateServer: 'https://gitee.com/yuanhong2002/chelinangzhuli2026/raw/master',

  // 启动时是否自动检查更新（设置页仍提供手动“检查更新”入口）
  autoCheckOnLaunch: true
};
