const router = require('express').Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const pool = require('../db/pool');
const { auth, requireRole } = require('../middleware/auth');
const { createNotification } = require('./notifications');
const { logContribution } = require('./contributions');
const { sendPaymentReleased } = require('../lib/email');

// POST /milestones — add milestone to project (creator only)
router.post('/', auth, requireRole('creator', 'both'), async (req, res) => {
  const { project_id, title, description, deliverables, payment, deadline } = req.body;
  if (!project_id || !title || !description || !payment) {
    return res.status(400).json({ error: 'project_id, title, description, payment required' });
  }
  try {
    const proj = await pool.query('SELECT * FROM projects WHERE id = $1 AND creator_id = $2', [project_id, req.user.id]);
    if (!proj.rows.length) return res.status(403).json({ error: 'Forbidden or project not found' });
    const { rows } = await pool.query(
      'INSERT INTO milestones (project_id, title, description, deliverables, payment, deadline) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [project_id, title, description, deliverables || '', payment, deadline || null]
    );
    res.status(201).json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /milestones/:id/claim — builder claims a milestone
router.post('/:id/claim', auth, requireRole('builder', 'both'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ms } = await client.query('SELECT * FROM milestones WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!ms.length) return res.status(404).json({ error: 'Milestone not found' });
    const milestone = ms[0];
    if (milestone.status !== 'open') return res.status(409).json({ error: 'Milestone already claimed' });

    const { rows: proj } = await client.query('SELECT * FROM projects WHERE id = $1', [milestone.project_id]);
    const project = proj[0];
    if (project.status === 'cancelled') return res.status(400).json({ error: 'Project is cancelled' });
    if (project.creator_id === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Project owner cannot claim milestones' });
    }

    const { rows: builders } = await client.query(
      'SELECT COUNT(*) AS cnt FROM project_builders WHERE project_id = $1',
      [milestone.project_id]
    );
    const alreadyJoined = await client.query(
      'SELECT 1 FROM project_builders WHERE project_id = $1 AND builder_id = $2',
      [milestone.project_id, req.user.id]
    );

    if (!alreadyJoined.rows.length && parseInt(builders[0].cnt) >= project.max_builders) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Project builder slots are full' });
    }

    if (!alreadyJoined.rows.length) {
      await client.query(
        'INSERT INTO project_builders (project_id, builder_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [milestone.project_id, req.user.id]
      );
    }

    await client.query(
      'UPDATE milestones SET status = $1, claimed_by = $2 WHERE id = $3',
      ['claimed', req.user.id, req.params.id]
    );

    if (project.status === 'open') {
      await client.query('UPDATE projects SET status = $1 WHERE id = $2', ['in_progress', milestone.project_id]);
    }

    await client.query('COMMIT');

    await createNotification(project.creator_id, 'milestone_claimed',
      `A builder claimed milestone: "${milestone.title}"`, milestone.project_id, milestone.id);
    await logContribution(req.user.id, milestone.project_id, milestone.id,
      'milestone_claimed', `Claimed milestone: "${milestone.title}"`);

    const updated = await pool.query('SELECT * FROM milestones WHERE id = $1', [req.params.id]);
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// POST /milestones/:id/start — builder starts work (claimed → in_progress)
router.post('/:id/start', auth, requireRole('builder', 'both'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM milestones WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Milestone not found' });
    const milestone = rows[0];
    if (milestone.claimed_by !== req.user.id) return res.status(403).json({ error: 'Not your milestone' });
    if (milestone.status !== 'claimed') return res.status(409).json({ error: 'Milestone must be in claimed state to start' });

    await pool.query('UPDATE milestones SET status = $1 WHERE id = $2', ['in_progress', req.params.id]);

    const { rows: proj } = await pool.query('SELECT creator_id, title FROM projects WHERE id = $1', [milestone.project_id]);
    if (proj.length) {
      await createNotification(proj[0].creator_id, 'milestone_started',
        `A builder started work on milestone: "${milestone.title}"`, milestone.project_id, milestone.id);
    }
    await logContribution(req.user.id, milestone.project_id, milestone.id,
      'milestone_started', `Started work on milestone: "${milestone.title}"`);

    const updated = await pool.query('SELECT * FROM milestones WHERE id = $1', [req.params.id]);
    res.json(updated.rows[0]);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /milestones/builder/mine — all milestones assigned to this builder
router.get('/builder/mine', auth, requireRole('builder', 'both'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.*, p.title AS project_title, p.id AS project_id,
        (SELECT row_to_json(s) FROM submissions s
         WHERE s.milestone_id = m.id AND s.builder_id = m.claimed_by
         ORDER BY s.submitted_at DESC LIMIT 1) AS latest_submission
       FROM milestones m
       JOIN projects p ON m.project_id = p.id
       WHERE m.claimed_by = $1
         AND m.status != 'open'
       ORDER BY
         CASE m.status
           WHEN 'changes_requested' THEN 1
           WHEN 'in_progress'       THEN 2
           WHEN 'claimed'           THEN 3
           WHEN 'submitted'         THEN 4
           WHEN 'approved'          THEN 5
           ELSE 6
         END,
         m.id DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /milestones/creator/funding-stats — funding summary for creator dashboard
router.get('/creator/funding-stats', auth, requireRole('creator', 'both'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
        COALESCE(SUM(p.budget), 0) AS total_budget,
        COALESCE(SUM(m.payment) FILTER (WHERE m.funding_status IN ('funded', 'pending_release', 'released')), 0) AS allocated,
        COALESCE(SUM(m.payment) FILTER (WHERE m.funding_status = 'released'), 0) AS released,
        COUNT(m.id) FILTER (WHERE m.funding_status != 'unfunded') AS funded_count,
        COUNT(m.id) AS total_count
       FROM projects p
       LEFT JOIN milestones m ON m.project_id = p.id
       WHERE p.creator_id = $1`,
      [req.user.id]
    );
    const s = rows[0];
    const totalBudget = parseFloat(s.total_budget);
    const allocated = parseFloat(s.allocated);
    res.json({
      total_budget: totalBudget,
      allocated,
      released: parseFloat(s.released),
      remaining: totalBudget - allocated,
      funded_count: parseInt(s.funded_count) || 0,
      total_count: parseInt(s.total_count) || 0,
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /milestones/creator/pending — submitted milestones across creator's projects
router.get('/creator/pending', auth, requireRole('creator', 'both'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.*, p.title AS project_title, p.id AS project_id,
        u.name AS builder_name,
        (SELECT row_to_json(s) FROM submissions s
         WHERE s.milestone_id = m.id
         ORDER BY s.submitted_at DESC LIMIT 1) AS latest_submission
       FROM milestones m
       JOIN projects p ON m.project_id = p.id
       JOIN users u ON m.claimed_by = u.id
       WHERE p.creator_id = $1
         AND m.status = 'submitted'
       ORDER BY m.id DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /milestones/:id/fund — creator allocates funds to a milestone from project balance
router.post('/:id/fund', auth, requireRole('creator', 'both'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: ms } = await client.query(
      `SELECT m.*, p.creator_id, p.funded, p.available_balance, p.title AS project_title
       FROM milestones m JOIN projects p ON m.project_id = p.id WHERE m.id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!ms.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Milestone not found' }); }
    const milestone = ms[0];

    if (milestone.creator_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!milestone.funded) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Project must be funded before allocating milestone payments' });
    }
    if (milestone.funding_status !== 'unfunded') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Milestone is already funded' });
    }
    if (parseFloat(milestone.available_balance) < parseFloat(milestone.payment)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Insufficient project balance. Available: £${Number(milestone.available_balance).toFixed(2)}, required: £${Number(milestone.payment).toFixed(2)}`,
      });
    }

    await client.query(
      'UPDATE projects SET available_balance = available_balance - $1 WHERE id = $2',
      [milestone.payment, milestone.project_id]
    );
    const { rows } = await client.query(
      'UPDATE milestones SET funding_status = $1 WHERE id = $2 RETURNING *',
      ['funded', req.params.id]
    );
    await client.query(
      `INSERT INTO transactions (type, amount, project_id, user_id, milestone_id)
       VALUES ('milestone_allocation', $1, $2, $3, $4)`,
      [milestone.payment, milestone.project_id, req.user.id, milestone.id]
    );
    await client.query('COMMIT');

    if (milestone.claimed_by) {
      await createNotification(
        milestone.claimed_by, 'milestone_funded',
        `Milestone "${milestone.title}" has been funded — £${Number(milestone.payment).toLocaleString()} is now in escrow for you.`,
        milestone.project_id, milestone.id
      );
    }
    await logContribution(req.user.id, milestone.project_id, milestone.id,
      'milestone_funded',
      `Funded milestone: "${milestone.title}" — £${Number(milestone.payment).toLocaleString()} allocated`);

    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('milestone fund error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// POST /milestones/:id/release — creator releases payment to builder via Stripe
router.post('/:id/release', auth, requireRole('creator', 'both'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: ms } = await client.query(
      `SELECT m.*, p.creator_id, p.title AS project_title
       FROM milestones m JOIN projects p ON m.project_id = p.id WHERE m.id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!ms.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Milestone not found' }); }
    const milestone = ms[0];

    if (milestone.creator_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (milestone.funding_status !== 'pending_release') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Payment is not pending release' });
    }
    if (!milestone.claimed_by) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No builder assigned to this milestone' });
    }

    const { rows: cfg } = await client.query('SELECT platform_fee_percent FROM platform_config WHERE id = 1');
    const feePercent = parseFloat(cfg[0]?.platform_fee_percent ?? process.env.STRIPE_PLATFORM_FEE_PERCENT ?? '10') / 100;
    const builderAmount = parseFloat((milestone.payment * (1 - feePercent)).toFixed(2));
    const feeAmount     = parseFloat((milestone.payment * feePercent).toFixed(2));

    const { rows: builderRows } = await client.query(
      'SELECT stripe_account_id, stripe_onboarded FROM users WHERE id = $1',
      [milestone.claimed_by]
    );
    const builder = builderRows[0];

    if (!builder?.stripe_onboarded || !builder.stripe_account_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Builder has not completed Stripe onboarding. Payment cannot be released until they connect their bank account.',
      });
    }

    const transfer = await stripe.transfers.create({
      amount: Math.round(builderAmount * 100),
      currency: 'gbp',
      destination: builder.stripe_account_id,
      transfer_group: `project_${milestone.project_id}`,
      metadata: { milestone_id: String(milestone.id), project_id: String(milestone.project_id) },
    }, { idempotencyKey: `release_milestone_${milestone.id}` });
    await client.query(
      `INSERT INTO transactions (type, amount, project_id, user_id, milestone_id, stripe_id)
       VALUES ('payout', $1, $2, $3, $4, $5)`,
      [builderAmount, milestone.project_id, milestone.claimed_by, milestone.id, transfer.id]
    );
    await client.query(
      `INSERT INTO transactions (type, amount, project_id, milestone_id)
       VALUES ('fee', $1, $2, $3)`,
      [feeAmount, milestone.project_id, milestone.id]
    );

    const { rows } = await client.query(
      'UPDATE milestones SET funding_status = $1 WHERE id = $2 RETURNING *',
      ['released', req.params.id]
    );

    await client.query('COMMIT');

    await createNotification(
      milestone.claimed_by, 'payment_released',
      `Payment of £${Number(builderAmount).toLocaleString()} released for "${milestone.title}" on "${milestone.project_title}"`,
      milestone.project_id, milestone.id
    );
    await logContribution(req.user.id, milestone.project_id, milestone.id,
      'payment_released',
      `Released payment of £${Number(builderAmount).toLocaleString()} for milestone: "${milestone.title}"`);
    pool.query('SELECT email, name FROM users WHERE id = $1', [milestone.claimed_by]).then(({ rows: [u] }) => {
      if (u) sendPaymentReleased(u.email, u.name, builderAmount, milestone.title, milestone.project_title);
    }).catch(() => {});

    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('milestone release error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// PATCH /milestones/:id — update milestone (creator only)
router.patch('/:id', auth, requireRole('creator', 'both'), async (req, res) => {
  const { deadline } = req.body;
  try {
    const milestone = await pool.query(
      'SELECT m.*, p.creator_id FROM milestones m JOIN projects p ON m.project_id = p.id WHERE m.id = $1',
      [req.params.id]
    );
    if (!milestone.rows.length) return res.status(404).json({ error: 'Milestone not found' });
    if (milestone.rows[0].creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { rows } = await pool.query(
      'UPDATE milestones SET deadline = $1 WHERE id = $2 RETURNING *',
      [deadline || null, req.params.id]
    );
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /milestones/project/:projectId
router.get('/project/:projectId', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.*, u.name AS claimed_by_name,
        (SELECT row_to_json(s) FROM submissions s WHERE s.milestone_id = m.id AND s.builder_id = m.claimed_by ORDER BY s.submitted_at DESC LIMIT 1) AS latest_submission
       FROM milestones m LEFT JOIN users u ON m.claimed_by = u.id WHERE m.project_id = $1 ORDER BY m.id`,
      [req.params.projectId]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
