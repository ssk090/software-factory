-- software-factory history, MySQL 8.4. Safe to run again: creates only what is missing,
-- and replaces the views. Times are stored in UTC.

CREATE TABLE IF NOT EXISTS tickets (
  ticket_key   VARCHAR(64)  PRIMARY KEY,         -- e.g. CHP-3027
  title        VARCHAR(500),
  description  MEDIUMTEXT,                       -- ticket.md as the agents saw it
  first_seen   DATETIME     DEFAULT CURRENT_TIMESTAMP,
  last_run_at  DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS runs (
  id             VARCHAR(100) PRIMARY KEY,       -- <ticket>-<start unix time>
  ticket_key     VARCHAR(64)  NOT NULL,
  started_at     DATETIME,
  ended_at       DATETIME,
  status         VARCHAR(20),                    -- running | pr_open | spec_posted | failed | done
  failure        TEXT,
  pr_url         VARCHAR(500),
  pr_title       VARCHAR(500),
  pr_body        MEDIUMTEXT,
  review_rounds  INT,
  final_verdict  VARCHAR(8),                     -- PASS | FIX
  judge_score    TINYINT,                        -- 1..5, from the judge agent
  files_changed  INT,
  lines_added    INT,
  lines_deleted  INT,
  spec           MEDIUMTEXT,
  plan           MEDIUMTEXT,
  tests          MEDIUMTEXT,
  INDEX runs_ticket_started (ticket_key, started_at),
  CONSTRAINT runs_ticket_fk FOREIGN KEY (ticket_key) REFERENCES tickets (ticket_key),
  CONSTRAINT runs_status_check  CHECK (status IN ('running', 'pr_open', 'spec_posted', 'failed', 'done')),
  CONSTRAINT runs_verdict_check CHECK (final_verdict IN ('PASS', 'FIX')),
  CONSTRAINT runs_score_check   CHECK (judge_score BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS agent_steps (
  run_id          VARCHAR(100) NOT NULL,
  seq             INT          NOT NULL,
  agent           VARCHAR(40),                   -- spec, plan, test, code, docs, pr-summary, review, fix, judge
  round_no        INT,
  cli             VARCHAR(40),                   -- codex, claude, opencode, cursor, pi
  model           VARCHAR(200),
  started_at      DATETIME,
  ended_at        DATETIME,
  duration_s      INT,
  exit_code       INT,
  ok              BOOLEAN,
  router_skipped  TEXT,                          -- why the router skipped other models
  skills          TEXT,                          -- which skills it got, and from where
  prompt          MEDIUMTEXT,                    -- trimmed
  output          MEDIUMTEXT,                    -- trimmed
  PRIMARY KEY (run_id, seq),
  CONSTRAINT steps_run_fk FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS reviews (
  run_id    VARCHAR(100) NOT NULL,
  round_no  INT          NOT NULL,
  verdict   VARCHAR(8),
  body      MEDIUMTEXT,
  PRIMARY KEY (run_id, round_no),
  CONSTRAINT reviews_run_fk FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE,
  CONSTRAINT reviews_verdict_check CHECK (verdict IN ('PASS', 'FIX'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS judgements (
  run_id              VARCHAR(100) PRIMARY KEY,
  score               TINYINT,
  summary             TEXT,
  criteria            JSON,                      -- [{id, text, status, evidence}]
  spec_gaps           JSON,
  hallucinations      JSON,                      -- [{claim, where, why}]
  out_of_scope        JSON,
  prompt_suggestions  JSON,                      -- [{agent, problem, suggestion}]
  raw                 JSON,
  CONSTRAINT judgements_run_fk FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE,
  CONSTRAINT judgements_score_check CHECK (score BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row per run: the overall picture.
CREATE OR REPLACE VIEW v_runs AS
SELECT r.ticket_key, t.title, r.started_at, TIMEDIFF(r.ended_at, r.started_at) AS took, r.status, r.pr_url,
       r.final_verdict, r.review_rounds, r.judge_score, j.summary AS judge_summary,
       COALESCE(JSON_LENGTH(j.hallucinations), 0) AS hallucinations,
       (SELECT COUNT(*) FROM JSON_TABLE(COALESCE(j.criteria, JSON_ARRAY()), '$[*]'
          COLUMNS (status VARCHAR(20) PATH '$.status')) c WHERE c.status = 'met') AS criteria_met,
       COALESCE(JSON_LENGTH(j.criteria), 0) AS criteria_total,
       r.files_changed, r.lines_added, r.lines_deleted, r.failure, r.id AS run_id
FROM runs r JOIN tickets t ON t.ticket_key = r.ticket_key
LEFT JOIN judgements j ON j.run_id = r.id;

-- How each agent and model performs.
CREATE OR REPLACE VIEW v_agent_stats AS
SELECT agent, cli, model, COUNT(*) AS steps, SUM(NOT ok) AS failures,
       ROUND(AVG(duration_s)) AS avg_seconds, COUNT(DISTINCT run_id) AS runs
FROM agent_steps GROUP BY agent, cli, model;

-- Every acceptance criterion the judge checked.
CREATE OR REPLACE VIEW v_criteria AS
SELECT r.ticket_key, j.run_id, c.criterion, c.status, c.criterion_text, c.evidence
FROM judgements j JOIN runs r ON r.id = j.run_id,
     JSON_TABLE(COALESCE(j.criteria, JSON_ARRAY()), '$[*]' COLUMNS (
       criterion VARCHAR(50) PATH '$.id', status VARCHAR(20) PATH '$.status',
       criterion_text TEXT PATH '$.text', evidence TEXT PATH '$.evidence')) c;

-- Claims the diff does not support.
CREATE OR REPLACE VIEW v_hallucinations AS
SELECT r.ticket_key, j.run_id, h.claim, h.location, h.why
FROM judgements j JOIN runs r ON r.id = j.run_id,
     JSON_TABLE(COALESCE(j.hallucinations, JSON_ARRAY()), '$[*]' COLUMNS (
       claim TEXT PATH '$.claim', location VARCHAR(40) PATH '$.where', why TEXT PATH '$.why')) h;

-- Suggested prompt fixes: input for improving agents/*.md. Most-mentioned agent first.
CREATE OR REPLACE VIEW v_prompt_suggestions AS
SELECT s.agent, s.problem, s.suggestion, r.ticket_key, j.run_id,
       COUNT(*) OVER (PARTITION BY s.agent) AS mentions
FROM judgements j JOIN runs r ON r.id = j.run_id,
     JSON_TABLE(COALESCE(j.prompt_suggestions, JSON_ARRAY()), '$[*]' COLUMNS (
       agent VARCHAR(40) PATH '$.agent', problem TEXT PATH '$.problem', suggestion TEXT PATH '$.suggestion')) s;
