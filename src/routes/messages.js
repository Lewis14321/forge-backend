const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');

async function canAccessMilestone(milestoneId, userId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM milestones m
     JOIN projects p ON m.project_id = p.id
     WHERE m.id = $1 AND (
       p.creator_id = $2
       OR m.claimed_by = $2
       OR EXISTS (SELECT 1 FROM project_builders pb WHERE pb.project_id = p.id AND pb.builder_id = $2)
     )`,
    [milestoneId, userId]
  );
  return rows.length > 0;
}

// GET /messages/milestone/:id — list messages
router.get('/milestone/:id', auth, async (req, res) => {
  try {
    if (!(await canAccessMilestone(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { rows } = await pool.query(
      `SELECT mm.*, u.name AS sender_name
       FROM milestone_messages mm
       JOIN users u ON mm.sender_id = u.id
       WHERE mm.milestone_id = $1
       ORDER BY mm.created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /messages/milestone/:id — send a message
router.post('/milestone/:id', auth, async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Message body required' });
  if (body.trim().length > 2000) return res.status(400).json({ error: 'Message too long (max 2000 chars)' });
  try {
    if (!(await canAccessMilestone(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { rows } = await pool.query(
      `INSERT INTO milestone_messages (milestone_id, sender_id, body)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, req.user.id, body.trim()]
    );
    const { rows: [withSender] } = await pool.query(
      `SELECT mm.*, u.name AS sender_name FROM milestone_messages mm JOIN users u ON mm.sender_id = u.id WHERE mm.id = $1`,
      [rows[0].id]
    );
    res.status(201).json(withSender);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
