-- Write one run into MySQL. The Python caller sets @doc (the run as JSON) before this file.
-- Missing JSON keys become NULL. Re-running replaces the run.
SET time_zone = '+00:00';
START TRANSACTION;

INSERT INTO tickets (ticket_key, title, description, last_run_at)
SELECT * FROM (SELECT j->>'$.ticket' AS k, j->>'$.title' AS t, j->>'$.description' AS d,
                      FROM_UNIXTIME(j->>'$.started_at') AS l
               FROM (SELECT CAST(@doc AS JSON) AS j) x) AS new
ON DUPLICATE KEY UPDATE title = new.t, description = new.d, last_run_at = new.l;

DELETE FROM runs WHERE id = JSON_UNQUOTE(JSON_EXTRACT(@doc, '$.run_id'));

INSERT INTO runs (id, ticket_key, started_at, ended_at, status, failure, pr_url, pr_title, pr_body, review_rounds,
                  final_verdict, judge_score, files_changed, lines_added, lines_deleted, spec, plan, tests)
SELECT j->>'$.run_id', j->>'$.ticket', FROM_UNIXTIME(j->>'$.started_at'), FROM_UNIXTIME(j->>'$.ended_at'),
       j->>'$.status', j->>'$.failure', j->>'$.pr_url', j->>'$.pr_title', j->>'$.pr_body', j->>'$.review_rounds',
       j->>'$.final_verdict', j->>'$.judge.score', j->>'$.files_changed', j->>'$.lines_added',
       j->>'$.lines_deleted', j->>'$.spec', j->>'$.plan', j->>'$.tests'
FROM (SELECT CAST(@doc AS JSON) AS j) x;

INSERT INTO agent_steps (run_id, seq, agent, round_no, cli, model, started_at, ended_at, duration_s, exit_code, ok,
                         router_skipped, skills, prompt, output)
SELECT x.j->>'$.run_id', s.seq, s.agent, s.round_no, s.cli, s.model, FROM_UNIXTIME(s.t0), FROM_UNIXTIME(s.t1),
       s.t1 - s.t0, s.exit_code, s.exit_code = 0, s.router_skipped, s.skills, s.prompt, s.output
FROM (SELECT CAST(@doc AS JSON) AS j) x,
     JSON_TABLE(x.j, '$.steps[*]' COLUMNS (
       seq INT PATH '$.seq', agent VARCHAR(40) PATH '$.agent', round_no INT PATH '$.round',
       cli VARCHAR(40) PATH '$.cli', model VARCHAR(200) PATH '$.model',
       t0 BIGINT PATH '$.started_at', t1 BIGINT PATH '$.ended_at', exit_code INT PATH '$.exit_code',
       router_skipped TEXT PATH '$.router_skipped', skills TEXT PATH '$.skills',
       prompt LONGTEXT PATH '$.prompt', output LONGTEXT PATH '$.output')) s;

INSERT INTO reviews (run_id, round_no, verdict, body)
SELECT x.j->>'$.run_id', r.round_no, r.verdict, r.body
FROM (SELECT CAST(@doc AS JSON) AS j) x,
     JSON_TABLE(x.j, '$.reviews[*]' COLUMNS (
       round_no INT PATH '$.round', verdict VARCHAR(8) PATH '$.verdict', body LONGTEXT PATH '$.body')) r;

INSERT INTO judgements (run_id, score, summary, criteria, spec_gaps, hallucinations, out_of_scope, prompt_suggestions, raw)
SELECT j->>'$.run_id', j->>'$.judge.score', j->>'$.judge.summary', j->'$.judge.criteria', j->'$.judge.spec_gaps',
       j->'$.judge.hallucinations', j->'$.judge.out_of_scope', j->'$.judge.prompt_suggestions', j->'$.judge'
FROM (SELECT CAST(@doc AS JSON) AS j) x WHERE JSON_TYPE(j->'$.judge') = 'OBJECT';
COMMIT;
