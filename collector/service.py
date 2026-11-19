"""Log Collector workflow exposed independently of its original Qt window."""
from __future__ import annotations

import ctypes
import json
import os
import time
from ctypes import wintypes
from pathlib import Path

from capture import FileCapture
from session import bind_handle, discover_logs, validate


def configure_dpi():
    if os.name != 'nt':
        return
    user = ctypes.WinDLL('user32', use_last_error=True)
    set_context = getattr(user, 'SetProcessDpiAwarenessContext', None)
    if set_context is not None:
        set_context.argtypes = [ctypes.c_void_p]
        set_context.restype = wintypes.BOOL
        if set_context(ctypes.c_void_p(-4)):  # Per-monitor aware v2, matching Electron.
            return
    user.SetProcessDPIAware()


def read_settings(file):
    try:
        value = json.loads(file.read_text(encoding='utf-8'))
        if isinstance(value, dict):
            return value
    except (OSError, ValueError):
        pass
    return {}


class Collector:
    def __init__(self, config, changed, *, bind=bind_handle, discover=discover_logs,
                 validate_session=validate, clock=time.monotonic):
        self.config = config
        self.changed = changed
        self.bind_handle = bind
        self.discover = discover
        self.validate = validate_session
        self.clock = clock
        self.capture = FileCapture()
        self.session = self.source = self.last_file = None
        self.begun_at = None
        self.seconds = 0
        self.stage = 'unbound'
        self.detail = ''
        self.busy = False
        self.retryable = False
        legacy = Path(os.environ.get('APPDATA', Path.home())) / 'LogCollector' / 'config.json'
        fallback = read_settings(legacy).get('output') if os.name == 'nt' else None
        output = read_settings(config).get('output') or fallback
        self.output = Path(output) if isinstance(output, str) and output else Path.home() / 'Documents' / 'LogCollector'

    def snapshot(self):
        return {
            'stage': self.stage,
            'detail': self.detail,
            'busy': self.busy,
            'retryable': self.retryable,
            'active': self.capture.active,
            'canStart': self.session is not None and self.source is not None and not self.busy,
            'session': self.session.title if self.session is not None else None,
            'output': str(self.output),
            'lastFile': str(self.last_file) if self.last_file is not None else None,
            'lineCount': self.capture.line_count,
            'byteCount': self.capture.count,
            'elapsedSeconds': self.seconds,
        }

    def notify(self):
        self.changed(self.snapshot())

    def require_idle(self):
        if self.capture.active or self.busy:
            raise RuntimeError('请先停止采集或等待当前操作完成。')

    def bind(self, hit):
        self.require_idle()
        self.detail = '正在识别会话…'
        self.busy = True
        self.notify()
        try:
            # The Electron main process records the hit at mouse release.
            point = wintypes.POINT(hit['x'], hit['y'])
            session = self.bind_handle(int(hit['handle']), point)
        except Exception as exc:
            # Keep the previous successful binding if the new drop is invalid.
            self.detail = str(exc)
            self.busy = False
            self.notify()
            return
        self.session = session
        self.discover_for(start=False)

    def retry(self):
        self.require_idle()
        if self.session is not None:
            self.discover_for(start=False)

    def start(self):
        self.require_idle()
        if self.session is None or self.source is None:
            raise RuntimeError('请先绑定已开启日志的 MobaXterm 会话。')
        self.discover_for(start=True)

    def discover_for(self, *, start):
        self.source = None
        self.busy = True
        self.detail = '正在确认会话…' if start else '正在识别日志…'
        self.notify()
        try:
            source = self.discover(self.session)
        except Exception as exc:
            self.stage = 'waiting'
            self.detail = str(exc)
            self.retryable = True
        else:
            self.source = source
            if start:
                self.begin()
            else:
                self.stage = 'ready'
                self.detail = ''
                self.retryable = False
        finally:
            self.busy = False
            self.notify()

    def begin(self):
        try:
            self.validate(self.session)
            self.capture.start(self.source, self.output, self.session.title)
            self.validate(self.session)
        except Exception as exc:
            self.capture.abort()
            self.stage = 'start-error'
            self.detail = '无法开始采集：' + str(exc)
            return
        self.begun_at = self.clock()
        self.last_file = None
        self.retryable = False
        self.refresh_activity()

    def refresh_activity(self):
        self.seconds = max(0, int(self.clock() - self.begun_at))
        self.stage = 'running'
        stamp = self.capture.last_write_at
        if stamp is None:
            self.detail = '等待日志写入'
        else:
            tail = ' · 末行写入中' if self.capture.lines.pending else ''
            self.detail = f'最近写入 {stamp:%H:%M:%S}' + tail

    def poll(self):
        if not self.capture.active:
            return
        try:
            self.validate(self.session)
            self.capture.poll()
        except Exception as exc:
            self.stop(str(exc))
        else:
            self.refresh_activity()
            self.notify()

    def stop(self, reason=''):
        if not self.capture.active:
            return
        target = self.capture.target
        try:
            self.capture.stop()
        except Exception as exc:
            reason = '；'.join(part for part in (reason, str(exc)) if part)
            self.capture.abort()
        self.last_file = target
        self.seconds = max(0, int(self.clock() - self.begun_at))
        self.stage = 'stopped' if reason else 'saved'
        if reason:
            self.source = None
        self.retryable = bool(reason)
        self.detail = reason
        self.notify()

    def set_output(self, output):
        self.require_idle()
        if not isinstance(output, str) or not output:
            raise ValueError('日志目录无效。')
        next_output = Path(output)
        self.config.parent.mkdir(parents=True, exist_ok=True)
        pending = self.config.with_suffix('.tmp')
        try:
            pending.write_text(json.dumps({'output': str(next_output)}, ensure_ascii=False), encoding='utf-8')
            pending.replace(self.config)
        finally:
            pending.unlink(missing_ok=True)
        self.output = next_output
        self.notify()
