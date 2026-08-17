const { Pool } = require('pg');
const fs = require('fs');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    console.log('Dropping all tables...');
    await pool.query(`
      DROP TABLE IF EXISTS admin_audit_logs CASCADE;
      DROP TABLE IF EXISTS platform_config CASCADE;
      DROP TABLE IF EXISTS password_reset_tokens CASCADE;
      DROP TABLE IF EXISTS project_files CASCADE;
      DROP TABLE IF EXISTS milestone_messages CASCADE;
      DROP TABLE IF EXISTS contribution_logs CASCADE;
      DROP TABLE IF EXISTS disputes CASCADE;
      DROP TABLE IF EXISTS agreement_acceptances CASCADE;
      DROP TABLE IF EXISTS reports CASCADE;
      DROP TABLE IF EXISTS transactions CASCADE;
      DROP TABLE IF EXISTS join_requests CASCADE;
      DROP TABLE IF EXISTS reviews CASCADE;
      DROP TABLE IF EXISTS submissions CASCADE;
      DROP TABLE IF EXISTS project_builders CASCADE;
      DROP TABLE IF EXISTS milestones CASCADE;
      DROP TABLE IF EXISTS projects CASCADE;
      DROP TABLE IF EXISTS notifications CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
    `);
    console.log('✓ All tables dropped');

    console.log('Applying correct schema...');
    const schema = fs.readFileSync('./schema.sql', 'utf8');
    await pool.query(schema);
    console.log('✓ Schema applied successfully!');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
