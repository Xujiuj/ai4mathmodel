const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const profile = path.join(app.getPath('temp'), `math-modeling-workbench-capture-${Date.now()}`);
app.setPath('userData', profile);
process.env.VITE_DEV_SERVER_URL = '';
require('./main.cjs');

async function waitForWindow() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const window = BrowserWindow.getAllWindows()[0];
    if (window && !window.webContents.isLoading()) return window;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Application window did not become ready.');
}

app.whenReady().then(async () => {
  const window = await waitForWindow();
  window.setContentSize(1536, 1024);
  await new Promise((resolve) => setTimeout(resolve, 2600));
  const image = await window.webContents.capturePage();
  const output = path.join(__dirname, '..', 'design-implementation.png');
  fs.writeFileSync(output, image.toPNG());
  console.log(output);
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
