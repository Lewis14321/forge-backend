const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { createNotification } = require('./notifications');
const { sendDisputeOpened } = require('../lib/email');

// POST /disputes — open a new dispute
router.post('/', auth, async (req, res) => {
  const { project_id, respondent_id, dispute_type, reason, description } = req.body;

  if (!project_id || !dispute_type || !reason?.trim() || !description?.trim()) {
    return res.status(400).json({ error: 'project_id, dispute_type, reason, and description are required' });
  }
  if (description.trim().length < 20) {
    return res.status(400).json({ error: 'Description must be at least 20 characters' });
  }

  try {
    // Verify user is a participant in this project
    const { rows: [project] } = await pool.query(
      `SELECT p.id, p.creator_id, p.title,
              EXISTS(SELECT 1 FROM project_builders pb WHERE pb.project_id = p.id AND pb.builder_id = $2) AS is_builder
       FROM projects p WHERE p.id = $1`,
      [project_id, req.user.id]
    );
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const isCreator = project.creator_id === req.user.id;
    if (!isCreator && !project.is_builder) {
      return res.status(403).json({ error: 'You must be a participant in this project to open a dispute' });
    }

    // Builder-only dispute types
    const builderTypes = ['unfair_rejection', 'milestone_abuse', 'payment_issue'];
    // Creator-only dispute types
    const creatorTypes = ['poor_quality', 'abandonment'];

    if (isCreator && builderTypes.includes(dispute_type)) {
      return res.status(400).json({ error: 'This dispute type is only available to builders' });
    }
    if (!isCreator && creatorTypes.includes(dispute_type)) {
      return res.status(400).json({ error: 'This dispute type is only available to creators' });
    }

    const { rows: [dispute] } = await pool.query(
      `INSERT INTO disputes (project_id, initiator_id, respondent_id, dispute_type, reason, description)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [project_id, req.user.id, respondent_id || null, dispute_type, reason.trim(), description.trim()]
    );

    // Notify respondent if specified, otherwise notify creator
    const notifyTarget = respondent_id || (isCreator ? null : project.creator_id);
    if (notifyTarget && notifyTarget !== req.user.id) {
      await createNotification(
        notifyTarget,
        'dispute_opened',
        `A dispute has been opened on "${project.title}": ${reason}`,
        project_id
      );
      pool.query('SELECT email, name FROM users WHERE id = $1', [notifyTarget]).then(({ rows: [u] }) => {
        if (u) sendDisputeOpened(u.email, u.name, dispute_type, project.title,
          `${process.env.FRONTEND_URL}/projects/${project_id}`);
      }).catch(() => {});
    }

    res.status(201).json(dispute);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You already have an open dispute of this type for this project' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /disputes/project/:projectId — list all disputes for a project (participants only)
router.get('/project/:projectId', auth, async (req, res) => {
  try {
    const { rows: [project] } = await pool.query(
      `SELECT p.id, p.creator_id,
              EXISTS(SELECT 1 FROM project_builders pb WHERE pb.project_id = p.id AND pb.builder_id = $2) AS is_builder
       FROM projects p WHERE p.id = $1`,
      [req.params.projectId, req.user.id]
    );
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const isParticipant = project.creator_id === req.user.id || project.is_builder;
    if (!isParticipant) return res.status(403).json({ error: 'Access denied' });

    const { rows } = await pool.query(
      `SELECT d.*,
              u_init.name AS initiator_name,
              u_resp.name AS respondent_name
       FROM disputes d
       JOIN users u_init ON d.initiator_id = u_init.id
       LEFT JOIN users u_resp ON d.respondent_id = u_resp.id
       WHERE d.project_id = $1
       ORDER BY d.created_at DESC`,
      [req.params.projectId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /disputes/mine — all disputes the current user initiated
router.get('/mine', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, p.title AS project_title,
              u_resp.name AS respondent_name
       FROM disputes d
       JOIN projects p ON d.project_id = p.id
       LEFT JOIN users u_resp ON d.respondent_id = u_resp.id
       WHERE d.initiator_id = $1
       ORDER BY d.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /disputes/:id/withdraw — initiator withdraws their dispute
router.patch('/:id/withdraw', auth, async (req, res) => {
  try {
    const { rows: [dispute] } = await pool.query(
      'SELECT * FROM disputes WHERE id = $1', [req.params.id]
    );
    if (!dispute) return res.status(404).json({ error: 'Dispute not found' });
    if (dispute.initiator_id !== req.user.id) return res.status(403).json({ error: 'Only the initiator can withdraw a dispute' });
    if (dispute.status !== 'open') return res.status(400).json({ error: 'Only open disputes can be withdrawn' });

    const { rows: [updated] } = await pool.query(
      `UPDATE disputes SET status = 'withdrawn', resolved_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
