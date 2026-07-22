const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { createNotification } = require('./notifications');

// POST /reviews
router.post('/', auth, async (req, res) => {
  const { target_user_id, project_id, quality, communication, reliability, clarity, fairness, comment } = req.body;
  if (!target_user_id || !project_id) {
    return res.status(400).json({ error: 'target_user_id and project_id required' });
  }
  const ratingFields = { quality, communication, reliability, clarity, fairness };
  for (const [field, val] of Object.entries(ratingFields)) {
    if (val != null && (typeof val !== 'number' || !Number.isInteger(val) || val < 1 || val > 5)) {
      return res.status(400).json({ error: `${field} must be an integer between 1 and 5` });
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: proj } = await client.query('SELECT * FROM projects WHERE id = $1', [project_id]);
    if (!proj.length) return res.status(404).json({ error: 'Project not found' });
    const project = proj[0];

    const isCreator = project.creator_id === req.user.id;
    const builderCheck = await client.query(
      'SELECT 1 FROM project_builders WHERE project_id = $1 AND builder_id = $2',
      [project_id, req.user.id]
    );
    const isBuilderOnProject = builderCheck.rows.length > 0;

    if (!isCreator && !isBuilderOnProject) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You are not part of this project' });
    }

    if (isCreator) {
      // Creator can review a builder after approving at least one of their milestones, or after project completion
      const { rows: approved } = await client.query(
        `SELECT 1 FROM milestones
         WHERE project_id = $1 AND claimed_by = $2 AND status = 'approved' LIMIT 1`,
        [project_id, target_user_id]
      );
      if (!approved.length && project.status !== 'completed') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'You can only review a builder after approving their work' });
      }
    } else {
      // Builder reviewing creator: require project completion
      if (project.status !== 'completed') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Reviews only allowed after project completion' });
      }
    }

    const { rows } = await client.query(
      `INSERT INTO reviews (reviewer_id, target_user_id, project_id, quality, communication, reliability, clarity, fairness, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.id, target_user_id, project_id, quality || null, communication || null,
       reliability || null, clarity || null, fairness || null, comment || null]
    );

    await client.query(`
      UPDATE users SET
        avg_rating = (
          SELECT ROUND(AVG(
            (COALESCE(quality,0) + COALESCE(communication,0) + COALESCE(reliability,0) + COALESCE(clarity,0) + COALESCE(fairness,0))::numeric /
            NULLIF(
              (CASE WHEN quality IS NOT NULL THEN 1 ELSE 0 END +
               CASE WHEN communication IS NOT NULL THEN 1 ELSE 0 END +
               CASE WHEN reliability IS NOT NULL THEN 1 ELSE 0 END +
               CASE WHEN clarity IS NOT NULL THEN 1 ELSE 0 END +
               CASE WHEN fairness IS NOT NULL THEN 1 ELSE 0 END), 0)
          )::numeric, 2)
          FROM reviews WHERE target_user_id = $1
        ),
        rating_count = (SELECT COUNT(*) FROM reviews WHERE target_user_id = $1)
      WHERE id = $1`,
      [target_user_id]
    );

    await client.query('COMMIT');

    const { rows: reviewer } = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
    const reviewerName = reviewer[0]?.name || 'Someone';
    await createNotification(
      target_user_id, 'review_received',
      `${reviewerName} left you a review for "${project.title}"`,
      project_id, null
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'You already reviewed this user for this project' });
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// GET /reviews/user/:userId
router.get('/user/:userId', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, u.name AS reviewer_name, p.title AS project_title
       FROM reviews r JOIN users u ON r.reviewer_id = u.id JOIN projects p ON r.project_id = p.id
       WHERE r.target_user_id = $1 ORDER BY r.created_at DESC`,
      [req.params.userId]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
