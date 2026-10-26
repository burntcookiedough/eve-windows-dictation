"""Disposable process/port/file fixture; never imports the dictation backend."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
if len(sys.argv) > 2 and sys.argv[2] == 'relay':
    subprocess.Popen([sys.executable, __file__, str(root / 'leaf')])
with (root / 'held.txt').open('w') as held, socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    listener.listen()
    held.write('synthetic smoke fixture')
    held.flush()
    record = {'pid': os.getpid(), 'parent': os.getppid(), 'port': listener.getsockname()[1]}
    (root / 'ready.tmp').write_text(json.dumps(record), encoding='utf-8')
    (root / 'ready.tmp').replace(root / 'ready.json')
    # Also expire if the outer test harness is terminated before its finally.
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        time.sleep(0.25)
    (root / 'expired.txt').write_text('fixture TTL expired', encoding='utf-8')
