const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');

// GET /users/:id — public profile
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, role, avg_rating, rating_count, bio, skills, tagline, created_at
       FROM users WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const user = rows[0];

    const [createdRes, contributedRes, reviewsRes, msStatsRes, msActivityRes, fundedRes] = await Promise.all([
      pool.query(
        `SELECT id, title, status, budget, tech_stack, created_at
         FROM projects WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 12`,
        [req.params.id]
      ),
      pool.query(
        `SELECT p.id, p.title, p.status, p.budget, p.tech_stack, pb.joined_at
         FROM project_builders pb JOIN projects p ON pb.project_id = p.id
         WHERE pb.builder_id = $1 ORDER BY pb.joined_at DESC LIMIT 12`,
        [req.params.id]
      ),
      pool.query(
        `SELECT r.*, u.name AS reviewer_name FROM reviews r
         JOIN users u ON r.reviewer_id = u.id
         WHERE r.target_user_id = $1 ORDER BY r.created_at DESC LIMIT 6`,
        [req.params.id]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'approved') AS milestones_completed,
           COUNT(*) AS milestones_total
         FROM milestones WHERE claimed_by = $1`,
        [req.params.id]
      ),
      pool.query(
        `SELECT m.id, m.title, m.status, m.created_at, p.title AS project_title
         FROM milestones m JOIN projects p ON m.project_id = p.id
         WHERE m.claimed_by = $1
         ORDER BY m.created_at DESC LIMIT 10`,
        [req.params.id]
      ),
      pool.query(
        `SELECT COUNT(*) FROM projects WHERE creator_id = $1 AND funded = true`,
        [req.params.id]
      ),
    ]);

    const milestones_completed = parseInt(msStatsRes.rows[0].milestones_completed || 0);
    const milestones_total = parseInt(msStatsRes.rows[0].milestones_total || 0);
    const completion_rate = milestones_total > 0
      ? Math.round((milestones_completed / milestones_total) * 100)
      : null;

    res.json({
      ...user,
      created_projects: createdRes.rows,
      contributed_projects: contributedRes.rows,
      reviews: reviewsRes.rows,
      milestones_completed,
      milestones_total,
      completion_rate,
      activity: msActivityRes.rows,
      funded_project_count: parseInt(fundedRes.rows[0].count || 0),
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
