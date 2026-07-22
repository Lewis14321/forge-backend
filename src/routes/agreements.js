const router = require('express').Router();
const pool = require('../db/pool');
const { auth, requireRole } = require('../middleware/auth');
const { createNotification } = require('./notifications');

// GET /agreements/:projectId — agreement terms + user acceptance status
router.get('/:projectId', auth, async (req, res) => {
  try {
    const { rows: projects } = await pool.query(
      `SELECT id, title, project_type, budget, funded,
              communication_expectations, workflow_notes, review_timeline,
              collaboration_style, agreement_version, creator_id
       FROM projects WHERE id = $1`,
      [req.params.projectId]
    );
    if (!projects.length) return res.status(404).json({ error: 'Project not found' });
    const project = projects[0];

    const { rows: acceptances } = await pool.query(
      'SELECT * FROM agreement_acceptances WHERE project_id = $1 AND user_id = $2',
      [req.params.projectId, req.user.id]
    );

    res.json({
      project_id: project.id,
      project_title: project.title,
      project_type: project.project_type,
      budget: project.budget,
      funded: project.funded,
      communication_expectations: project.communication_expectations || '',
      workflow_notes: project.workflow_notes || '',
      review_timeline: project.review_timeline || '',
      collaboration_style: project.collaboration_style || '',
      agreement_version: project.agreement_version || 1,
      user_has_accepted: acceptances.length > 0,
      accepted_at: acceptances[0]?.accepted_at || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /agreements/:projectId/accept — record user acceptance
router.post('/:projectId/accept', auth, async (req, res) => {
  try {
    const { rows: projects } = await pool.query(
      'SELECT id, title, project_type, agreement_version, creator_id FROM projects WHERE id = $1',
      [req.params.projectId]
    );
    if (!projects.length) return res.status(404).json({ error: 'Project not found' });
    const project = projects[0];

    await pool.query(
      `INSERT INTO agreement_acceptances (project_id, user_id, agreement_version)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, user_id) DO UPDATE SET
         agreement_version = EXCLUDED.agreement_version,
         accepted_at = NOW()`,
      [req.params.projectId, req.user.id, project.agreement_version || 1]
    );

    // Notify creator (skip if user is creator themselves)
    if (project.creator_id !== req.user.id) {
      const label = project.project_type === 'collaboration'
        ? 'Collaboration terms accepted'
        : 'Project agreement accepted';
      await createNotification(
        project.creator_id, 'agreement_accepted',
        `${label} for "${project.title}"`,
        project.id, null
      );
    }

    res.json({ accepted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /agreements/:projectId/expectations — creator updates expectations
router.patch('/:projectId/expectations', auth, requireRole('creator', 'both'), async (req, res) => {
  const { communication_expectations, workflow_notes, review_timeline, collaboration_style } = req.body;

  try {
    const { rows } = await pool.query(
      'SELECT * FROM projects WHERE id = $1',
      [req.params.projectId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });
    if (rows[0].creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const updated = await pool.query(
      `UPDATE projects SET
         communication_expectations = $1,
         workflow_notes = $2,
         review_timeline = $3,
         collaboration_style = $4,
         agreement_version = agreement_version + 1
       WHERE id = $5 RETURNING *`,
      [
        communication_expectations ?? rows[0].communication_expectations ?? '',
        workflow_notes ?? rows[0].workflow_notes ?? '',
        review_timeline ?? rows[0].review_timeline ?? '',
        collaboration_style ?? rows[0].collaboration_style ?? '',
        req.params.projectId,
      ]
    );

    res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /agreements/:projectId/team — agreement acceptance list for creator
router.get('/:projectId/team', auth, requireRole('creator', 'both'), async (req, res) => {
  try {
    const { rows: projects } = await pool.query(
      'SELECT id, creator_id FROM projects WHERE id = $1',
      [req.params.projectId]
    );
    if (!projects.length) return res.status(404).json({ error: 'Project not found' });
    if (projects[0].creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { rows } = await pool.query(
      `SELECT aa.user_id, u.name, aa.accepted_at, aa.agreement_version
       FROM agreement_acceptances aa
       JOIN users u ON aa.user_id = u.id
       WHERE aa.project_id = $1
       ORDER BY aa.accepted_at ASC`,
      [req.params.projectId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
