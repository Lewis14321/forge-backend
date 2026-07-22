const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');

const VALID_REASONS = [
  'Fake account',
  'Inappropriate behavior',
  'Scam / fraud',
  'Plagiarism',
  'Spam',
  'Other',
];

// POST /reports
router.post('/', auth, async (req, res) => {
  const { target_type, target_id, reason } = req.body;
  if (!target_type || !target_id || !reason) {
    return res.status(400).json({ error: 'target_type, target_id, and reason required' });
  }
  if (!['user', 'project'].includes(target_type)) {
    return res.status(400).json({ error: 'target_type must be user or project' });
  }
  if (!VALID_REASONS.includes(reason)) {
    return res.status(400).json({ error: 'Invalid reason' });
  }
  if (target_type === 'user' && parseInt(target_id) === req.user.id) {
    return res.status(400).json({ error: 'You cannot report yourself' });
  }
  try {
    await pool.query(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES ($1, $2, $3, $4)`,
      [req.user.id, target_type, parseInt(target_id), reason]
    );
    res.status(201).json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Already reported' });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
