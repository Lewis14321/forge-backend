const router = require('express').Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const pool = require('../db/pool');
const { adminAuth } = require('../middleware/adminAuth');
const { createNotification } = require('./notifications');

router.use(adminAuth);

async function logAction(adminId, action, targetType, targetId, notes = '') {
  await pool.query(
    'INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, notes) VALUES ($1,$2,$3,$4,$5)',
    [adminId, action, targetType || null, targetId || null, notes]
  );
}

// ─── STATS ────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [users, active, projects, funded, collab, disputes, reports] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users WHERE is_admin = false'),
      pool.query("SELECT COUNT(*) FROM users WHERE is_admin = false AND account_status = 'active'"),
      pool.query('SELECT COUNT(*) FROM projects'),
      pool.query("SELECT COUNT(*) FROM projects WHERE funded = true"),
      pool.query("SELECT COUNT(*) FROM projects WHERE project_type = 'collaboration'"),
      pool.query("SELECT COUNT(*) FROM disputes WHERE status = 'open'"),
      pool.query("SELECT COUNT(*) FROM reports WHERE status = 'open'"),
    ]);
    res.json({
      totalUsers:     parseInt(users.rows[0].count),
      activeUsers:    parseInt(active.rows[0].count),
      totalProjects:  parseInt(projects.rows[0].count),
      fundedProjects: parseInt(funded.rows[0].count),
      collabProjects: parseInt(collab.rows[0].count),
      openDisputes:   parseInt(disputes.rows[0].count),
      pendingReports: parseInt(reports.rows[0].count),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── USER MANAGEMENT ──────────────────────────────────────────
router.get('/users', async (req, res) => {
  const { search = '', status = '', page = 1, limit = 25 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [];
  let where = 'WHERE is_admin = false';

  if (search) {
    params.push(`%${search}%`);
    where += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length})`;
  }
  if (status) {
    params.push(status);
    where += ` AND account_status = $${params.length}`;
  }

  const dataParams = [...params, parseInt(limit), offset];
  const countParams = [...params];

  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, avg_rating, rating_count, account_status, created_at,
              (SELECT COUNT(*) FROM projects WHERE creator_id = users.id) AS projects_created,
              (SELECT COUNT(*) FROM project_builders WHERE builder_id = users.id) AS projects_joined
       FROM users ${where}
       ORDER BY created_at DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM users ${where}`,
      countParams
    );
    res.json({ users: rows, total: parseInt(countRows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [userRes, projectsRes, reviewsRes, disputesRes] = await Promise.all([
      pool.query(
        `SELECT id, name, email, role, avg_rating, rating_count,
                bio, skills, tagline, account_status, created_at
         FROM users WHERE id = $1`,
        [id]
      ),
      pool.query(
        `SELECT id, title, status, project_type, funded, created_at
         FROM projects WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [id]
      ),
      pool.query(
        `SELECT r.quality, r.communication, r.reliability, r.comment, r.created_at,
                u.name AS reviewer_name
         FROM reviews r JOIN users u ON u.id = r.reviewer_id
         WHERE r.target_user_id = $1 ORDER BY r.created_at DESC LIMIT 10`,
        [id]
      ),
      pool.query(
        `SELECT d.id, d.dispute_type, d.status, d.reason, d.created_at,
                p.title AS project_title
         FROM disputes d JOIN projects p ON p.id = d.project_id
         WHERE d.initiator_id = $1 OR d.respondent_id = $1
         ORDER BY d.created_at DESC LIMIT 10`,
        [id]
      ),
    ]);
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({
      user:     userRes.rows[0],
      projects: projectsRes.rows,
      reviews:  reviewsRes.rows,
      disputes: disputesRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/users/:id/suspend', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      "UPDATE users SET account_status = 'suspended' WHERE id = $1 AND is_admin = false RETURNING id, name, account_status",
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await logAction(req.user.id, 'user_suspended', 'user', parseInt(id));
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/users/:id/reactivate', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      "UPDATE users SET account_status = 'active' WHERE id = $1 AND is_admin = false RETURNING id, name, account_status",
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await logAction(req.user.id, 'user_reactivated', 'user', parseInt(id));
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/users/:id/flag', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      "UPDATE users SET account_status = 'flagged' WHERE id = $1 AND is_admin = false RETURNING id, name, account_status",
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await logAction(req.user.id, 'user_flagged', 'user', parseInt(id));
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── PROJECT MANAGEMENT ───────────────────────────────────────
router.get('/projects', async (req, res) => {
  const { search = '', status = '', type = '', page = 1, limit = 25 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [];
  let where = 'WHERE 1=1';

  if (search) {
    params.push(`%${search}%`);
    where += ` AND (p.title ILIKE $${params.length} OR u.name ILIKE $${params.length})`;
  }
  if (status) {
    params.push(status);
    where += ` AND p.status = $${params.length}`;
  }
  if (type) {
    params.push(type);
    where += ` AND p.project_type = $${params.length}`;
  }

  const dataParams = [...params, parseInt(limit), offset];
  const countParams = [...params];

  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.title, p.status, p.project_type, p.budget, p.funded, p.created_at,
              u.name AS creator_name, u.id AS creator_id,
              (SELECT COUNT(*) FROM project_builders WHERE project_id = p.id) AS contributor_count,
              (SELECT COUNT(*) FROM milestones WHERE project_id = p.id) AS milestone_count,
              (SELECT COUNT(*) FROM disputes WHERE project_id = p.id AND status = 'open') AS open_disputes
       FROM projects p JOIN users u ON u.id = p.creator_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM projects p JOIN users u ON u.id = p.creator_id ${where}`,
      countParams
    );
    res.json({ projects: rows, total: parseInt(countRows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/projects/:id/flag', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      'UPDATE projects SET is_flagged = true WHERE id = $1 RETURNING id, title, is_flagged',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });
    await logAction(req.user.id, 'project_flagged', 'project', parseInt(id), rows[0].title);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/projects/:id/archive', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      "UPDATE projects SET status = 'cancelled' WHERE id = $1 RETURNING id, title, status",
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });
    await logAction(req.user.id, 'project_archived', 'project', parseInt(id), rows[0].title);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── DISPUTE MANAGEMENT ───────────────────────────────────────
router.get('/disputes', async (req, res) => {
  const { status = '', page = 1, limit = 25 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [];
  let where = 'WHERE 1=1';

  if (status) {
    params.push(status);
    where += ` AND d.status = $${params.length}`;
  }

  const dataParams = [...params, parseInt(limit), offset];
  const countParams = [...params];

  try {
    const { rows } = await pool.query(
      `SELECT d.id, d.dispute_type, d.reason, d.status, d.created_at, d.resolved_at,
              p.title AS project_title, p.id AS project_id,
              i.name AS initiator_name, i.id AS initiator_id,
              r.name AS respondent_name
       FROM disputes d
       JOIN projects p ON p.id = d.project_id
       JOIN users i ON i.id = d.initiator_id
       LEFT JOIN users r ON r.id = d.respondent_id
       ${where}
       ORDER BY d.created_at DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM disputes d ${where}`,
      countParams
    );
    res.json({ disputes: rows, total: parseInt(countRows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/disputes/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['open', 'under_review', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE disputes
       SET status = $1,
           resolved_at = CASE WHEN $1 = 'resolved' THEN NOW() ELSE NULL END
       WHERE id = $2 RETURNING id, status, resolved_at`,
      [status, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Dispute not found' });
    await logAction(req.user.id, `dispute_${status}`, 'dispute', parseInt(id));
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /admin/disputes/:id/resolve — resolve with Stripe enforcement
router.post('/disputes/:id/resolve', async (req, res) => {
  const { ruling, milestone_id, notes = '' } = req.body;
  if (!['refund_creator', 'pay_builder', 'no_action'].includes(ruling)) {
    return res.status(400).json({ error: 'ruling must be refund_creator, pay_builder, or no_action' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [dispute] } = await client.query(
      'SELECT * FROM disputes WHERE id = $1 FOR UPDATE', [req.params.id]
    );
    if (!dispute) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Dispute not found' }); }
    if (dispute.status === 'resolved') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Dispute already resolved' }); }

    let stripeAction = null;

    if (milestone_id && ruling !== 'no_action') {
      const { rows: [milestone] } = await client.query(
        `SELECT m.*, u.stripe_account_id, u.stripe_onboarded
         FROM milestones m
         JOIN users u ON u.id = m.claimed_by
         WHERE m.id = $1 AND m.project_id = $2`,
        [milestone_id, dispute.project_id]
      );
      if (!milestone) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Milestone not found on this project' }); }

      const { rows: cfg } = await client.query('SELECT platform_fee_percent FROM platform_config WHERE id = 1');
      const feePercent = parseFloat(cfg[0]?.platform_fee_percent ?? process.env.STRIPE_PLATFORM_FEE_PERCENT ?? '10') / 100;
      const builderAmount = parseFloat((milestone.payment * (1 - feePercent)).toFixed(2));
      const feeAmount     = parseFloat((milestone.payment * feePercent).toFixed(2));

      if (ruling === 'refund_creator') {
        if (!['funded', 'pending_release'].includes(milestone.funding_status)) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Milestone must be funded or pending_release to refund' });
        }
        // Return milestone amount to project available_balance
        await client.query(
          'UPDATE projects SET available_balance = available_balance + $1 WHERE id = $2',
          [milestone.payment, dispute.project_id]
        );
        await client.query(
          "UPDATE milestones SET funding_status = 'unfunded' WHERE id = $1", [milestone_id]
        );
        // Attempt a Stripe partial refund to the creator's original payment intent
        const { rows: [proj] } = await client.query(
          'SELECT stripe_payment_intent_id FROM projects WHERE id = $1',
          [dispute.project_id]
        );
        if (proj?.stripe_payment_intent_id) {
          try {
            await stripe.refunds.create({
              payment_intent: proj.stripe_payment_intent_id,
              amount: Math.round(milestone.payment * 100),
              metadata: { milestone_id: String(milestone_id), dispute_id: String(req.params.id), reason: 'dispute_refund_creator' },
            });
            stripeAction = 'stripe_refund_issued';
          } catch (stripeErr) {
            console.error('Stripe refund error in dispute resolution:', stripeErr.message);
            stripeAction = 'stripe_refund_failed_manual_required';
          }
        } else {
          stripeAction = 'funds_returned_to_project_balance_no_stripe_pi';
        }

      } else if (ruling === 'pay_builder') {
        if (milestone.funding_status !== 'pending_release') {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Milestone must be pending_release to force-pay builder' });
        }
        if (!milestone.stripe_onboarded || !milestone.stripe_account_id) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Builder has not completed Stripe onboarding' });
        }
        const transfer = await stripe.transfers.create({
          amount: Math.round(builderAmount * 100),
          currency: 'gbp',
          destination: milestone.stripe_account_id,
          transfer_group: `project_${dispute.project_id}`,
          metadata: { milestone_id: String(milestone_id), dispute_id: String(req.params.id), forced: 'true' },
        }, { idempotencyKey: `dispute_pay_${req.params.id}_ms_${milestone_id}` });
        await client.query(
          `INSERT INTO transactions (type, amount, project_id, user_id, milestone_id, stripe_id)
           VALUES ('payout', $1, $2, $3, $4, $5)`,
          [builderAmount, dispute.project_id, milestone.claimed_by, milestone_id, transfer.id]
        );
        await client.query(
          `INSERT INTO transactions (type, amount, project_id, milestone_id)
           VALUES ('fee', $1, $2, $3)`,
          [feeAmount, dispute.project_id, milestone_id]
        );
        await client.query(
          "UPDATE milestones SET funding_status = 'released' WHERE id = $1", [milestone_id]
        );
        stripeAction = `stripe_transfer_${transfer.id}`;
      }
    }

    const { rows: [resolved] } = await client.query(
      `UPDATE disputes SET status = 'resolved', resolved_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    await client.query('COMMIT');

    await logAction(req.user.id, `dispute_resolved_${ruling}`, 'dispute', parseInt(req.params.id), notes || stripeAction || '');

    for (const userId of [dispute.initiator_id, dispute.respondent_id].filter(Boolean)) {
      await createNotification(userId, 'dispute_resolved',
        `Your dispute has been resolved. Ruling: ${ruling.replace(/_/g, ' ')}.`,
        dispute.project_id
      );
    }

    res.json({ ...resolved, ruling, stripe_action: stripeAction });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('dispute resolve error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ─── REPORT MANAGEMENT ────────────────────────────────────────
router.get('/reports', async (req, res) => {
  const { status = '', target_type = '', page = 1, limit = 25 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [];
  let where = 'WHERE 1=1';

  if (status) {
    params.push(status);
    where += ` AND r.status = $${params.length}`;
  }
  if (target_type) {
    params.push(target_type);
    where += ` AND r.target_type = $${params.length}`;
  }

  const dataParams = [...params, parseInt(limit), offset];
  const countParams = [...params];

  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.admin_notes, r.created_at,
              u.name AS reporter_name, u.id AS reporter_id
       FROM reports r
       JOIN users u ON u.id = r.reporter_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    // Enrich with target names
    const enriched = await Promise.all(rows.map(async (report) => {
      if (report.target_type === 'user') {
        const { rows: t } = await pool.query('SELECT name FROM users WHERE id = $1', [report.target_id]);
        return { ...report, target_name: t[0]?.name || 'Unknown' };
      }
      const { rows: t } = await pool.query('SELECT title AS name FROM projects WHERE id = $1', [report.target_id]);
      return { ...report, target_name: t[0]?.name || 'Unknown' };
    }));

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM reports r ${where}`,
      countParams
    );
    res.json({ reports: enriched, total: parseInt(countRows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/reports/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, admin_notes } = req.body;
  if (!['open', 'reviewing', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE reports
       SET status = $1, admin_notes = COALESCE($2, admin_notes)
       WHERE id = $3 RETURNING id, status, admin_notes`,
      [status, admin_notes || null, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Report not found' });
    await logAction(req.user.id, `report_${status}`, 'report', parseInt(id));
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ANALYTICS ────────────────────────────────────────────────
router.get('/analytics', async (req, res) => {
  try {
    const [newUsers, activeProjects, funded, collab, milestones, disputes, growth] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '7 days' AND is_admin = false"),
      pool.query("SELECT COUNT(*) FROM projects WHERE status IN ('open', 'in_progress')"),
      pool.query("SELECT COUNT(*) FROM projects WHERE funded = true"),
      pool.query("SELECT COUNT(*) FROM projects WHERE project_type = 'collaboration'"),
      pool.query("SELECT COUNT(*) FROM milestones WHERE status = 'approved'"),
      pool.query('SELECT COUNT(*) FROM disputes'),
      pool.query(`
        SELECT DATE_TRUNC('day', created_at)::date AS day, COUNT(*)::int AS count
        FROM users
        WHERE created_at >= NOW() - INTERVAL '30 days' AND is_admin = false
        GROUP BY day ORDER BY day ASC
      `),
    ]);
    res.json({
      newUsersThisWeek:    parseInt(newUsers.rows[0].count),
      activeProjects:      parseInt(activeProjects.rows[0].count),
      fundedProjects:      parseInt(funded.rows[0].count),
      collabProjects:      parseInt(collab.rows[0].count),
      completedMilestones: parseInt(milestones.rows[0].count),
      totalDisputes:       parseInt(disputes.rows[0].count),
      userGrowth:          growth.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── PLATFORM HEALTH ──────────────────────────────────────────
router.get('/health', async (req, res) => {
  try {
    const [inactive, abandoned, highDispute, flagged] = await Promise.all([
      pool.query(`
        SELECT p.id, p.title, p.status, p.created_at, u.name AS creator_name
        FROM projects p JOIN users u ON u.id = p.creator_id
        WHERE p.status = 'in_progress'
          AND NOT EXISTS (
            SELECT 1 FROM contribution_logs cl
            WHERE cl.project_id = p.id AND cl.created_at >= NOW() - INTERVAL '30 days'
          )
        ORDER BY p.created_at ASC LIMIT 20
      `),
      pool.query(`
        SELECT m.id, m.title, m.status, m.deadline, p.title AS project_title,
               u.name AS claimed_by_name
        FROM milestones m
        JOIN projects p ON p.id = m.project_id
        LEFT JOIN users u ON u.id = m.claimed_by
        WHERE m.status IN ('claimed', 'in_progress') AND m.claimed_by IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM contribution_logs cl
            WHERE cl.milestone_id = m.id AND cl.created_at >= NOW() - INTERVAL '14 days'
          )
        ORDER BY m.created_at ASC LIMIT 20
      `),
      pool.query(`
        SELECT p.id, p.title, p.status, u.name AS creator_name,
               COUNT(d.id)::int AS dispute_count
        FROM projects p
        JOIN users u ON u.id = p.creator_id
        JOIN disputes d ON d.project_id = p.id AND d.status = 'open'
        GROUP BY p.id, p.title, p.status, u.name
        HAVING COUNT(d.id) >= 2
        ORDER BY dispute_count DESC LIMIT 20
      `),
      pool.query(`
        SELECT id, name, email, role, account_status, created_at
        FROM users WHERE account_status IN ('flagged', 'suspended')
        ORDER BY created_at DESC LIMIT 20
      `),
    ]);
    res.json({
      inactiveProjects:    inactive.rows,
      abandonedMilestones: abandoned.rows,
      highDisputeProjects: highDispute.rows,
      flaggedAccounts:     flagged.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── AUDIT LOG ────────────────────────────────────────────────
router.get('/audit', async (req, res) => {
  const { page = 1, limit = 30 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    const { rows } = await pool.query(
      `SELECT al.id, al.action, al.target_type, al.target_id, al.notes, al.created_at,
              u.name AS admin_name
       FROM admin_audit_logs al JOIN users u ON u.id = al.admin_id
       ORDER BY al.created_at DESC
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), offset]
    );
    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM admin_audit_logs');
    res.json({ logs: rows, total: parseInt(countRows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GLOBAL SEARCH ────────────────────────────────────────────
router.get('/search', async (req, res) => {
  const { q = '' } = req.query;
  if (!q.trim()) return res.json({ users: [], projects: [], disputes: [] });
  const term = `%${q}%`;
  try {
    const [users, projects, disputes] = await Promise.all([
      pool.query(
        `SELECT id, name, email, role, account_status FROM users
         WHERE (name ILIKE $1 OR email ILIKE $1) AND is_admin = false LIMIT 6`,
        [term]
      ),
      pool.query(
        `SELECT id, title, status, project_type FROM projects WHERE title ILIKE $1 LIMIT 6`,
        [term]
      ),
      pool.query(
        `SELECT d.id, d.dispute_type, d.status, d.reason, p.title AS project_title
         FROM disputes d JOIN projects p ON p.id = d.project_id
         WHERE d.reason ILIKE $1 OR d.description ILIKE $1 LIMIT 6`,
        [term]
      ),
    ]);
    res.json({ users: users.rows, projects: projects.rows, disputes: disputes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── PLATFORM CONFIG ──────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM platform_config WHERE id = 1');
    res.json(rows[0] || { platform_fee_percent: 10 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/config', async (req, res) => {
  const { platform_fee_percent } = req.body;
  const fee = parseFloat(platform_fee_percent);
  if (isNaN(fee) || fee < 0 || fee > 50) {
    return res.status(400).json({ error: 'Fee must be a number between 0 and 50' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE platform_config SET platform_fee_percent = $1, updated_at = NOW()
       WHERE id = 1 RETURNING *`,
      [fee]
    );
    await logAction(req.user.id, 'config_updated', 'platform_config', 1,
      `platform_fee_percent set to ${fee}%`);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
