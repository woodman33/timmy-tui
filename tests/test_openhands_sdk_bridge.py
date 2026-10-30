"""Offline bridge regression: fake SDK conversation, real disposable git/checks."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'openhands_bridge', Path(__file__).resolve().parents[1] / 'scripts/openhands-sdk-bridge.py'
)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class FakeConversation:
    def __init__(self, callback=lambda _: None):
        self.callback = callback
        self.messages = []
        self.budgets = []
        self.max_iteration_per_run = 0
        self.closed = False

    def send_message(self, message):
        self.messages.append(message)

    def run(self):
        self.budgets.append(self.max_iteration_per_run)
        self.callback(len(self.budgets))

    def close(self):
        self.closed = True


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='timmy-bridge-test-')
        self.root = Path(self.tmp.name)
        self.work = self.root / 'work'
        self.work.mkdir()
        self.git('init', '-q')
        (self.work / 'result.txt').write_text('red')
        self.git('add', 'result.txt')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'fixture')
        self.req = {
            'task': 'Fix the result file', 'workspace': str(self.work),
            'pristine_dir': str(self.root / 'pristine'),
            'acceptance': ["test \"$(cat result.txt)\" = green"],
            'max_iterations': 4, 'acceptance_timeout_s': 2,
        }

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.work), *args],
                              capture_output=True, text=True, check=True)

    def run_fake(self, conversation):
        def factory(workspace, budget):
            self.assertEqual(workspace, str(self.work))
            conversation.max_iteration_per_run = budget
            return conversation
        with patch.object(bridge, 'create_conversation', side_effect=factory):
            return bridge.run_bridge(self.req)

    def test_red_checks_never_report_success(self):
        conv = FakeConversation()
        result = self.run_fake(conv)
        self.assertFalse(result['ok'])
        self.assertEqual(result['work_acceptance'][0]['code'], 1)
        self.assertEqual(result['pristine_acceptance'][0]['code'], 1)
        self.assertTrue(conv.closed)
        self.assertEqual(conv.budgets, [3, 1])
        self.assertIn(json.dumps(self.req['acceptance'][0]), conv.messages[1])
        self.assertNotIn('/work/add.js', conv.messages[1])

    def test_one_correction_uses_the_actual_task(self):
        def fix_on_second_run(number):
            if number == 2:
                (self.work / 'result.txt').write_text('green')
        conv = FakeConversation(fix_on_second_run)
        result = self.run_fake(conv)
        self.assertTrue(result['ok'], result)
        self.assertTrue(result['patch_applied'])
        self.assertEqual(conv.budgets, [3, 1])
        self.assertEqual(result['pristine_acceptance'][0]['code'], 0)

    def test_agent_commit_is_diffed_against_original_source(self):
        def commit_edit(_):
            (self.work / 'result.txt').write_text('green')
            self.git('add', 'result.txt')
            self.git('-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'agent edit')
        result = self.run_fake(FakeConversation(commit_edit))
        self.assertTrue(result['ok'], result)
        self.assertIn('+green', result['patch'])
        self.assertEqual((self.root / 'pristine/result.txt').read_text(), 'green')

    def test_working_success_cannot_hide_pristine_failure(self):
        self.req['acceptance'] = ['test -f untracked.txt']
        result = self.run_fake(FakeConversation(
            lambda _: (self.work / 'untracked.txt').write_text('only in workspace')
        ))
        self.assertEqual(result['work_acceptance'][0]['code'], 0)
        self.assertEqual(result['pristine_acceptance'][0]['code'], 1)
        self.assertFalse(result['ok'])

    def test_single_iteration_has_no_retry(self):
        self.req['max_iterations'] = 1
        conv = FakeConversation()
        self.assertFalse(self.run_fake(conv)['ok'])
        self.assertEqual(conv.budgets, [1])

    def test_empty_checks_refused_before_sdk(self):
        self.req['acceptance'] = []
        with patch.object(bridge, 'create_conversation') as factory:
            result = bridge.run_bridge(self.req)
        self.assertFalse(result['ok'])
        factory.assert_not_called()

    def test_acceptance_timeout_is_reported(self):
        checks = bridge.acceptance(['sleep 10'], str(self.work), 0.05)
        self.assertEqual(checks, [{'cmd': 'sleep 10', 'code': 124, 'timed_out': True}])

    def test_limit_validation_and_clamp(self):
        self.assertEqual(bridge.bounded_int(999, 4, 16), 16)
        for value in [0, -1, True, '4', 1.5]:
            with self.assertRaises(ValueError):
                bridge.bounded_int(value, 4, 16)


if __name__ == '__main__':
    unittest.main()
