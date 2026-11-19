import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from service import Collector


class CollectorServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.log = root / '会话.log'
        self.log.write_bytes(b'old\r\n')
        self.destination = root / '采集'
        self.config = root / 'collector.json'
        self.session = SimpleNamespace(title='串口')
        self.bind = Mock(return_value=self.session)
        self.find = Mock(return_value=self.log)
        self.verify = Mock()
        self.states = []
        self.seconds = 10
        self.collector = Collector(self.config, self.states.append, bind=self.bind,
                                   discover=self.find, validate_session=self.verify, clock=lambda: self.seconds)
        self.addCleanup(self.collector.stop)
        self.collector.set_output(str(self.destination))

    def add(self, data):
        with self.log.open('ab') as stream:
            stream.write(data)

    def bind_session(self):
        self.collector.bind({'x': -32, 'y': 18, 'handle': '1055'})
        self.assertEqual(self.states[-1]['stage'], 'ready')
        self.assertEqual(self.bind.call_args.args[0], 1055)
        self.assertEqual(self.bind.call_args.args[1].x, -32)

    def test_discover_validates_and_saves_only_new_bytes(self):
        self.bind_session()
        self.collector.start()
        self.add('设备'.encode())
        self.seconds += 3
        self.collector.poll()
        self.assertEqual(self.states[-1]['lineCount'], 1)
        self.assertEqual(self.states[-1]['elapsedSeconds'], 3)
        self.assertIn('末行写入中', self.states[-1]['detail'])
        self.add(b'\r')
        self.collector.poll()
        self.add(b'\nlast\n')
        self.collector.stop()
        final = self.states[-1]
        self.assertEqual(final['stage'], 'saved')
        self.assertEqual(final['lineCount'], 2)
        self.assertTrue(final['canStart'])
        self.assertEqual(Path(final['lastFile']).read_bytes(), '设备\r\nlast\n'.encode())
        self.assertEqual(self.find.call_count, 2)
        self.assertGreaterEqual(self.verify.call_count, 4)

    def test_lost_target_finalizes_available_bytes_and_requires_identification(self):
        self.bind_session()
        self.collector.start()
        self.add(b'line\n')
        self.verify.side_effect = RuntimeError('目标已关闭')
        self.collector.poll()
        final = self.states[-1]
        self.assertEqual(final['stage'], 'stopped')
        self.assertEqual(final['detail'], '目标已关闭')
        self.assertTrue(final['retryable'])
        self.assertFalse(final['canStart'])
        self.assertEqual(Path(final['lastFile']).read_bytes(), b'line\n')

    def test_ambiguous_log_and_invalid_drop_remain_unstartable(self):
        self.find.side_effect = RuntimeError('多个日志')
        self.collector.bind({'x': 9, 'y': 10, 'handle': '101'})
        self.assertTrue(self.states[-1]['retryable'])
        self.assertFalse(self.states[-1]['canStart'])
        self.bind.side_effect = RuntimeError('无效目标')
        self.collector.bind({'x': 9, 'y': 10, 'handle': '0'})
        self.assertEqual(self.states[-1]['session'], self.session.title)
        self.assertFalse(self.states[-1]['canStart'])
        self.find.side_effect = None
        self.collector.retry()
        self.assertTrue(self.states[-1]['canStart'])

    def test_destination_is_persisted_but_cannot_change_during_capture(self):
        self.bind_session()
        self.collector.start()
        with self.assertRaisesRegex(RuntimeError, '停止采集'):
            self.collector.set_output(str(self.destination / 'other'))
        self.assertEqual(Collector(self.config, lambda _: None).snapshot()['output'], str(self.destination))
        self.assertIsNone(Collector(self.config, lambda _: None).snapshot()['session'])
