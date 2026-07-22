const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db/pool');
const { sendPasswordReset } = require('../lib/email');

router.post('/register', async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'All fields required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!['creator', 'builder'].includes(role)) {
    return res.status(400).json({ error: 'Role must be creator or builder' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password, role) VALUES ($1,$2,$3,$4) RETURNING id, name, email, role, avg_rating',
      [name, email, hash, role]
    );
    const token = jwt.sign({ id: rows[0].id, role: rows[0].role, is_admin: false }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ user: rows[0], token });
  } catch (err) {
    console.error('Registration error:', err.message);
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' });
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, rows[0].password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    if (rows[0].account_status === 'suspended') return res.status(403).json({ error: 'Account suspended' });
    const { password: _, ...user } = rows[0];
    const token = jwt.sign({ id: user.id, role: user.role, is_admin: user.is_admin || false }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ user, token });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/me', require('../middleware/auth').auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, role, avg_rating, rating_count, bio, skills, tagline, is_admin, account_status, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/me/enable-role', require('../middleware/auth').auth, async (req, res) => {
  const { role } = req.body;
  if (!['creator', 'builder'].includes(role)) {
    return res.status(400).json({ error: 'Role must be creator or builder' });
  }
  try {
    const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const current = rows[0].role;
    if (current === role || current === 'both') {
      return res.status(400).json({ error: 'Role already enabled' });
    }
    const { rows: updated } = await pool.query(
      `UPDATE users SET role = 'both' WHERE id = $1
       RETURNING id, name, email, role, avg_rating, rating_count, bio, skills, tagline, created_at`,
      [req.user.id]
    );
    const newToken = jwt.sign({ id: updated[0].id, role: updated[0].role, is_admin: req.user.is_admin || false }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ user: updated[0], token: newToken });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const { rows } = await pool.query('SELECT id, name FROM users WHERE email = $1', [email]);
    if (rows.length) {
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 15 * 60 * 1000);
      await pool.query(
        'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
        [rows[0].id, token, expires]
      );
      const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password?token=${token}`;
      await sendPasswordReset(email, rows[0].name, resetUrl);
    }
    res.json({ message: 'If this email is registered, a reset link has been sent.' });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, user_id FROM password_reset_tokens WHERE token = $1 AND used = false AND expires_at > NOW()',
      [token]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Reset link is invalid or has expired.' });
    }
    const hash = await bcrypt.hash(password, 10);
    await client.query('UPDATE users SET password = $1 WHERE id = $2', [hash, rows[0].user_id]);
    await client.query('UPDATE password_reset_tokens SET used = true WHERE id = $1', [rows[0].id]);
    await client.query('COMMIT');
    res.json({ message: 'Password updated. You can now sign in.' });
  } catch {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.patch('/me', require('../middleware/auth').auth, async (req, res) => {
  const { name, bio, skills, tagline } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE users SET
        name    = COALESCE($1, name),
        bio     = COALESCE($2, bio),
        skills  = COALESCE($3, skills),
        tagline = COALESCE($4, tagline)
       WHERE id = $5
       RETURNING id, name, email, role, avg_rating, rating_count, bio, skills, tagline, created_at`,
      [name || null, bio != null ? bio : null, skills || null, tagline != null ? tagline : null, req.user.id]
    );
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
