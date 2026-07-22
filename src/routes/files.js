const router = require('express').Router();
const crypto = require('crypto');
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { getUploadUrl, getDownloadUrl, deleteFile } = require('../lib/storage');

async function isParticipant(projectId, userId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM projects WHERE id = $1 AND creator_id = $2
     UNION
     SELECT 1 FROM project_builders WHERE project_id = $1 AND builder_id = $2`,
    [projectId, userId]
  );
  return rows.length > 0;
}

// GET /files/project/:id — list files for project
router.get('/project/:id', auth, async (req, res) => {
  try {
    if (!(await isParticipant(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { rows } = await pool.query(
      `SELECT f.*, u.name AS uploader_name
       FROM project_files f
       JOIN users u ON f.uploader_id = u.id
       WHERE f.project_id = $1
       ORDER BY f.created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf',
  'text/plain', 'text/csv', 'text/markdown',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

// POST /files/project/:id/upload-url — get presigned PUT URL
router.post('/project/:id/upload-url', auth, async (req, res) => {
  const { name, type } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type required' });
  if (!ALLOWED_MIME_TYPES.has(type)) return res.status(400).json({ error: 'File type not allowed' });
  try {
    if (!(await isParticipant(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const ext = name.includes('.') ? name.split('.').pop() : '';
    const key = `projects/${req.params.id}/${crypto.randomUUID()}${ext ? '.' + ext : ''}`;
    const uploadUrl = await getUploadUrl(key, type);
    res.json({ uploadUrl, key });
  } catch (err) {
    if (err.message === 'R2 not configured') {
      return res.status(503).json({ error: 'File storage is not configured on this server.' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /files/project/:id — register file after upload completes
router.post('/project/:id', auth, async (req, res) => {
  const { name, size, mime_type, storage_key } = req.body;
  if (!name || !size || !storage_key) return res.status(400).json({ error: 'name, size, storage_key required' });
  if (size > 50 * 1024 * 1024) return res.status(400).json({ error: 'File must be under 50 MB' });
  try {
    if (!(await isParticipant(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { rows } = await pool.query(
      `INSERT INTO project_files (project_id, uploader_id, name, size, mime_type, storage_key)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, req.user.id, name, size, mime_type || null, storage_key]
    );
    const { rows: [withUploader] } = await pool.query(
      `SELECT f.*, u.name AS uploader_name FROM project_files f JOIN users u ON f.uploader_id = u.id WHERE f.id = $1`,
      [rows[0].id]
    );
    res.status(201).json(withUploader);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /files/:fileId/download-url — presigned download URL
router.get('/:fileId/download-url', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM project_files WHERE id = $1', [req.params.fileId]);
    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    const file = rows[0];
    if (!(await isParticipant(file.project_id, req.user.id))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const url = await getDownloadUrl(file.storage_key, file.name);
    res.json({ url });
  } catch (err) {
    if (err.message === 'R2 not configured') {
      return res.status(503).json({ error: 'File storage is not configured.' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /files/:fileId — delete a file (uploader or creator)
router.delete('/:fileId', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*, p.creator_id FROM project_files f JOIN projects p ON f.project_id = p.id WHERE f.id = $1`,
      [req.params.fileId]
    );
    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    const file = rows[0];
    const canDelete = file.uploader_id === req.user.id || file.creator_id === req.user.id || req.user.is_admin;
    if (!canDelete) return res.status(403).json({ error: 'Only the uploader or project creator can delete files' });
    await deleteFile(file.storage_key);
    await pool.query('DELETE FROM project_files WHERE id = $1', [req.params.fileId]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    if (err.message === 'R2 not configured') {
      return res.status(503).json({ error: 'File storage is not configured.' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
