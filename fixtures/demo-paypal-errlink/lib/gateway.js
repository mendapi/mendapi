// Internal HTTP gateway router — no PayPal context in this file. The
// method-verb guards below use the same withdrawn verbs but sit on plain
// request routing, and the whole file must stay byte-identical after the
// pack runs (file-level guard negative site).

function route(req, res) {
  if (req.method === 'CONNECT') return res.end('tunnel unsupported');
  if (req.method === 'HEAD' || req.method === 'OPTIONS') return res.end();
  return dispatch(req, res);
}

function dispatch(req, res) {
  res.end('ok');
}

module.exports = { route };
