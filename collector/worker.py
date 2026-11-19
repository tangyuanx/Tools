"""Private newline-delimited JSON transport for the desktop main process."""
from __future__ import annotations

import argparse
import json
import queue
import sys
import threading
import time
from pathlib import Path

from service import Collector, configure_dpi


def write(message):
    # ensure_ascii keeps the pipe independent of the Windows console code page.
    print(json.dumps(message, ensure_ascii=True, separators=(',', ':')), flush=True)


def read_requests(requests):
    try:
        for line in sys.stdin.buffer:
            requests.put(line)
    finally:
        requests.put(None)


def run(config):
    configure_dpi()
    requests = queue.Queue()
    collector = Collector(config, lambda state: write({'state': state}))
    operations = {
        'state': lambda _: None,
        'bind': collector.bind,
        'retry': lambda _: collector.retry(),
        'start': lambda _: collector.start(),
        'stop': lambda _: collector.stop(),
        'output': collector.set_output,
    }
    next_poll = time.monotonic() + 0.3
    threading.Thread(target=read_requests, args=(requests,), daemon=True).start()
    collector.notify()
    try:
        while True:
            now = time.monotonic()
            if now >= next_poll:
                collector.poll()
                next_poll = now + 0.3
            try:
                line = requests.get(timeout=max(0, next_poll - time.monotonic()))
            except queue.Empty:
                continue
            if line is None:
                return
            request_id = None
            try:
                request = json.loads(line)
                request_id = request['id']
                operations[request['operation']](request.get('value'))
                write({'id': request_id, 'ok': True, 'state': collector.snapshot()})
            except Exception as exc:
                write({'id': request_id, 'ok': False, 'error': str(exc)})
    finally:
        # EOF and the Electron parent closing flush all bytes within Stop's boundary.
        collector.stop()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, required=True)
    run(parser.parse_args().config)
