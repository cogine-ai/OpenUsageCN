import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).with_name("macos-stapler-guard.py")
SPEC = importlib.util.spec_from_file_location("stapler_guard", SCRIPT)
GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUARD)

FAKE = r'''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys, time
root=pathlib.Path(__file__).parent
args=sys.argv[1:]
if args[:2] != ['stapler','staple'] and args[:2] != ['stapler','validate']:
    print(json.dumps(args))
    raise SystemExit(17)
phase=args[1]
state=root/(phase+'.count')
count=int(state.read_text())+1 if state.exists() else 1
state.write_text(str(count))
mode=(root/'mode').read_text()
if mode=='timeout':
    child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'])
    (root/'pids').write_text(str(os.getpid())+' '+str(child.pid))
    print('stapler started',flush=True)
    time.sleep(30)
if phase=='staple':
    if mode=='retry' and count==1:
        print('CloudKit connection lost',file=sys.stderr)
        raise SystemExit(68)
    print('staple completed')
else:
    if mode=='validate-fails' or (mode=='validate-retry' and count==1):
        print('No ticket stapled',file=sys.stderr)
        raise SystemExit(65)
    print('The validate action worked!')
'''


@unittest.skipUnless(os.name == "posix", "macOS xcrun wrapper uses POSIX process groups")
class StaplerGuardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.fake = self.root / "xcrun"
        self.fake.write_text(FAKE)
        self.fake.chmod(0o700)
        self.log = self.root / "stapler.jsonl"
        (self.root / "mode").write_text("success")

    def tearDown(self):
        self.temporary.cleanup()

    def run_guard(self, mode="success"):
        (self.root / "mode").write_text(mode)
        return GUARD.guard_staple(
            ["stapler", "staple", "-v", "Synthetic.app"], str(self.fake), self.log,
            process_timeout=2, total_timeout=10, initial_backoff=0,
        )

    def events(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_nonzero_staple_retries_then_validates(self):
        self.assertEqual(self.run_guard("retry"), 0)
        events = self.events()
        self.assertEqual([e["returncode"] for e in events if e["phase"] == "staple"], [68, 0])
        self.assertTrue(events[-1]["validated"])
        self.assertEqual(GUARD.verify_log(self.log, "Synthetic.app"), 0)

    def test_successful_staple_without_ticket_is_retried(self):
        self.assertEqual(self.run_guard("validate-retry"), 0)
        events = self.events()
        self.assertEqual([e["returncode"] for e in events if e["phase"] == "validate"], [65, 0])
        self.assertEqual(GUARD.verify_log(self.log, "Synthetic.app"), 0)

    def test_all_validate_failures_are_terminal_and_rejected_by_ci(self):
        self.assertEqual(self.run_guard("validate-fails"), 1)
        events = self.events()
        self.assertEqual(len([e for e in events if e["phase"] == "staple"]), 5)
        self.assertFalse(events[-1]["validated"])
        self.assertEqual(GUARD.verify_log(self.log, "Synthetic.app"), 1)
        # A later successful invocation must not hide the failed group.
        self.assertEqual(self.run_guard("success"), 0)
        self.assertEqual(GUARD.verify_log(self.log, "Synthetic.app"), 1)

    def test_timeout_kills_group_and_reaps_the_direct_process(self):
        (self.root / "mode").write_text("timeout")
        started = time.monotonic()
        self.assertEqual(GUARD.guard_staple(
            ["stapler", "staple", "Synthetic.app"], str(self.fake), self.log,
            process_timeout=1.0, total_timeout=1.25, initial_backoff=0.3,
        ), 1)
        self.assertLess(time.monotonic()-started, 5)
        self.assertTrue(any(e.get("timedOut") for e in self.events()))
        pid, child = map(int, (self.root / "pids").read_text().split())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        # The grandchild can briefly remain a zombie while its new parent reaps it.
        result = subprocess.run(["ps", "-o", "stat=", "-p", str(child)], capture_output=True, text=True)
        self.assertTrue(not result.stdout.strip() or result.stdout.strip().startswith("Z"))

    def test_nonstapler_preserves_argv_and_exit_status_without_a_log(self):
        args = ["notarytool", "submit", "file with spaces.zip", "--password", "synthetic-secret"]
        env = {**os.environ, "OPENUSAGE_REAL_XCRUN": str(self.fake), "OPENUSAGE_STAPLER_LOG": str(self.log)}
        result = subprocess.run([sys.executable, str(SCRIPT), *args], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 17)
        self.assertEqual(json.loads(result.stdout), args)
        self.assertFalse(self.log.exists())

    def test_verify_rejects_any_group_targeting_a_different_app(self):
        self.assertEqual(self.run_guard(), 0)
        self.assertEqual(GUARD.verify_log(self.log, "Different.app"), 1)
        # A passing group for the expected app cannot hide another application's group.
        events = self.events()
        other = [{**event, "group": "other-group", "target": "Different.app"} for event in events]
        with self.log.open("a") as log:
            log.write("\n".join(json.dumps(event) for event in other)+"\n")
        self.assertEqual(GUARD.verify_log(self.log, "Synthetic.app"), 1)

    def test_verify_compares_canonical_paths_without_requiring_app_to_exist(self):
        self.assertEqual(self.run_guard(), 0)
        self.assertEqual(GUARD.verify_log(self.log, Path.cwd() / "unused" / ".." / "Synthetic.app"), 0)

    def test_verify_entrypoint_rejects_missing_incomplete_and_nonapp_logs(self):
        self.assertEqual(GUARD.verify_log(self.log, "Synthetic.app"), 1)
        self.assertEqual(self.run_guard(), 0)
        events = self.events()
        self.log.write_text(json.dumps(events[0])+"\n")
        self.assertEqual(GUARD.verify_log(self.log, "Synthetic.app"), 1)
        self.log.write_text("\n".join(json.dumps({**e,"target":"Synthetic.dmg"}) for e in events)+"\n")
        self.assertEqual(GUARD.verify_log(self.log, "Synthetic.app"), 1)
        self.log.write_text("\n".join(json.dumps(e) for e in events)+"\n")
        result = subprocess.run([sys.executable, str(SCRIPT), "--verify-log", str(self.log), "--expected-app", "Synthetic.app"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
