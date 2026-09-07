// main-test.js —— 最小测试 require('electron') 是否返回 API
const e = require('electron');
console.log('typeof require(electron):', typeof e);
console.log('keys:', Object.keys(e || {}).slice(0, 10));
console.log('has app:', typeof e.app);
console.log('versions.electron:', process.versions.electron);
const { app, BrowserWindow } = require('electron');
if (app) {
  app.whenReady().then(() => { console.log('READY'); app.exit(0); });
} else {
  console.log('FAIL: app is undefined');
  process.exit(1);
}