const { Pool } = require('pg');
const fs = require('fs');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    const schema = fs.readFileSync('./schema.sql', 'utf8');
    console.log('Applying schema...');
    await pool.query(schema);
    console.log('✓ Schema applied successfully!');
    process.exit(0);
  } catch (err) {
    console.error('Error applying schema:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
