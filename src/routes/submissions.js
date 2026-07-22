const router = require('express').Router();
const pool = require('../db/pool');
const { auth, requireRole } = require('../middleware/auth');
const { createNotification } = require('./notifications');
const { logContribution } = require('./contributions');
const { sendMilestoneSubmitted, sendMilestoneApproved } = require('../lib/email');

// POST /submissions — builder submits work for a milestone
router.post('/', auth, requireRole('builder', 'both'), async (req, res) => {
  const { milestone_id, github_link, description, live_demo_link } = req.body;
  if (!milestone_id || !github_link || !description) {
    return res.status(400).json({ error: 'milestone_id, github_link, description required' });
  }
  try {
    const { rows: ms } = await pool.query('SELECT * FROM milestones WHERE id = $1', [milestone_id]);
    if (!ms.length) return res.status(404).json({ error: 'Milestone not found' });
    const milestone = ms[0];
    if (milestone.claimed_by !== req.user.id) {
      return res.status(403).json({ error: 'Only the assigned builder can submit' });
    }
    if (!['claimed', 'in_progress', 'changes_requested'].includes(milestone.status)) {
      return res.status(409).json({ error: 'Milestone is not in a submittable state' });
    }

    const { rows } = await pool.query(
      `INSERT INTO submissions (milestone_id, builder_id, github_link, description, live_demo_link)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [milestone_id, req.user.id, github_link, description, live_demo_link || null]
    );

    await pool.query('UPDATE milestones SET status = $1 WHERE id = $2', ['submitted', milestone_id]);

    const { rows: proj } = await pool.query(
      `SELECT p.id AS project_id, p.creator_id, p.title AS project_title,
              u.email AS creator_email, u.name AS creator_name
       FROM projects p
       JOIN milestones m ON m.project_id = p.id
       JOIN users u ON u.id = p.creator_id
       WHERE m.id = $1`,
      [milestone_id]
    );
    if (proj.length) {
      const { rows: [builderUser] } = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
      await createNotification(proj[0].creator_id, 'submission_received',
        `New submission for milestone: "${milestone.title}"`, null, milestone_id);
      await logContribution(req.user.id, proj[0].project_id, milestone_id,
        'milestone_submitted', `Submitted work for milestone: "${milestone.title}"`);
      const projectUrl = `${process.env.FRONTEND_URL}/projects/${proj[0].project_id}`;
      sendMilestoneSubmitted(
        proj[0].creator_email, proj[0].creator_name,
        builderUser?.name || 'A builder',
        milestone.title, proj[0].project_title, projectUrl
      );
    }

    res.status(201).json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /submissions/milestone/:milestoneId — creator sees all submissions for a milestone
router.get('/milestone/:milestoneId', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, u.name AS builder_name, u.avg_rating AS builder_rating
       FROM submissions s JOIN users u ON s.builder_id = u.id WHERE s.milestone_id = $1 ORDER BY s.submitted_at DESC`,
      [req.params.milestoneId]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /submissions/:id/review — creator approves/rejects/requests changes
router.patch('/:id/review', auth, requireRole('creator', 'both'), async (req, res) => {
  const { status, feedback } = req.body;
  if (!['approved', 'rejected', 'changes_requested'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (['rejected', 'changes_requested'].includes(status) && !feedback?.trim()) {
    return res.status(400).json({ error: 'Feedback is required when requesting changes or rejecting' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: sub } = await client.query('SELECT * FROM submissions WHERE id = $1', [req.params.id]);
    if (!sub.length) return res.status(404).json({ error: 'Submission not found' });
    const submission = sub[0];

    const { rows: ms } = await client.query(
      `SELECT m.*, p.creator_id, p.title AS project_title FROM milestones m JOIN projects p ON m.project_id = p.id WHERE m.id = $1`,
      [submission.milestone_id]
    );
    if (!ms.length || ms[0].creator_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Forbidden' });
    }
    const milestone = ms[0];

    await client.query(
      'UPDATE submissions SET status = $1, feedback = $2, updated_at = NOW() WHERE id = $3',
      [status, feedback || null, req.params.id]
    );

    if (status === 'approved') {
      await client.query('UPDATE milestones SET status = $1 WHERE id = $2', ['approved', submission.milestone_id]);
      // Move funded milestone to pending_release so creator can release payment
      await client.query(
        `UPDATE milestones SET funding_status = 'pending_release' WHERE id = $1 AND funding_status = 'funded'`,
        [submission.milestone_id]
      );
      await client.query(
        'UPDATE projects SET locked_budget = locked_budget - $1 WHERE id = $2',
        [milestone.payment, milestone.project_id]
      );

      const { rows: remaining } = await client.query(
        `SELECT COUNT(*) AS cnt FROM milestones WHERE project_id = $1 AND status != 'approved'`,
        [milestone.project_id]
      );
      if (parseInt(remaining[0].cnt) === 0) {
        await client.query('UPDATE projects SET status = $1 WHERE id = $2', ['completed', milestone.project_id]);
      }

      await createNotification(submission.builder_id, 'milestone_approved',
        `Your submission for "${milestone.title}" was approved! The creator will release your payment shortly.`,
        milestone.project_id, milestone.id);
      await logContribution(req.user.id, milestone.project_id, milestone.id,
        'milestone_approved', `Approved submission for milestone: "${milestone.title}"`);
      pool.query('SELECT email, name FROM users WHERE id = $1', [submission.builder_id]).then(({ rows: [u] }) => {
        if (u) sendMilestoneApproved(u.email, u.name, milestone.title, milestone.project_title,
          `${process.env.FRONTEND_URL}/projects/${milestone.project_id}`);
      }).catch(() => {});
    } else if (status === 'changes_requested') {
      await client.query(
        'UPDATE milestones SET status = $1, revision_count = revision_count + 1 WHERE id = $2',
        ['changes_requested', submission.milestone_id]
      );
      const snippet = feedback && feedback.length > 120 ? feedback.slice(0, 120) + '…' : feedback;
      await createNotification(submission.builder_id, 'changes_requested',
        `Changes requested for milestone: "${milestone.title}". Feedback: ${snippet || 'See submission.'}`,
        milestone.project_id, milestone.id);
      await logContribution(req.user.id, milestone.project_id, milestone.id,
        'milestone_changes_requested', `Requested changes on milestone: "${milestone.title}"`);
    } else {
      await client.query('UPDATE milestones SET status = $1 WHERE id = $2', ['claimed', submission.milestone_id]);
      const snippet = feedback && feedback.length > 120 ? feedback.slice(0, 120) + '…' : feedback;
      await createNotification(submission.builder_id, 'submission_rejected',
        `Your submission for "${milestone.title}" was rejected. Feedback: ${snippet || 'See submission.'}`,
        milestone.project_id, milestone.id);
      await logContribution(req.user.id, milestone.project_id, milestone.id,
        'milestone_rejected', `Rejected submission for milestone: "${milestone.title}"`);
    }

    await client.query('COMMIT');
    const updated = await pool.query('SELECT * FROM submissions WHERE id = $1', [req.params.id]);
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
