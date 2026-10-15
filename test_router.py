"""python3 -m unittest test_router"""
import json, os, tempfile, unittest
from pathlib import Path
from unittest import mock
import router

CFG = {
    "clis": {
        "a": {"command": "true run {model}", "auth": [".a/auth.json"]},
        "b": {"command": "true go {model}", "env": ["B_KEY"]},
        "c": {"command": "true c {model}", "quota": "codex"},
        "gone": {"command": "no-such-binary-xyz {model}"},
    },
    "lanes": {"spec": ["a:strong-1", "b:weak-1"], "code": ["a:cheap-1", "b:mid-1", "a:top-1"],
              "review": ["a:rev-1", "b:rev-2"]},
    "aliases": {"fix": "code", "plan": "spec"},
    "pinned": ["spec", "plan"],
    "gates": {"codex": {"5h_max": 70, "7d_max": 85}},
}


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.home = Path(tempfile.mkdtemp())
        (self.home / ".a").mkdir(); (self.home / ".a" / "auth.json").write_text("{}")
        self.write(CFG)
        for target, value in [("CONFIG", self.dir / "router.json"), ("AUTH_HOME", self.home)]:
            mock.patch.object(router, target, value).start()
        mock.patch.dict(os.environ, {"B_KEY": "x"}).start()
        mock.patch.object(router, "jev_answers", return_value=None).start()
        self.addCleanup(mock.patch.stopall)

    def write(self, cfg):
        (self.dir / "router.json").write_text(json.dumps(cfg))

    def pick(self, lane, answers=None):
        with mock.patch.object(router, "jev_answers", return_value=answers):
            return router.route(lane, self.dir)


class Routing(Base):
    def test_cheapest_first_without_jev(self):
        self.assertEqual(self.pick("code")[:2], ("a:cheap-1", "true run cheap-1"))

    def test_hard_ticket_skips_cheap_models(self):
        self.assertEqual(self.pick("code", {"complexity": {"score": 3, "confidence": 0.9}})[0], "a:top-1")

    def test_pinned_agent_ignores_jev(self):
        self.assertEqual(self.pick("plan", {"complexity": {"score": 4, "confidence": 0.9}})[0], "a:strong-1")

    def test_alias_and_failed_model_excluded(self):
        (self.dir / "excluded.txt").write_text("a:cheap-1\n")
        self.assertEqual(self.pick("fix")[0], "b:mid-1")

    def test_review_avoids_builder_family(self):
        (self.dir / "build_family.txt").write_text("rev")
        with self.assertRaises(SystemExit):  # every review model is family "rev"
            self.pick("review")

    def test_reports_login_files_and_keys_for_the_sandbox(self):
        self.assertEqual(self.pick("code")[3:], (".a/auth.json", ""))


class Logins(Base):
    def test_login_file_key_or_missing(self):
        self.assertIsNone(router.login_state(CFG["clis"]["a"]))          # login file under AUTH_HOME
        self.assertIsNone(router.login_state(CFG["clis"]["b"]))          # API key in the environment
        self.assertIn("not installed", router.login_state(CFG["clis"]["gone"]))

    def test_hung_login_check_skips_the_cli(self):
        with mock.patch.object(router.subprocess, "run", side_effect=router.subprocess.TimeoutExpired("x", 30)):
            self.assertIn("timed out", router.login_state({"command": "true {model}", "check": "sleep 99"}))

    def test_not_logged_in_cli_is_skipped(self):
        with mock.patch.dict(os.environ, {"B_KEY": ""}):
            self.assertEqual(self.pick("spec", None)[0], "a:strong-1")
            (self.home / ".a" / "auth.json").unlink()
            with self.assertRaises(SystemExit):
                self.pick("spec")


