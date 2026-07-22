const pool = require('./pool');
const bcrypt = require('bcryptjs');

const hash = (p) => bcrypt.hash(p, 10);

async function seed() {
  const client = await pool.connect();
  try {
    // Create admin account (idempotent — safe to run multiple times)
    const adminHash = await hash('admin123');
    await client.query(
      `INSERT INTO users (name, email, password, role, is_admin, account_status)
       VALUES ('Admin', 'admin@forge.local', $1, 'creator', true, 'active')
       ON CONFLICT (email) DO NOTHING`,
      [adminHash]
    );
    console.log('Admin account ready: admin@forge.local / admin123');

    await client.query('BEGIN');

    // Clear existing demo data
    await client.query(`DELETE FROM reviews WHERE reviewer_id IN (SELECT id FROM users WHERE email LIKE '%@demo.com')`);
    await client.query(`DELETE FROM submissions WHERE builder_id IN (SELECT id FROM users WHERE email LIKE '%@demo.com')`);
    await client.query(`DELETE FROM project_builders WHERE builder_id IN (SELECT id FROM users WHERE email LIKE '%@demo.com')`);
    await client.query(`DELETE FROM milestones WHERE project_id IN (SELECT id FROM projects WHERE creator_id IN (SELECT id FROM users WHERE email LIKE '%@demo.com'))`);
    await client.query(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@demo.com')`);
    await client.query(`DELETE FROM projects WHERE creator_id IN (SELECT id FROM users WHERE email LIKE '%@demo.com')`);
    await client.query(`DELETE FROM users WHERE email LIKE '%@demo.com'`);

    // Create users
    const pw = await hash('demo123');

    const { rows: [alice] } = await client.query(
      `INSERT INTO users (name, email, password, role, avg_rating, rating_count) VALUES ($1,$2,$3,'creator',4.8,12) RETURNING id`,
      ['Alice Chen', 'alice@demo.com', pw]
    );
    const { rows: [marcus] } = await client.query(
      `INSERT INTO users (name, email, password, role, avg_rating, rating_count) VALUES ($1,$2,$3,'creator',4.5,7) RETURNING id`,
      ['Marcus Reid', 'marcus@demo.com', pw]
    );
    const { rows: [dan] } = await client.query(
      `INSERT INTO users (name, email, password, role, avg_rating, rating_count) VALUES ($1,$2,$3,'builder',4.9,18) RETURNING id`,
      ['Dev Dan', 'dan@demo.com', pw]
    );
    const { rows: [sarah] } = await client.query(
      `INSERT INTO users (name, email, password, role, avg_rating, rating_count) VALUES ($1,$2,$3,'builder',4.7,9) RETURNING id`,
      ['Sarah Kim', 'sarah@demo.com', pw]
    );

    // Helper
    async function createProject(creatorId, data, milestones) {
      const { rows: [p] } = await client.query(
        `INSERT INTO projects (title, description, budget, creator_id, max_builders, tech_stack, difficulty, status, locked_budget)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$3) RETURNING id`,
        [data.title, data.description, data.budget, creatorId, data.maxBuilders || 2,
         data.tags, data.difficulty || 'medium', data.status || 'open']
      );
      for (const m of milestones) {
        await client.query(
          `INSERT INTO milestones (project_id, title, description, deliverables, payment, status)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [p.id, m.title, m.description, m.deliverables || '', m.payment, m.status || 'open']
        );
      }
      return p.id;
    }

    // ── PROJECTS ──────────────────────────────────────────────

    await createProject(alice.id, {
      title: 'AI Study Planner',
      description: 'Build a smart study planner that uses AI to generate personalised revision schedules based on a student\'s subjects, exam dates, and learning pace. Should include a dashboard, progress tracking, and daily reminders.',
      budget: 150, tags: ['AI', 'React', 'Python', 'OpenAI'], difficulty: 'medium', maxBuilders: 2,
    }, [
      { title: 'Backend API & AI Integration', description: 'Set up FastAPI backend and integrate with OpenAI to generate study plans based on user input.', deliverables: 'REST API, OpenAI integration, /generate-plan endpoint', payment: 60, status: 'open' },
      { title: 'React Dashboard', description: 'Build the frontend dashboard with calendar view, subject management, and progress charts.', deliverables: 'React app, calendar component, chart.js integration', payment: 55, status: 'open' },
      { title: 'Reminder & Notification System', description: 'Email or push notifications for daily study reminders.', deliverables: 'Email integration, cron jobs, notification preferences', payment: 35, status: 'open' },
    ]);

    await createProject(alice.id, {
      title: 'Fitness Tracker App',
      description: 'A mobile-first web app where users can log workouts, track calories, set weekly goals, and see progress over time. Should include exercise library and workout templates.',
      budget: 200, tags: ['React Native', 'Node.js', 'Health', 'Charts'], difficulty: 'hard', maxBuilders: 3, status: 'in_progress',
    }, [
      { title: 'Database & Auth', description: 'PostgreSQL schema for users, workouts, exercises. JWT auth.', deliverables: 'Schema, migrations, auth endpoints', payment: 50, status: 'approved' },
      { title: 'Workout Logging API', description: 'CRUD endpoints for logging workouts, sets, reps, and calories.', deliverables: 'REST API, validation, Swagger docs', payment: 70, status: 'submitted' },
      { title: 'Mobile UI', description: 'React Native UI for logging workouts and viewing progress charts.', deliverables: 'iOS + Android compatible screens', payment: 80, status: 'open' },
    ]);

    await createProject(alice.id, {
      title: 'Portfolio Generator',
      description: 'A tool that lets developers paste their GitHub username and auto-generates a beautiful portfolio site using their repos, contributions, and profile data. Deployable to Vercel with one click.',
      budget: 120, tags: ['Next.js', 'GitHub API', 'Tailwind', 'Vercel'], difficulty: 'easy', maxBuilders: 1,
    }, [
      { title: 'GitHub API Integration', description: 'Fetch repos, contribution graph, and profile info from GitHub API.', deliverables: 'GitHub OAuth, data fetching, caching', payment: 45, status: 'open' },
      { title: 'Portfolio Templates', description: '3 responsive portfolio templates the user can choose from.', deliverables: 'Three fully responsive Next.js templates', payment: 75, status: 'open' },
    ]);

    await createProject(marcus.id, {
      title: 'Discord Bot Builder',
      description: 'A no-code platform for building Discord bots — users drag and drop event triggers and actions (send message, assign role, etc.) without writing code. Export as deployable Node.js bot.',
      budget: 80, tags: ['Node.js', 'Discord.js', 'React', 'DnD'], difficulty: 'medium', maxBuilders: 1,
    }, [
      { title: 'Bot Logic Engine', description: 'Core system that interprets visual flow configs and executes Discord bot actions.', deliverables: 'Bot engine, event handlers, action runner', payment: 45, status: 'open' },
      { title: 'Visual Flow Builder UI', description: 'Drag-and-drop UI for building bot workflows.', deliverables: 'React DnD interface, JSON export, live preview', payment: 35, status: 'open' },
    ]);

    await createProject(marcus.id, {
      title: 'E-commerce Analytics Dashboard',
      description: 'A dashboard that connects to Shopify or WooCommerce and visualises sales, traffic, top products, and customer retention metrics. Includes AI-generated weekly summary reports.',
      budget: 350, tags: ['React', 'PostgreSQL', 'Shopify API', 'Charts', 'AI'], difficulty: 'hard', maxBuilders: 3, status: 'in_progress',
    }, [
      { title: 'Shopify & WooCommerce Integration', description: 'OAuth + API integration to pull orders, products, customers.', deliverables: 'OAuth flows, data sync pipeline', payment: 100, status: 'approved' },
      { title: 'Analytics Backend', description: 'Data aggregation API, metrics calculations, trend analysis.', deliverables: 'REST API, caching layer, aggregation jobs', payment: 100, status: 'changes_requested' },
      { title: 'Dashboard UI', description: 'Charts, KPI cards, date-range filtering, export to PDF.', deliverables: 'React dashboard, chart.js, PDF export', payment: 100, status: 'open' },
      { title: 'AI Summary Reports', description: 'Weekly AI-generated email reports with insights and recommendations.', deliverables: 'OpenAI integration, email template, scheduler', payment: 50, status: 'open' },
    ]);

    await createProject(marcus.id, {
      title: 'Real-time Chat App',
      description: 'A Slack-like real-time chat application with channels, direct messages, file sharing, and emoji reactions. Should support thousands of concurrent users.',
      budget: 180, tags: ['WebSockets', 'React', 'Node.js', 'Redis'], difficulty: 'hard', maxBuilders: 2,
    }, [
      { title: 'WebSocket Server', description: 'Node.js + Socket.io backend for real-time messaging, presence, and typing indicators.', deliverables: 'WS server, Redis pub/sub, scalable architecture', payment: 70, status: 'open' },
      { title: 'React Chat UI', description: 'Full chat interface with channels sidebar, message list, and direct messages.', deliverables: 'React app, virtual scroll, emoji picker', payment: 70, status: 'open' },
      { title: 'File Sharing & Search', description: 'File upload to S3, message search with Postgres full-text search.', deliverables: 'S3 integration, search API, file preview', payment: 40, status: 'open' },
    ]);

    await createProject(alice.id, {
      title: 'Job Board Platform',
      description: 'A niche job board for remote developer jobs. Companies post jobs, developers apply, and the platform handles application tracking. Includes email notifications and a simple ATS.',
      budget: 280, tags: ['Next.js', 'PostgreSQL', 'Auth', 'Email'], difficulty: 'medium', maxBuilders: 2,
    }, [
      { title: 'Auth & User Roles', description: 'Company and developer accounts, auth, profile setup.', deliverables: 'Auth system, two user roles, profile pages', payment: 70, status: 'open' },
      { title: 'Job Posting & Search', description: 'Job CRUD for companies, search and filter for developers.', deliverables: 'Posting form, search API, filters', payment: 90, status: 'open' },
      { title: 'Application Tracking', description: 'Apply to jobs, track status (applied/interviewing/rejected), email notifications.', deliverables: 'Application flow, status pipeline, email triggers', payment: 120, status: 'open' },
    ]);

    await createProject(marcus.id, {
      title: 'Browser Extension: Tab Manager',
      description: 'A Chrome extension that groups tabs by project or topic using AI, saves session snapshots, and lets you switch between "workspaces" with a single click. Like Arc but as an extension.',
      budget: 90, tags: ['JavaScript', 'Chrome Extension', 'AI', 'Storage'], difficulty: 'easy', maxBuilders: 1,
    }, [
      { title: 'Extension Core & Tab Detection', description: 'Chrome extension manifest v3, tab detection, and storage API.', deliverables: 'Extension scaffold, tab events, local storage', payment: 35, status: 'open' },
      { title: 'AI Grouping & Workspace UI', description: 'AI-powered tab grouping and the extension popup UI.', deliverables: 'OpenAI integration, popup UI, workspace management', payment: 55, status: 'open' },
    ]);

    await client.query('COMMIT');
    console.log('Seed complete! Users created:');
    console.log('  Creator:  alice@demo.com  / demo123');
    console.log('  Creator:  marcus@demo.com / demo123');
    console.log('  Builder:  dan@demo.com    / demo123');
    console.log('  Builder:  sarah@demo.com  / demo123');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
