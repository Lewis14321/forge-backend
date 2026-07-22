require('dotenv').config();
const pool = require('./pool');
const bcrypt = require('bcryptjs');

async function seed() {
  const client = await pool.connect();
  try {
    // Create a test creator
    const hash = await bcrypt.hash('password123', 10);

    const { rows: [creator] } = await client.query(
      `INSERT INTO users (name, email, password, role)
       VALUES ('Test Creator', 'creator@test.com', $1, 'creator')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, email`,
      [hash]
    );
    console.log('Creator:', creator);

    // Create a test builder
    const { rows: [builder] } = await client.query(
      `INSERT INTO users (name, email, password, role)
       VALUES ('Test Builder', 'builder@test.com', $1, 'builder')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, email`,
      [hash]
    );
    console.log('Builder:', builder);

    // Create a test project
    const { rows: [project] } = await client.query(
      `INSERT INTO projects (title, description, budget, creator_id, max_builders, tech_stack, difficulty, locked_budget)
       VALUES ('AI Study Planner', 'Build a spaced-repetition study planner with AI-generated quiz questions and progress tracking.', 2400, $1, 3, ARRAY['React', 'Node.js', 'Python', 'AI'], 'medium', 2400)
       RETURNING id, title`,
      [creator.id]
    );
    console.log('Project:', project);

    // Create milestones
    const milestones = [
      { title: 'Set up authentication & user accounts', desc: 'Implement JWT auth with email/password. Users should be able to register, login, and manage their profile.', payment: 300 },
      { title: 'Build spaced repetition algorithm', desc: 'Implement the SM-2 spaced repetition algorithm to schedule card reviews based on user performance.', payment: 600 },
      { title: 'AI question generation', desc: 'Integrate OpenAI API to auto-generate quiz questions from user-uploaded study notes or topics.', payment: 800 },
      { title: 'Dashboard & progress tracking', desc: 'Build a stats dashboard showing study streaks, cards due today, accuracy rates, and weekly progress charts.', payment: 500 },
      { title: 'Mobile-responsive UI polish', desc: 'Ensure the full app is polished and responsive on mobile. Add animations and micro-interactions.', payment: 200 },
    ];

    for (const m of milestones) {
      const { rows: [ms] } = await client.query(
        `INSERT INTO milestones (project_id, title, description, payment)
         VALUES ($1, $2, $3, $4) RETURNING id, title`,
        [project.id, m.title, m.desc, m.payment]
      );
      console.log('  Milestone:', ms);
    }

    // Join builder to project and claim first milestone
    await client.query(
      `INSERT INTO project_builders (project_id, builder_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [project.id, builder.id]
    );

    // Claim the first milestone for the builder
    const { rows: [firstMs] } = await client.query(
      `SELECT id FROM milestones WHERE project_id = $1 ORDER BY id LIMIT 1`,
      [project.id]
    );
    await client.query(
      `UPDATE milestones SET status = 'claimed', claimed_by = $1 WHERE id = $2`,
      [builder.id, firstMs.id]
    );
    await client.query(
      `UPDATE projects SET status = 'in_progress' WHERE id = $1`,
      [project.id]
    );

    console.log('\n✓ Seed complete!');
    console.log('─────────────────────────────');
    console.log('Creator login:  creator@test.com / password123');
    console.log('Builder login:  builder@test.com / password123');
    console.log(`Project URL:    http://localhost:3000/projects/${project.id}`);
    console.log('─────────────────────────────');
  } catch (err) {
    console.error('Seed failed:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