class Quota(Base):
    GATE = {"5h_max": 70, "7d_max": 85}

    def codex(self, five, week=0, **extra):
        return {"rate_limit": {"allowed": True, "primary_window": {"used_percent": five},
                               "secondary_window": {"used_percent": week}}, **extra}

    def test_codex_gates(self):
        q = router.QUOTAS["codex"]
        self.assertIsNone(q.blocked("gpt-6-astra", self.codex(10, 20), self.GATE))
        self.assertIn("5h", q.blocked("gpt-6-astra", self.codex(70), self.GATE))
        self.assertIn("7d", q.blocked("gpt-6-astra", self.codex(0, 90), self.GATE))
        self.assertIn("unknown", q.blocked("gpt-6-astra", OSError("down"), self.GATE))
        self.assertIsNone(q.blocked("gpt-6-astra", None, self.GATE))   # API key only: metered, no gate

    def test_codex_single_model_unavailable(self):
        snap = self.codex(0, model_usage={"gpt-6-astra": {"available": False}})
        self.assertIn("unavailable", router.QUOTAS["codex"].blocked("openai-codex/gpt-6-astra", snap, self.GATE))
        self.assertIsNone(router.QUOTAS["codex"].blocked("gpt-6.1-sol", snap, self.GATE))

    def test_opencode_catalog(self):
        q = router.QUOTAS["opencode-go"]
        self.assertIn("catalog", q.blocked("opencode-go/old-1", {"glm-5.3"}, {}))
        self.assertIsNone(q.blocked("opencode-go/glm-5.3", {"glm-5.3"}, {}))
        self.assertIsNone(q.blocked("opencode-go/glm-5.3", OSError("down"), {}))  # flat rate: unknown passes

    def test_cursor_buckets(self):
        q, snap = router.QUOTAS["cursor"], {"planUsage": {"autoPercentUsed": 90, "apiPercentUsed": 10}, "autoBucketModels": ["auto-1"]}
        self.assertIn("auto", q.blocked("auto-1", snap, {"bucket_max": 85}))
        self.assertIsNone(q.blocked("sol-high", snap, {"bucket_max": 85}))

    def test_pi_maps_model_prefix_to_quota(self):
        self.assertEqual(router.quota_name({"quota": {"openai-codex/": "codex"}}, "openai-codex/x"), "codex")
        self.assertIsNone(router.quota_name({"quota": {"openai-codex/": "codex"}}, "anthropic/x"))

    def test_quota_skip_moves_route_to_next_model(self):
        cfg = dict(CFG, lanes={"spec": ["c:x-1", "a:y-1"]})
        self.write(cfg)
        with mock.patch.object(router, "probe", return_value={"codex": self.codex(95)}):
            self.assertEqual(self.pick("spec")[0], "a:y-1")


class SameModelRoutes(Base):
    """A list in a chain = the same model through different subscriptions: most quota left wins."""
    CFG = dict(CFG, clis=dict(CFG["clis"], codex={"command": "true c {model}", "quota": "codex", "check": "true"},
                              oc={"command": "true o {model}", "quota": "opencode-go", "check": "true"}),
               lanes={"code": [["oc:luna-1", "codex:luna-1"], "a:top-1"]},
               gates={"codex": {"5h_max": 70, "7d_max": 85}, "opencode-go": {"5h_budget": 10}})

    def setUp(self):
        super().setUp()
        self.write(self.CFG)
        mock.patch.object(router, "DECISIONS", self.dir / "decisions.jsonl").start()
        codex = {"rate_limit": {"allowed": True, "primary_window": {"used_percent": 14}, "secondary_window": {"used_percent": 11}}}
        mock.patch.object(router, "probe", return_value={"codex": codex, "opencode-go": {"luna-1"}}).start()

    def use_opencode(self, n):
        import time
        with (self.dir / "decisions.jsonl").open("a") as f:
            for _ in range(n):
                f.write(json.dumps({"t": int(time.time()), "quota": "opencode-go"}) + "\n")

    def test_fresh_subscription_wins(self):
        self.assertEqual(self.pick("code")[0], "oc:luna-1")          # 100% left vs codex 80%

    def test_switches_before_it_runs_out(self):
        self.use_opencode(9)                                            # 10% left
        self.assertEqual(self.pick("code")[0], "codex:luna-1")

    def test_budget_reached_blocks_the_route(self):
        self.use_opencode(10)
        self.assertIn("10 of 10", router.QUOTAS["opencode-go"].blocked("luna-1", {"luna-1"}, {"5h_budget": 10}))

    def test_decisions_are_logged_and_feed_the_meter(self):
        self.pick("code")
        line = json.loads((self.dir / "decisions.jsonl").read_text().splitlines()[-1])
        self.assertEqual((line["agent"], line["entry"], line["quota"]), ("code", "oc:luna-1", "opencode-go"))
        self.assertEqual(router.recent_calls("opencode-go"), 1)


class Redact(unittest.TestCase):
    def test_credentials_never_reach_jev(self):
        text = "token sk-ant-abc123456789 and ghp_abcdefghijkl and Bearer xyz.123 and pk_12345_ABCDEFGHIJKLMNOPQRSTUV"
        out = router.redact(text)
        for secret in ("sk-ant", "ghp_", "xyz.123", "pk_12345"):
            self.assertNotIn(secret, out)


if __name__ == "__main__":
    unittest.main()
