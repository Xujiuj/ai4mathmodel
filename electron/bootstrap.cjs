const { app } = require('electron');

if (app.isPackaged) {
  require('bytenode');
  require('./protected/loader.jsc');
} else {
  require('./main.cjs');
}
