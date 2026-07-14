const jwt = require('jsonwebtoken');

function requireJwt(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token.' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function requireServiceKey(req, res, next) {
  if (req.headers['x-service-key'] !== process.env.SERVICE_KEY) {
    return res.status(403).json({ error: 'Invalid service credential.' });
  }
  return next();
}

module.exports = { requireJwt, requireServiceKey };
