const pool = require('./pool');

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('creator', 'builder')),
  avg_rating NUMERIC(3,2) DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  budget NUMERIC(12,2) NOT NULL,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  max_builders INTEGER NOT NULL DEFAULT 1,
  tech_stack TEXT[],
  difficulty VARCHAR(20) DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  locked_budget NUMERIC(12,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS milestones (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  deliverables TEXT,
  payment NUMERIC(12,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'submitted', 'changes_requested', 'approved')),
  claimed_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_builders (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  builder_id INTEGER NOT NULL REFERENCES users(id),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, builder_id)
);

CREATE TABLE IF NOT EXISTS submissions (
  id SERIAL PRIMARY KEY,
  milestone_id INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  builder_id INTEGER NOT NULL REFERENCES users(id),
  github_link VARCHAR(512) NOT NULL,
  description TEXT NOT NULL,
  status VARCHAR(30) DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected', 'changes_requested')),
  feedback TEXT,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  target_user_id INTEGER NOT NULL REFERENCES users(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  quality INTEGER CHECK (quality BETWEEN 1 AND 5),
  communication INTEGER CHECK (communication BETWEEN 1 AND 5),
  reliability INTEGER CHECK (reliability BETWEEN 1 AND 5),
  clarity INTEGER CHECK (clarity BETWEEN 1 AND 5),
  fairness INTEGER CHECK (fairness BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(reviewer_id, target_user_id, project_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  related_project_id INTEGER REFERENCES projects(id),
  related_milestone_id INTEGER REFERENCES milestones(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS stripe_account_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS stripe_onboarded BOOLEAN DEFAULT false;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS funded BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS skills TEXT[] DEFAULT '{}';

ALTER TABLE milestones
  DROP CONSTRAINT IF EXISTS milestones_status_check,
  ADD CONSTRAINT milestones_status_check
    CHECK (status IN ('open','claimed','in_progress','submitted','changes_requested','approved','rejected'));

ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS revision_count INTEGER DEFAULT 0;

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS live_demo_link VARCHAR(512);

ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS funding_status VARCHAR(20) DEFAULT 'unfunded',
  DROP CONSTRAINT IF EXISTS milestones_funding_status_check,
  ADD CONSTRAINT milestones_funding_status_check
    CHECK (funding_status IN ('unfunded', 'funded', 'pending_release', 'released'));

CREATE TABLE IF NOT EXISTS join_requests (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  builder_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT DEFAULT '',
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, builder_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  type VARCHAR(30) NOT NULL CHECK (type IN ('deposit', 'payout', 'fee', 'pending_payout')),
  amount NUMERIC(12,2) NOT NULL,
  project_id INTEGER REFERENCES projects(id),
  user_id INTEGER REFERENCES users(id),
  milestone_id INTEGER REFERENCES milestones(id),
  stripe_id VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('user', 'project')),
  target_id INTEGER NOT NULL,
  reason VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(reporter_id, target_type, target_id)
);

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS project_type VARCHAR(20) DEFAULT 'funded',
  ADD COLUMN IF NOT EXISTS vision TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS long_term_goal TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS commitment_level VARCHAR(50) DEFAULT '',
  ADD COLUMN IF NOT EXISTS roles_needed TEXT[] DEFAULT '{}';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE constraint_name = 'projects_project_type_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_project_type_check CHECK (project_type IN ('funded', 'collaboration'));
  END IF;
END $$;

ALTER TABLE join_requests
  ADD COLUMN IF NOT EXISTS skills TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS why_join TEXT DEFAULT '';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'users_role_check_v2'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check_v2
      CHECK (role IN ('creator', 'builder', 'both'));
  END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS tagline VARCHAR(120) DEFAULT '';

-- Real escrow balance columns
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS total_funded NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS available_balance NUMERIC(12,2) DEFAULT 0;

-- Add milestone_allocation to transactions
ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_type_check,
  ADD CONSTRAINT transactions_type_check
    CHECK (type IN ('deposit', 'payout', 'fee', 'pending_payout', 'milestone_allocation'));

-- Project expectations (creator-defined, optional)
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS communication_expectations TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS workflow_notes TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS review_timeline TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS collaboration_style TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS agreement_version INTEGER DEFAULT 1;

-- Agreement acceptances log
CREATE TABLE IF NOT EXISTS agreement_acceptances (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  agreement_version INTEGER NOT NULL DEFAULT 1,
  accepted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, user_id)
);

-- Milestone deadlines
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS deadline TIMESTAMPTZ;

-- Disputes (lightweight accountability log, no moderation)
CREATE TABLE IF NOT EXISTS disputes (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  initiator_id INTEGER NOT NULL REFERENCES users(id),
  respondent_id INTEGER REFERENCES users(id),
  dispute_type VARCHAR(50) NOT NULL CHECK (dispute_type IN (
    'unfair_rejection', 'milestone_abuse', 'poor_quality',
    'abandonment', 'payment_issue', 'communication', 'other'
  )),
  reason VARCHAR(150) NOT NULL,
  description TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'withdrawn', 'resolved')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  UNIQUE(initiator_id, project_id, dispute_type)
);

ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE projects DISABLE ROW LEVEL SECURITY;
ALTER TABLE milestones DISABLE ROW LEVEL SECURITY;
ALTER TABLE project_builders DISABLE ROW LEVEL SECURITY;
ALTER TABLE submissions DISABLE ROW LEVEL SECURITY;
ALTER TABLE reviews DISABLE ROW LEVEL SECURITY;
ALTER TABLE notifications DISABLE ROW LEVEL SECURITY;
ALTER TABLE join_requests DISABLE ROW LEVEL SECURITY;
ALTER TABLE transactions DISABLE ROW LEVEL SECURITY;
ALTER TABLE reports DISABLE ROW LEVEL SECURITY;
ALTER TABLE agreement_acceptances DISABLE ROW LEVEL SECURITY;
ALTER TABLE disputes DISABLE ROW LEVEL SECURITY;

-- Contribution logs (immutable audit trail — no updated_at by design)
CREATE TABLE IF NOT EXISTS contribution_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
  action_type VARCHAR(50) NOT NULL,
  action_detail TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE contribution_logs DISABLE ROW LEVEL SECURITY;

-- GitHub integration placeholders (no integration yet — structure only)
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_username VARCHAR(100) DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_connected BOOLEAN DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_repo_url VARCHAR(512) DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_linked BOOLEAN DEFAULT false;

-- ── Admin system ──────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) DEFAULT 'active';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'users_account_status_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_account_status_check
      CHECK (account_status IN ('active', 'suspended', 'flagged'));
  END IF;
END $$;

-- Reports: status workflow
ALTER TABLE reports ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'open';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS admin_notes TEXT DEFAULT '';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'reports_status_check'
  ) THEN
    ALTER TABLE reports ADD CONSTRAINT reports_status_check
      CHECK (status IN ('open', 'reviewing', 'resolved'));
  END IF;
