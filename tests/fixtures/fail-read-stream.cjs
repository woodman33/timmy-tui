// Test double (fault injection), loaded with `node --require` ahead of the preview server: a read stream
// for any file named broken.html fails the way fs.createReadStream does when its open fails (an unreadable
// file, or one removed after the server checked it): an 'error' event right after it is made, EACCES here.
const fs = require('node:fs');
const { Readable } = require('node:stream');
const original = fs.createReadStream;
fs.createReadStream = function (file, options) {
  if (String(file).endsWith('broken.html')) {
    const stream = new Readable({ read() {} });
    process.nextTick(() => stream.destroy(Object.assign(new Error('EACCES: permission denied (injected)'), { code: 'EACCES' })));
    return stream;
  }
  return original.call(fs, file, options);
};
