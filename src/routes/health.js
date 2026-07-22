const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');

// GET /health/project/:projectId — compute project health snapshot
router.get('/project/:projectId', auth, async (req, res) => {
  const { projectId } = req.params;

  try {
    // Fetch project + participants check
    const { rows: [project] } = await pool.query(
      `SELECT p.*,
              EXISTS(SELECT 1 FROM project_builders pb WHERE pb.project_id = p.id AND pb.builder_id = $2) AS is_builder
       FROM projects p WHERE p.id = $1`,
      [projectId, req.user.id]
    );
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const isParticipant = project.creator_id === req.user.id || project.is_builder;
    if (!isParticipant) return res.status(403).json({ error: 'Access denied' });

    const now = new Date();

    // Milestone stats
    const { rows: milestones } = await pool.query(
      'SELECT id, status, funding_status, deadline, claimed_by FROM milestones WHERE project_id = $1',
      [projectId]
    );

    const total = milestones.length;
    const approved = milestones.filter(m => m.status === 'approved').length;
    const inProgress = milestones.filter(m => ['claimed', 'in_progress', 'submitted', 'changes_requested'].includes(m.status)).length;
    const open = milestones.filter(m => m.status === 'open').length;
    const funded = milestones.filter(m => m.funding_status === 'funded' || m.funding_status === 'released' || m.funding_status === 'pending_release').length;

    const overdueMilestones = milestones.filter(m =>
      m.deadline &&
      new Date(m.deadline) < now &&
      !['approved', 'rejected'].includes(m.status)
    );

    const pendingReview = milestones.filter(m => m.status === 'submitted').length;

    // Most recent submission for "last activity" calculation
    const { rows: recentActivity } = await pool.query(
      `SELECT
         (SELECT MAX(s.submitted_at) FROM submissions s
          JOIN milestones m ON s.milestone_id = m.id
          WHERE m.project_id = $1) AS last_submission,
         (SELECT MAX(pb.joined_at) FROM project_builders pb
          WHERE pb.project_id = $1) AS last_join`,
      [projectId]
    );

    const lastSubmission = recentActivity[0]?.last_submission;
    const lastJoin = recentActivity[0]?.last_join;
    const lastActivityDate = [lastSubmission, lastJoin, project.created_at]
      .filter(Boolean)
      .map(d => new Date(d))
      .reduce((a, b) => (a > b ? a : b), new Date(0));

    const daysSinceActivity = Math.floor((now - lastActivityDate) / (1000 * 60 * 60 * 24));

    // Open disputes
    const { rows: [disputeCount] } = await pool.query(
      "SELECT COUNT(*) AS count FROM disputes WHERE project_id = $1 AND status = 'open'",
      [projectId]
    );
    const openDisputes = parseInt(disputeCount.count, 10);

    // Builder count
    const { rows: [builderCount] } = await pool.query(
      'SELECT COUNT(*) AS count FROM project_builders WHERE project_id = $1',
      [projectId]
    );
    const builderTotal = parseInt(builderCount.count, 10);

    // Determine health status
    let status = 'healthy';
    const risks = [];

    if (project.status === 'completed') {
      status = 'completed';
    } else if (project.status === 'cancelled') {
      status = 'cancelled';
    } else {
      if (overdueMilestones.length > 0) {
        risks.push(`${overdueMilestones.length} overdue milestone${overdueMilestones.length > 1 ? 's' : ''}`);
        status = 'at_risk';
      }
      if (pendingReview > 0) {
        risks.push(`${pendingReview} submission${pendingReview > 1 ? 's' : ''} awaiting review`);
        if (status !== 'at_risk') status = 'at_risk';
      }
      if (openDisputes > 0) {
        risks.push(`${openDisputes} open dispute${openDisputes > 1 ? 's' : ''}`);
        status = 'at_risk';
      }
      if (daysSinceActivity >= 14 && project.status !== 'completed') {
        risks.push(`No activity for ${daysSinceActivity} days`);
        status = 'inactive';
      }
    }

    const progressPct = total > 0 ? Math.round((approved / total) * 100) : 0;
    const fundedPct = total > 0 ? Math.round((funded / total) * 100) : 0;

    res.json({
      status,
      risks,
      milestones: {
        total,
        approved,
        inProgress,
        open,
        funded,
        overdue: overdueMilestones.length,
        pendingReview,
        progressPct,
        fundedPct,
        overdueList: overdueMilestones.map(m => ({ id: m.id })),
      },
      activity: {
        daysSinceActivity,
        lastActivityDate: lastActivityDate.toISOString(),
      },
      team: {
        builderTotal,
        maxBuilders: project.max_builders,
      },
      openDisputes,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /health/creator/overview — health summary for all creator projects
router.get('/creator/overview', auth, async (req, res) => {
  try {
    const { rows: projects } = await pool.query(
      `SELECT p.id, p.title, p.status, p.project_type,
              COUNT(DISTINCT pb.builder_id) AS builder_count,
              COUNT(m.id) AS milestone_total,
              COUNT(CASE WHEN m.status = 'approved' THEN 1 END) AS milestone_approved,
              COUNT(CASE WHEN m.status = 'submitted' THEN 1 END) AS milestone_pending_review,
              COUNT(CASE WHEN m.deadline IS NOT NULL AND m.deadline < NOW() AND m.status NOT IN ('approved','rejected') THEN 1 END) AS milestone_overdue,
              COUNT(CASE WHEN d.status = 'open' THEN 1 END) AS open_disputes
       FROM projects p
       LEFT JOIN milestones m ON m.project_id = p.id
       LEFT JOIN project_builders pb ON pb.project_id = p.id
       LEFT JOIN disputes d ON d.project_id = p.id
       WHERE p.creator_id = $1 AND p.status NOT IN ('cancelled','completed')
       GROUP BY p.id
       ORDER BY p.created_at DESC`,
      [req.user.id]
    );

    const withHealth = projects.map(p => {
      let health = 'healthy';
      const overdueCount = parseInt(p.milestone_overdue, 10);
      const pendingReview = parseInt(p.milestone_pending_review, 10);
      const openDisputes = parseInt(p.open_disputes, 10);

      if (openDisputes > 0 || overdueCount > 0) health = 'at_risk';
      if (pendingReview > 2) health = 'at_risk';

      return {
        id: p.id,
        title: p.title,
        status: p.status,
        project_type: p.project_type,
        builder_count: parseInt(p.builder_count, 10),
        milestone_total: parseInt(p.milestone_total, 10),
        milestone_approved: parseInt(p.milestone_approved, 10),
        milestone_overdue: overdueCount,
        milestone_pending_review: pendingReview,
        open_disputes: openDisputes,
        health,
        progress_pct: p.milestone_total > 0 ? Math.round((p.milestone_approved / p.milestone_total) * 100) : 0,
      };
    });

    res.json(withHealth);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
