const { auth } = require('./auth');
const pool = require('../db/pool');

function adminAuth(req, res, next) {
  auth(req, res, async () => {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    // Verify admin flag from DB (not just JWT)
    try {
      const { rows } = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
      if (!rows.length || !rows[0].is_admin) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      next();
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });
}

module.exports = { adminAuth };
