const { app, BrowserWindow } = require('electron');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const root = mkdtempSync(join(tmpdir(), 'eve-b4-editor-'));
app.setPath('userData', root);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  await win.loadURL(process.argv[2]);
  const initial = await win.webContents.executeJavaScript(`(() => {
    const editor = document.getElementById('isolated-editor');
    editor.focus();
    editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromPaste' }));
    editor.value = 'Script-only fake insertion';
    editor.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste' }));
    const observation = window.isolatedEditorObserver.getObservation();
    window.isolatedEditorObserver.reset();
    return observation;
  })()`);
  await win.webContents.insertText('Fictional validation sentence.');
  const actual = await win.webContents.executeJavaScript('window.isolatedEditorObserver.getObservation()');
  console.log(JSON.stringify({ initial, actual }));
  win.destroy();
  app.quit();
}).catch(error => { console.error(error.message); app.exit(1); });
app.on('will-quit', () => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
