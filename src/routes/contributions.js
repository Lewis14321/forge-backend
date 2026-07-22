const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');

const FILTER_TYPES = {
  milestones: [
    'milestone_claimed', 'milestone_started', 'milestone_submitted',
    'milestone_approved', 'milestone_changes_requested', 'milestone_rejected',
  ],
  funding: ['milestone_funded', 'payment_released', 'project_funded'],
  collaboration: ['project_created', 'builder_joined', 'collaborator_joined', 'collaborator_accepted'],
  reviews: ['review_submitted'],
};

// Exported helper — non-fatal, call fire-and-forget after main DB commit
async function logContribution(userId, projectId, milestoneId, actionType, actionDetail, metadata = {}) {
  try {
    await pool.query(
      `INSERT INTO contribution_logs
         (user_id, project_id, milestone_id, action_type, action_detail, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, projectId, milestoneId || null, actionType, actionDetail, JSON.stringify(metadata)]
    );
  } catch (err) {
    console.error('logContribution error:', err.message);
  }
}

// GET /contributions/project/:projectId — project history with optional filter
router.get('/project/:projectId', auth, async (req, res) => {
  const { filter } = req.query;
  try {
    // Verify user is a participant (creator or builder)
    const { rows: access } = await pool.query(
      `SELECT 1 FROM projects WHERE id = $1 AND creator_id = $2
       UNION
       SELECT 1 FROM project_builders WHERE project_id = $1 AND builder_id = $2`,
      [req.params.projectId, req.user.id]
    );
    if (!access.length) return res.status(403).json({ error: 'Forbidden' });

    let whereClause = 'cl.project_id = $1';
    const params = [req.params.projectId];

    if (filter && FILTER_TYPES[filter]) {
      params.push(FILTER_TYPES[filter]);
      whereClause += ` AND cl.action_type = ANY($${params.length})`;
    }

    const { rows } = await pool.query(
      `SELECT cl.id, cl.action_type, cl.action_detail, cl.metadata, cl.created_at,
              cl.milestone_id,
              u.id AS actor_id, u.name AS actor_name,
              m.title AS milestone_title
       FROM contribution_logs cl
       JOIN users u ON cl.user_id = u.id
       LEFT JOIN milestones m ON cl.milestone_id = m.id
       WHERE ${whereClause}
       ORDER BY cl.created_at DESC
       LIMIT 150`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /contributions/project/:projectId/contributors — full contributor roster with stats
router.get('/project/:projectId/contributors', auth, async (req, res) => {
  try {
    const { rows: proj } = await pool.query(
      'SELECT id, creator_id, title FROM projects WHERE id = $1',
      [req.params.projectId]
    );
    if (!proj.length) return res.status(404).json({ error: 'Project not found' });
    const project = proj[0];

    // Creator
    const { rows: creatorRows } = await pool.query(
      `SELECT u.id, u.name, u.avg_rating, u.role, u.skills, u.tagline,
              p.created_at AS joined_at,
              COUNT(cl.id) AS contribution_count
       FROM projects p
       JOIN users u ON p.creator_id = u.id
       LEFT JOIN contribution_logs cl ON cl.user_id = u.id AND cl.project_id = p.id
       WHERE p.id = $1
       GROUP BY u.id, u.name, u.avg_rating, u.role, u.skills, u.tagline, p.created_at`,
      [req.params.projectId]
    );

    // Builders with milestone stats
    const { rows: builderRows } = await pool.query(
      `SELECT u.id, u.name, u.avg_rating, u.role, u.skills, u.tagline,
              pb.joined_at,
              COUNT(DISTINCT cl.id) AS contribution_count,
              COUNT(DISTINCT m.id) FILTER (WHERE m.status = 'approved') AS milestones_completed,
              COUNT(DISTINCT m.id) AS milestones_total
       FROM project_builders pb
       JOIN users u ON pb.builder_id = u.id
       LEFT JOIN contribution_logs cl ON cl.user_id = u.id AND cl.project_id = pb.project_id
       LEFT JOIN milestones m ON m.project_id = pb.project_id AND m.claimed_by = u.id
       WHERE pb.project_id = $1
       GROUP BY u.id, u.name, u.avg_rating, u.role, u.skills, u.tagline, pb.joined_at
       ORDER BY milestones_completed DESC, pb.joined_at ASC`,
      [req.params.projectId]
    );

    res.json({
      project_id: project.id,
      creator: creatorRows[0]
        ? { ...creatorRows[0], member_role: 'creator', contribution_count: parseInt(creatorRows[0].contribution_count) }
        : null,
      builders: builderRows.map(b => ({
        ...b,
        member_role: 'builder',
        contribution_count: parseInt(b.contribution_count),
        milestones_completed: parseInt(b.milestones_completed),
        milestones_total: parseInt(b.milestones_total),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /contributions/user/:userId — public contribution history for a user
router.get('/user/:userId', auth, async (req, res) => {
  try {
    const { rows: logs } = await pool.query(
      `SELECT cl.id, cl.action_type, cl.action_detail, cl.metadata, cl.created_at,
              cl.project_id, cl.milestone_id,
              p.title AS project_title,
              m.title AS milestone_title
       FROM contribution_logs cl
       JOIN projects p ON cl.project_id = p.id
       LEFT JOIN milestones m ON cl.milestone_id = m.id
       WHERE cl.user_id = $1
       ORDER BY cl.created_at DESC
       LIMIT 60`,
      [req.params.userId]
    );

    const { rows: stats } = await pool.query(
      `SELECT
         COUNT(DISTINCT cl.project_id) AS projects_contributed,
         COUNT(*) AS total_contributions,
         COUNT(*) FILTER (WHERE cl.action_type = 'milestone_approved') AS milestones_approved,
         COUNT(*) FILTER (WHERE cl.action_type = 'milestone_submitted') AS milestones_submitted
       FROM contribution_logs cl
       WHERE cl.user_id = $1`,
      [req.params.userId]
    );

    res.json({
      logs,
      stats: {
        projects_contributed: parseInt(stats[0].projects_contributed),
        total_contributions: parseInt(stats[0].total_contributions),
        milestones_approved: parseInt(stats[0].milestones_approved),
        milestones_submitted: parseInt(stats[0].milestones_submitted),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.logContribution = logContribution;