END $$;

-- Disputes: add under_review status
ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_status_check;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'disputes_status_check_v2'
  ) THEN
    ALTER TABLE disputes ADD CONSTRAINT disputes_status_check_v2
      CHECK (status IN ('open', 'under_review', 'withdrawn', 'resolved'));
  END IF;
END $$;

-- Admin audit log
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(50),
  target_id INTEGER,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance indices
CREATE INDEX IF NOT EXISTS idx_projects_creator_id       ON projects(creator_id);
CREATE INDEX IF NOT EXISTS idx_projects_status           ON projects(status);
CREATE INDEX IF NOT EXISTS idx_milestones_project_id     ON milestones(project_id);
CREATE INDEX IF NOT EXISTS idx_milestones_claimed_by     ON milestones(claimed_by);
CREATE INDEX IF NOT EXISTS idx_milestones_status         ON milestones(status);
CREATE INDEX IF NOT EXISTS idx_project_builders_project  ON project_builders(project_id);
CREATE INDEX IF NOT EXISTS idx_project_builders_builder  ON project_builders(builder_id);
CREATE INDEX IF NOT EXISTS idx_submissions_milestone_id  ON submissions(milestone_id);
CREATE INDEX IF NOT EXISTS idx_submissions_builder_id    ON submissions(builder_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read   ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_reviews_target_user       ON reviews(target_user_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_project     ON join_requests(project_id, status);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id      ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_project_id   ON transactions(project_id);
CREATE INDEX IF NOT EXISTS idx_disputes_project_id       ON disputes(project_id);
CREATE INDEX IF NOT EXISTS idx_disputes_initiator_id     ON disputes(initiator_id);
CREATE INDEX IF NOT EXISTS idx_milestones_deadline       ON milestones(deadline) WHERE deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contribution_logs_user_id    ON contribution_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_contribution_logs_project_id ON contribution_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_contribution_logs_action     ON contribution_logs(action_type);
CREATE INDEX IF NOT EXISTS idx_contribution_logs_created_at ON contribution_logs(created_at DESC);

-- Milestone messages (creator ↔ builder thread per milestone)
CREATE TABLE IF NOT EXISTS milestone_messages (
  id SERIAL PRIMARY KEY,
  milestone_id INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_milestone_messages_milestone ON milestone_messages(milestone_id, created_at);

-- Project file attachments
CREATE TABLE IF NOT EXISTS project_files (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  name VARCHAR(255) NOT NULL,
  size INTEGER NOT NULL,
  mime_type VARCHAR(100),
  storage_key VARCHAR(512) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_files_project_id ON project_files(project_id);

-- Password reset tokens
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token);

-- Flag column for admin content moderation
ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT false;

-- Remove legacy virtual_balance column
ALTER TABLE users DROP COLUMN IF EXISTS virtual_balance;

-- Platform configuration (singleton row — always id = 1)
CREATE TABLE IF NOT EXISTS platform_config (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  platform_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 10,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO platform_config (id, platform_fee_percent) VALUES (1, 10) ON CONFLICT (id) DO NOTHING;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(schema);
    console.log('Migration complete.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
