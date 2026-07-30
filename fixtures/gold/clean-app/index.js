// Gold fixture (negative control): a repo that uses none of the tracked
// providers. The scanner must report ZERO impacts here — any impact is a
// false positive and fails the precision gate.
const http = require('node:http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});

function start(port) {
  server.listen(port);
  return server;
}

module.exports = { start };
