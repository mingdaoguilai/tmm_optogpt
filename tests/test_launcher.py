import io
import json
import socket
import unittest
from unittest.mock import patch

from app import WORKBENCH_VERSION
from app.__main__ import PROJECT_ROOT, _is_current_server, _select_port


class LauncherTests(unittest.TestCase):
    def test_reuse_requires_version_and_directory_match(self):
        health = {'application': 'TMM + OptoGPT Workbench', 'version': WORKBENCH_VERSION,
                  'project_root': str(PROJECT_ROOT)}
        for change, expected in [({}, True), ({'version': '0.2.0'}, False),
                                 ({'project_root': str(PROJECT_ROOT / 'other')}, False)]:
            payload = json.dumps({**health, **change}).encode()
            with patch('app.__main__.urlopen', return_value=io.BytesIO(payload)):
                self.assertEqual(_is_current_server('http://127.0.0.1:8000'), expected)

    def test_old_server_uses_another_port_but_current_server_reuses(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
            occupied.bind(('127.0.0.1', 0))
            occupied.listen()
            port = occupied.getsockname()[1]
            if port > 65515:
                self.skipTest('Ephemeral port is too close to the maximum')
            with patch('app.__main__._is_current_server', return_value=False):
                selected, existing = _select_port(port)
                self.assertGreater(selected, port)
                self.assertFalse(existing)
            with patch('app.__main__._is_current_server', return_value=True):
                self.assertEqual(_select_port(port), (port, True))


if __name__ == '__main__':
    unittest.main()
