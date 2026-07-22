const router = require('express').Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const pool = require('../db/pool');
const { auth, requireRole } = require('../middleware/auth');
const { createNotification } = require('./notifications');

// POST /payments/fund-project — creator pays to fund a project via Stripe Checkout
router.post('/fund-project', auth, requireRole('creator', 'both'), async (req, res) => {
  const { project_id } = req.body;
  if (!project_id) return res.status(400).json({ error: 'project_id required' });

  try {
    const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [project_id]);
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });
    const project = rows[0];
    if (project.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (project.funded) return res.status(409).json({ error: 'Project already funded' });

    const { rows: userRows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = userRows[0];
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.name });
      customerId = customer.id;
      await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, req.user.id]);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'gbp',
          unit_amount: Math.round(parseFloat(project.budget) * 100),
          product_data: { name: `Fund project: ${project.title}` },
        },
        quantity: 1,
      }],
      metadata: { project_id: String(project_id), creator_id: String(req.user.id) },
      payment_intent_data: {
        metadata: { project_id: String(project_id), creator_id: String(req.user.id) },
      },
      success_url: `${process.env.FRONTEND_URL}/projects/${project_id}?funded=true`,
      cancel_url: `${process.env.FRONTEND_URL}/projects/${project_id}`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('fund-project error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /payments/webhook — Stripe sends events here
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature failed: ${err.message}` });
  }

  if (event.type === 'payment_intent.payment_failed') {
    const intent = event.data.object;
    const projectId = intent.metadata?.project_id;
    const creatorId = intent.metadata?.creator_id;
    if (projectId && creatorId) {
      try {
        const { rows } = await pool.query('SELECT title FROM projects WHERE id = $1', [projectId]);
        if (rows.length) {
          await createNotification(
            parseInt(creatorId), 'payment_failed',
            `Payment failed for project "${rows[0].title}". Please try funding the project again.`,
            parseInt(projectId), null
          );
        }
      } catch (err) {
        console.error('Webhook payment_failed DB error:', err);
      }
    }
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const projectId = session.metadata?.project_id;
    const creatorId = session.metadata?.creator_id;
    if (projectId) {
      try {
        const { rows } = await pool.query('SELECT budget, title FROM projects WHERE id = $1', [projectId]);
        if (rows.length) {
          const { budget, title } = rows[0];
          await pool.query(
            `UPDATE projects
             SET funded = true,
                 stripe_payment_intent_id = $1,
                 total_funded = $2,
                 available_balance = $2
             WHERE id = $3`,
            [session.payment_intent, budget, projectId]
          );
          await pool.query(
            `INSERT INTO transactions (type, amount, project_id, user_id, stripe_id)
             VALUES ('deposit', $1, $2, $3, $4)`,
            [budget, projectId, creatorId, session.payment_intent]
          );
          if (creatorId) {
            await createNotification(
              parseInt(creatorId), 'project_funded',
              `Project "${title}" funded — £${Number(budget).toLocaleString()} available to allocate to milestones.`,
              parseInt(projectId), null
            );
          }
        }
      } catch (err) {
        console.error('Webhook DB error:', err);
      }
    }
  }

  res.json({ received: true });
});

// POST /payments/builder/onboard — builder starts Stripe Connect onboarding
router.post('/builder/onboard', auth, requireRole('builder', 'both'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    let accountId = user.stripe_account_id;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: user.email,
        capabilities: { transfers: { requested: true } },
      });
      accountId = account.id;
      await pool.query('UPDATE users SET stripe_account_id = $1 WHERE id = $2', [accountId, req.user.id]);
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${process.env.FRONTEND_URL}/profile?onboard=refresh`,
      return_url: `${process.env.FRONTEND_URL}/profile?onboarded=true`,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url });
  } catch (err) {
    console.error('builder onboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /payments/builder/onboard/status — check if builder is fully onboarded
router.get('/builder/onboard/status', auth, requireRole('builder', 'both'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT stripe_account_id, stripe_onboarded FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = rows[0];
    if (!user.stripe_account_id) return res.json({ onboarded: false });

    const account = await stripe.accounts.retrieve(user.stripe_account_id);
    const onboarded = account.charges_enabled && account.payouts_enabled;

    if (onboarded && !user.stripe_onboarded) {
      await pool.query('UPDATE users SET stripe_onboarded = true WHERE id = $1', [req.user.id]);
    }

    res.json({ onboarded });
  } catch (err) {
    console.error('onboard status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /payments/builder/transactions — builder's payout history
router.get('/builder/transactions', auth, requireRole('builder', 'both'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, p.title AS project_title, m.title AS milestone_title
       FROM transactions t
       LEFT JOIN projects p ON t.project_id = p.id
       LEFT JOIN milestones m ON t.milestone_id = m.id
       WHERE t.user_id = $1
         AND t.type IN ('payout', 'pending_payout')
       ORDER BY t.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('builder transactions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /payments/project/:id/balance — project funding balance summary
router.get('/project/:id/balance', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.total_funded, p.available_balance, p.funded, p.budget,
        COALESCE(SUM(m.payment) FILTER (WHERE m.funding_status IN ('funded','pending_release','released')), 0) AS allocated,
        COALESCE(SUM(m.payment) FILTER (WHERE m.funding_status = 'released'), 0) AS released,
        COALESCE(SUM(m.payment) FILTER (WHERE m.funding_status = 'funded'), 0) AS in_escrow,
        COALESCE(SUM(m.payment) FILTER (WHERE m.funding_status = 'pending_release'), 0) AS pending_release
       FROM projects p
       LEFT JOIN milestones m ON m.project_id = p.id
       WHERE p.id = $1
       GROUP BY p.id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('project balance error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
