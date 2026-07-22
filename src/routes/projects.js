const router = require('express').Router();
const pool = require('../db/pool');
const { auth, requireRole } = require('../middleware/auth');
const { createNotification } = require('./notifications');
const { logContribution } = require('./contributions');

// GET /projects — marketplace (open + in-progress with open slots) — public
router.get('/', async (req, res) => {
  const { budget_min, budget_max, difficulty, tech_stack, project_type, search,
          limit = '50', offset = '0' } = req.query;
  const pageLimit  = Math.min(Math.max(parseInt(limit)  || 50, 1), 100);
  const pageOffset = Math.max(parseInt(offset) || 0, 0);

  let baseWhere = `
    WHERE (
      p.status = 'open'
      OR (p.status = 'in_progress'
          AND (SELECT COUNT(*) FROM project_builders pb2 WHERE pb2.project_id = p.id) < p.max_builders)
    )
  `;
  const params = [];
  if (budget_min)   { params.push(budget_min);   baseWhere += ` AND p.budget >= $${params.length}`; }
  if (budget_max)   { params.push(budget_max);   baseWhere += ` AND p.budget <= $${params.length}`; }
  if (difficulty)   { params.push(difficulty);   baseWhere += ` AND p.difficulty = $${params.length}`; }
  if (tech_stack)   { params.push(tech_stack);   baseWhere += ` AND $${params.length} = ANY(p.tech_stack)`; }
  if (project_type) { params.push(project_type); baseWhere += ` AND p.project_type = $${params.length}`; }
  if (search?.trim()) {
    params.push(search.trim());
    baseWhere += ` AND to_tsvector('english', p.title || ' ' || p.description) @@ plainto_tsquery('english', $${params.length})`;
  }

  try {
    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT p.*, u.name AS creator_name, u.avg_rating AS creator_rating,
           (SELECT COUNT(*) FROM project_builders pb WHERE pb.project_id = p.id) AS builder_count,
           (SELECT COUNT(*) FROM milestones m WHERE m.project_id = p.id) AS milestone_count,
           (SELECT COUNT(*) FROM milestones m WHERE m.project_id = p.id AND m.status = 'approved') AS completed_milestones
         FROM projects p JOIN users u ON p.creator_id = u.id
         ${baseWhere}
         ORDER BY p.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageLimit, pageOffset]
      ),
      pool.query(`SELECT COUNT(*) FROM projects p ${baseWhere}`, params),
    ]);
    res.json({
      projects: dataRes.rows,
      total: parseInt(countRes.rows[0].count),
      limit: pageLimit,
      offset: pageOffset,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /projects/my — creator's own projects
router.get('/my', auth, requireRole('creator', 'both'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*,
        (SELECT COUNT(*) FROM project_builders pb WHERE pb.project_id = p.id) AS builder_count,
        (SELECT COUNT(*) FROM milestones m WHERE m.project_id = p.id) AS milestone_count,
        (SELECT COUNT(*) FROM join_requests jr WHERE jr.project_id = p.id AND jr.status = 'pending') AS pending_requests
       FROM projects p WHERE p.creator_id = $1 ORDER BY p.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /projects/building — builder's joined projects
router.get('/building', auth, requireRole('builder', 'both'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, u.name AS creator_name, pb.joined_at
       FROM projects p
       JOIN project_builders pb ON pb.project_id = p.id
       JOIN users u ON p.creator_id = u.id
       WHERE pb.builder_id = $1
       ORDER BY pb.joined_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /projects/my-applications — builder's collaboration join requests
router.get('/my-applications', auth, requireRole('builder', 'both'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT jr.*, p.title AS project_title, p.project_type, p.roles_needed,
              u.name AS creator_name
       FROM join_requests jr
       JOIN projects p ON jr.project_id = p.id
       JOIN users u ON p.creator_id = u.id
       WHERE jr.builder_id = $1
       ORDER BY jr.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /projects/team-requests — creator: all pending join requests across their projects
router.get('/team-requests', auth, requireRole('creator', 'both'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT jr.*, p.title AS project_title, u.name AS builder_name,
              u.avg_rating AS builder_rating, u.skills AS builder_skills
       FROM join_requests jr
       JOIN projects p ON jr.project_id = p.id
       JOIN users u ON jr.builder_id = u.id
       WHERE p.creator_id = $1 AND jr.status = 'pending'
       ORDER BY jr.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /projects/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, u.name AS creator_name, u.avg_rating AS creator_rating
       FROM projects p JOIN users u ON p.creator_id = u.id WHERE p.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });
    const project = rows[0];

    const [milestones, builders, userAgreement] = await Promise.all([
      pool.query(
        `SELECT m.*, u.name AS claimed_by_name FROM milestones m
         LEFT JOIN users u ON m.claimed_by = u.id WHERE m.project_id = $1 ORDER BY m.id`,
        [req.params.id]
      ),
      pool.query(
        `SELECT u.id, u.name, u.avg_rating, pb.joined_at,
           EXISTS(
             SELECT 1 FROM milestones
             WHERE project_id = pb.project_id AND claimed_by = u.id AND status = 'approved'
           ) AS has_approved_milestone,
           EXISTS(
             SELECT 1 FROM agreement_acceptances
             WHERE project_id = pb.project_id AND user_id = u.id
           ) AS has_accepted_agreement
         FROM project_builders pb JOIN users u ON pb.builder_id = u.id WHERE pb.project_id = $1`,
        [req.params.id]
      ),
      pool.query(
        'SELECT * FROM agreement_acceptances WHERE project_id = $1 AND user_id = $2',
        [req.params.id, req.user.id]
      ),
    ]);

    let joinRequests = [];
    let userJoinRequest = null;

    if (project.project_type === 'collaboration') {
      if (project.creator_id === req.user.id) {
        const jr = await pool.query(
          `SELECT jr.*, u.name AS builder_name, u.avg_rating AS builder_rating,
                  u.skills AS builder_skills
           FROM join_requests jr JOIN users u ON jr.builder_id = u.id
           WHERE jr.project_id = $1 AND jr.status = 'pending'
           ORDER BY jr.created_at DESC`,
          [req.params.id]
        );
        joinRequests = jr.rows;
      } else {
        const jr = await pool.query(
          'SELECT * FROM join_requests WHERE project_id = $1 AND builder_id = $2',
          [req.params.id, req.user.id]
        );
        userJoinRequest = jr.rows[0] || null;
      }
    }

    res.json({
      ...project,
      milestones: milestones.rows,
      builders: builders.rows,
      joinRequests,
      userJoinRequest,
      user_has_accepted_agreement: userAgreement.rows.length > 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /projects
router.post('/', auth, requireRole('creator', 'both'), async (req, res) => {
  const {
    title, description, project_type,
    budget, max_builders, tech_stack, difficulty, milestones,
    vision, long_term_goal, commitment_level, roles_needed,
  } = req.body;

  const type = project_type || 'funded';
  if (!title || !description) {
    return res.status(400).json({ error: 'title and description required' });
  }
  if (type === 'funded' && !budget) {
    return res.status(400).json({ error: 'budget required for funded projects' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO projects
         (title, description, budget, creator_id, max_builders, tech_stack, difficulty,
          locked_budget, project_type, vision, long_term_goal, commitment_level, roles_needed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        title,
        description,
        type === 'funded' ? Number(budget) : 0,
        req.user.id,
        max_builders || (type === 'collaboration' ? 5 : 1),
        tech_stack || [],
        difficulty || 'medium',
        type === 'funded' ? Number(budget) : 0,
        type,
        vision || '',
        long_term_goal || '',
        commitment_level || '',
        roles_needed || [],
      ]
    );
    const project = rows[0];
    if (type === 'funded' && milestones && milestones.length) {
      for (const m of milestones) {
        await client.query(
          'INSERT INTO milestones (project_id, title, description, deliverables, payment) VALUES ($1,$2,$3,$4,$5)',
          [project.id, m.title, m.description, m.deliverables || '', m.payment]
        );
      }
    }
    await client.query('COMMIT');
    await logContribution(req.user.id, project.id, null,
      'project_created', `Created project: "${project.title}"`);
    res.status(201).json(project);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// PATCH /projects/:id
router.patch('/:id', auth, requireRole('creator', 'both'), async (req, res) => {
  const {
    title, description, difficulty, tech_stack, max_builders,
    vision, long_term_goal, commitment_level, roles_needed,
    communication_expectations, workflow_notes, review_timeline, collaboration_style,
  } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    const p = rows[0];
    const updated = await pool.query(
      `UPDATE projects SET
         title=$1, description=$2, difficulty=$3, tech_stack=$4, max_builders=$5,
         vision=$6, long_term_goal=$7, commitment_level=$8, roles_needed=$9,
         communication_expectations=$10, workflow_notes=$11,
         review_timeline=$12, collaboration_style=$13
       WHERE id=$14 RETURNING *`,
      [
        title ?? p.title,
        description ?? p.description,
        difficulty ?? p.difficulty,
        tech_stack ?? p.tech_stack,
        max_builders ?? p.max_builders,
        vision ?? p.vision,
        long_term_goal ?? p.long_term_goal,
        commitment_level ?? p.commitment_level,
        roles_needed ?? p.roles_needed,
        communication_expectations ?? p.communication_expectations ?? '',
        workflow_notes ?? p.workflow_notes ?? '',
        review_timeline ?? p.review_timeline ?? '',
        collaboration_style ?? p.collaboration_style ?? '',
        req.params.id,
      ]
    );
    res.json(updated.rows[0]);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /projects/:id/join
router.post('/:id/join', auth, requireRole('builder', 'both'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });
    const project = rows[0];

    if (project.creator_id === req.user.id) {
      return res.status(400).json({ error: 'Cannot join your own project' });
    }
    if (!['open', 'in_progress'].includes(project.status)) {
      return res.status(400).json({ error: 'Project is not accepting contributors' });
    }

    const existing = await pool.query(
      'SELECT 1 FROM project_builders WHERE project_id = $1 AND builder_id = $2',
      [req.params.id, req.user.id]
    );
    if (existing.rows.length) return res.status(409).json({ error: 'Already on this project' });

    const { rows: cnt } = await pool.query(
      'SELECT COUNT(*) AS n FROM project_builders WHERE project_id = $1',
      [req.params.id]
    );
    if (parseInt(cnt[0].n) >= project.max_builders) {
      return res.status(409).json({ error: 'No open slots remaining' });
    }

    // Collaboration projects: create a join request (requires approval)
    if (project.project_type === 'collaboration') {
      const { message, skills, why_join } = req.body;
      if (!message) return res.status(400).json({ error: 'Introduction required' });

      const existingReq = await pool.query(
        'SELECT 1 FROM join_requests WHERE project_id = $1 AND builder_id = $2',
        [req.params.id, req.user.id]
      );
      if (existingReq.rows.length) return res.status(409).json({ error: 'Already applied to this project' });

      await pool.query(
        'INSERT INTO join_requests (project_id, builder_id, message, skills, why_join) VALUES ($1,$2,$3,$4,$5)',
        [req.params.id, req.user.id, message, skills || '', why_join || '']
      );

      await createNotification(
        project.creator_id, 'join_request',
        `New collaboration request for "${project.title}"`,
        project.id, null
      );

      return res.json({ message: 'Request submitted — awaiting creator approval' });
    }

    // Funded project: instant join
    await pool.query(
      'INSERT INTO project_builders (project_id, builder_id) VALUES ($1, $2)',
      [req.params.id, req.user.id]
    );

    await createNotification(
      project.creator_id, 'builder_joined',
      `A builder joined your project: "${project.title}"`,
      project.id, null
    );
    await logContribution(req.user.id, project.id, null,
      'builder_joined', `Joined project: "${project.title}"`);

    res.json({ message: 'Joined successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /projects/:id/join-requests/:reqId — creator approves or rejects
router.patch('/:id/join-requests/:reqId', auth, requireRole('creator', 'both'), async (req, res) => {
  const { status } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be approved or rejected' });
  }
  try {
    const [projectRows, reqRows] = await Promise.all([
      pool.query('SELECT * FROM projects WHERE id = $1', [req.params.id]),
      pool.query('SELECT * FROM join_requests WHERE id = $1 AND project_id = $2', [req.params.reqId, req.params.id]),
    ]);
    if (!projectRows.rows.length) return res.status(404).json({ error: 'Project not found' });
    if (!reqRows.rows.length) return res.status(404).json({ error: 'Request not found' });
    const project = projectRows.rows[0];
    if (project.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    const joinReq = reqRows.rows[0];

    await pool.query('UPDATE join_requests SET status = $1 WHERE id = $2', [status, req.params.reqId]);

    if (status === 'approved') {
      const { rows: cnt } = await pool.query(
        'SELECT COUNT(*) AS n FROM project_builders WHERE project_id = $1',
        [req.params.id]
      );
      if (parseInt(cnt[0].n) >= project.max_builders) {
        return res.status(409).json({ error: 'No open slots remaining' });
      }
      await pool.query(
        'INSERT INTO project_builders (project_id, builder_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [req.params.id, joinReq.builder_id]
      );
      if (project.status === 'open') {
        await pool.query("UPDATE projects SET status = 'in_progress' WHERE id = $1", [req.params.id]);
      }
      await createNotification(
        joinReq.builder_id, 'request_approved',
        `Your request to join "${project.title}" was approved! Welcome to the team.`,
        project.id, null
      );
      await logContribution(req.user.id, project.id, null,
        'collaborator_accepted', `Accepted collaborator for project: "${project.title}"`);
      await logContribution(joinReq.builder_id, project.id, null,
        'collaborator_joined', `Joined collaboration project: "${project.title}"`);
    } else {
      await createNotification(
        joinReq.builder_id, 'request_rejected',
        `Your request to join "${project.title}" was not accepted this time.`,
        project.id, null
      );
    }

    res.json({ message: `Request ${status}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /projects/:id
router.delete('/:id', auth, requireRole('creator', 'both'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const project = rows[0];
    if (project.creator_id !== req.user.id) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Forbidden' }); }

    // Refund creator if project has funded balance with a Stripe payment intent
    if (project.stripe_payment_intent_id && parseFloat(project.available_balance || 0) > 0) {
      try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        await stripe.refunds.create({
          payment_intent: project.stripe_payment_intent_id,
          amount: Math.round(parseFloat(project.available_balance) * 100),
          metadata: { project_id: String(project.id), reason: 'project_cancelled' },
        });
      } catch (stripeErr) {
        console.error('Stripe refund failed on cancellation:', stripeErr.message);
        // Log but don't block cancellation — admin can handle manually
      }
    }

    await client.query(
      'UPDATE projects SET status = $1, available_balance = 0 WHERE id = $2',
      ['cancelled', req.params.id]
    );
    await client.query('COMMIT');
    res.json({ message: 'Project cancelled' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('project cancel error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
