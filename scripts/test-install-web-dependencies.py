#!/usr/bin/env python3
"""Hermetic web dependency installer tests: no npm, apt, network or live config writes."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
INSTALLER = REPO / 'scripts/install-web-dependencies.sh'

STUB = '''import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['CALL_LOG'], 'a') as f:
    f.write(json.dumps({'name': name, 'args': args, 'cwd': os.getcwd(),
                       'headers': os.environ.get('npm_package_config_node_gyp_nodedir')}) + '\\n')
step = name
if name == 'node':
    step = 'platform' if args == ['-p', 'process.platform'] else 'probe'
    if step == 'platform':
        print(os.environ['TEST_PLATFORM'])
    else:
        assert args == ['--input-type=module', '-']
        assert 'await sharp(image).metadata()' in sys.stdin.read()
elif name == 'npm':
    step = args[0]
if os.environ.get('FAIL_STEP') == step:
    sys.exit(42)
if name == 'pkg-config':
    print('8.18.7')
'''


class WebInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='web-install-test-')
        self.addCleanup(self.temp.cleanup)
        # macOS exposes /var via /private/var; compare physical cwd paths.
        self.root = Path(self.temp.name).resolve()
        self.web = self.root / 'web with spaces $(touch INJECTED) `touch ALSO_INJECTED`'
        self.web.mkdir()
        self.prefix = self.root / 'termux prefix'
        headers = self.prefix / 'include/node'
        headers.mkdir(parents=True)
        (headers / 'common.gypi').write_text('{}')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name in ['node', 'npm', 'apt-get', 'pkg-config']:
            p = self.bin / name
            # Termux has no /usr/bin/env; do not rely on its ambient LD_PRELOAD shim.
            p.write_text(f'#!{sys.executable}\n' + STUB)
            p.chmod(0o755)
        self.log = self.root / 'calls.jsonl'
        self.env = {
            'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
            'HOME': str(self.root), 'PREFIX': str(self.prefix),
            'CALL_LOG': str(self.log), 'TEST_PLATFORM': 'android',
        }

    def run_installer(self, **changes):
        env = {**self.env, **changes}
        result = subprocess.run([shutil.which('bash'), str(INSTALLER), str(self.web)],
                                env=env, cwd=self.root, capture_output=True, text=True)
        self.assertTrue(self.log.exists(), result.stderr)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        return result, calls

    def test_android_packages_rebuild_headers_and_probe(self):
        result, calls = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([(c['name'], c['args']) for c in calls], [
            ('node', ['-p', 'process.platform']),
            ('apt-get', ['install', '-y', '--no-upgrade', 'libvips', 'clang', 'make', 'python', 'pkg-config']),
            ('pkg-config', ['--modversion', 'vips-cpp']),
            ('npm', ['install', '--omit=dev']),
            ('npm', ['rebuild', 'sharp', '--foreground-scripts']),
            ('node', ['--input-type=module', '-']),
        ])
        self.assertTrue(all(c['cwd'] == str(self.web) for c in calls))
        self.assertTrue(all(c['headers'] == str(self.prefix) for c in calls[3:]))
        self.assertFalse((self.web / 'INJECTED').exists())
        self.assertFalse((self.web / 'ALSO_INJECTED').exists())

    def test_non_android_keeps_normal_npm_install(self):
        for platform in ['linux', 'darwin']:
            with self.subTest(platform=platform):
                self.log.write_text('')
                result, calls = self.run_installer(TEST_PLATFORM=platform, PREFIX='')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual([c['name'] for c in calls], ['node', 'npm', 'node'])
                self.assertEqual(calls[1]['args'], ['install', '--omit=dev'])
                self.assertTrue(all(c['headers'] is None for c in calls))

    def test_missing_android_prefix_fails_before_package_changes(self):
        result, calls = self.run_installer(PREFIX='')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Termux PREFIX is required', result.stderr)
        self.assertEqual(len(calls), 1)

    def test_missing_android_headers_fails_before_package_changes(self):
        (self.prefix / 'include/node/common.gypi').unlink()
        result, calls = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Missing Termux Node headers', result.stderr)
        self.assertEqual(len(calls), 1)

    def test_each_failure_stops_installation(self):
        for step, count in [('platform', 1), ('apt-get', 2), ('pkg-config', 3),
                            ('install', 4), ('rebuild', 5), ('probe', 6)]:
            with self.subTest(step=step):
                self.log.write_text('')
                result, calls = self.run_installer(FAIL_STEP=step)
                self.assertEqual(result.returncode, 42)
                self.assertEqual(len(calls), count)

    def test_normal_installer_routes_only_web_to_helper(self):
        installer = (REPO / 'scripts/install-pi.sh').read_text()
        self.assertIn('''if [ "$ext_name" = web ]; then
                bash "$SCRIPT_DIR/install-web-dependencies.sh" "$ext_dir"
            else
                (cd "$ext_dir" && npm install --omit=dev)
            fi''', installer)

    def test_build_dependencies_are_production_and_locked(self):
        manifest = json.loads((REPO / 'extensions/web/package.json').read_text())
        lock = json.loads((REPO / 'extensions/web/package-lock.json').read_text())
        self.assertEqual(manifest['dependencies']['node-addon-api'], '7.1.1')
        for dep in ['node-addon-api', 'node-gyp']:
            self.assertEqual(manifest['dependencies'][dep], lock['packages']['']['dependencies'][dep])
            self.assertFalse(lock['packages']['node_modules/' + dep].get('dev', False))


if __name__ == '__main__':
    unittest.main()
