#!/usr/bin/env python3
"""Hermetic installer regression tests: no npm, network, or live Pi config."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("install-pi-extensions.sh")
FORK = "git:github.com/lukastk/pi-mcp-adapter@myagent-codemode"
FAKE_PI = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args=sys.argv[1:]
with Path(os.environ['CALLS']).open('a') as f: f.write(json.dumps(args)+'\n')
if args[0] == 'list':
    print('Installed packages:')
    for source in json.loads(os.environ['INSTALLED']):
        print('  '+source)
        print('    /not/a/real/install')
if args[0] == os.environ.get('FAIL_COMMAND'): sys.exit(17)
'''

class InstallExtensionsTest(unittest.TestCase):
    def run_installer(self, sources, installed=(), fail=""):
        with tempfile.TemporaryDirectory(prefix="pi install ' $() ") as tmp:
            root = Path(tmp)
            (root / "pi").write_text(FAKE_PI)
            (root / "pi").chmod(0o755)
            source_list = root / "sources"
            source_list.write_text("\n".join(sources))  # deliberately no final newline
            log = root / "calls"
            env = dict(os.environ, PATH=str(root)+os.pathsep+os.environ['PATH'],
                       HOME=str(root), CALLS=str(log), INSTALLED=json.dumps(installed), FAIL_COMMAND=fail)
            proc = subprocess.run(["bash", str(SCRIPT), str(source_list)], env=env, capture_output=True, text=True)
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            return proc, calls

    def test_updates_only_declared_sources_and_preserves_pins_and_arguments(self):
        sources = ["npm:example", "", "npm:pinned@1.2.3", "git:github.com/me/repo@work", "./local with spaces;$(false)"]
        result, calls = self.run_installer(sources, ["npm:unrelated"])
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = [[verb, '--no-approve', source] for source in sources if source for verb in ['install', 'update']]
        self.assertEqual(calls, expected)

    def test_fork_replaces_both_pinned_and_unpinned_upstream_after_success(self):
        result, calls = self.run_installer([FORK], ['npm:pi-mcp-adapter', 'npm:pi-mcp-adapter@2.38.0', 'npm:unrelated'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [['install', '--no-approve', FORK], ['update', '--no-approve', FORK], ['list', '--no-approve'],
                                ['remove', '--no-approve', 'npm:pi-mcp-adapter'], ['remove', '--no-approve', 'npm:pi-mcp-adapter@2.38.0']])

    def test_install_failure_stops_before_update_or_removal(self):
        result, calls = self.run_installer([FORK, 'npm:later'], ['npm:pi-mcp-adapter'], 'install')
        self.assertEqual(result.returncode, 17)
        self.assertEqual(calls, [['install', '--no-approve', FORK]])

    def test_update_failure_is_loud_and_keeps_old_adapter(self):
        result, calls = self.run_installer([FORK, 'npm:later'], ['npm:pi-mcp-adapter'], 'update')
        self.assertEqual(result.returncode, 17)
        self.assertEqual(calls, [['install', '--no-approve', FORK], ['update', '--no-approve', FORK]])

    def test_removal_failure_is_loud(self):
        result, _ = self.run_installer([FORK], ['npm:pi-mcp-adapter'], 'remove')
        self.assertEqual(result.returncode, 17)

    def test_no_sources_does_not_run_pi(self):
        result, calls = self.run_installer([])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(calls, [])

    def test_pi_configuration_has_one_mcp_owner_and_native_codemode(self):
        repo = SCRIPT.parent.parent
        settings = json.loads((repo / 'pi_settings.json').read_text())
        config = json.loads((repo / 'mcp.json').read_text())
        self.assertIn('-builtin:mcp', settings['extensions'])
        self.assertIn('+codemode', settings['defaultTools'])
        self.assertTrue(config['settings']['deferWithMissingMetadata'])
        self.assertFalse(config['settings']['scriptMode'])
        for name, server in config['mcpServers'].items():
            with self.subTest(server=name):
                self.assertEqual(server['directTools'], 'search')
                self.assertEqual(server['lifecycle'], 'lazy')

if __name__ == '__main__': unittest.main()
