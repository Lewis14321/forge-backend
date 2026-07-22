const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');

async function createNotification(userId, type, message, projectId = null, milestoneId = null) {
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, type, message, related_project_id, related_milestone_id) VALUES ($1,$2,$3,$4,$5)',
      [userId, type, message, projectId, milestoneId]
    );
  } catch (err) {
    console.error('Notification error:', err.message);
  }
}

// GET /notifications
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /notifications/read-all
router.patch('/read-all', auth, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.user.id]);
    res.json({ message: 'All notifications marked as read' });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /notifications/:id/read
router.patch('/:id/read', auth, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ message: 'Notification marked as read' });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /notifications/activity/project/:id — recent activity events for a project
router.get('/activity/project/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT 'builder_joined' AS event_type, u.name AS actor_name, NULL AS milestone_title, pb.joined_at AS created_at
       FROM project_builders pb
       JOIN users u ON pb.builder_id = u.id
       WHERE pb.project_id = $1

       UNION ALL

       SELECT 'work_submitted' AS event_type, u.name AS actor_name, m.title AS milestone_title, s.submitted_at AS created_at
       FROM submissions s
       JOIN milestones m ON s.milestone_id = m.id
       JOIN users u ON s.builder_id = u.id
       WHERE m.project_id = $1

       UNION ALL

       SELECT 'milestone_approved' AS event_type, u.name AS actor_name, m.title AS milestone_title, s.updated_at AS created_at
       FROM submissions s
       JOIN milestones m ON s.milestone_id = m.id
       JOIN users u ON s.builder_id = u.id
       WHERE m.project_id = $1 AND s.status = 'approved'

       UNION ALL

       SELECT 'agreement_accepted' AS event_type, u.name AS actor_name, NULL AS milestone_title, aa.accepted_at AS created_at
       FROM agreement_acceptances aa
       JOIN users u ON aa.user_id = u.id
       WHERE aa.project_id = $1

       ORDER BY created_at DESC
       LIMIT 20`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.createNotification = createNotification;
