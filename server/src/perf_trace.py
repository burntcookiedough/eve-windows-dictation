"""Opt-in bounded timing diagnostics with fixed fields and no speech content."""
from __future__ import annotations
from collections import deque
import json
import logging
import os
import re
import uuid
from typing import Annotated
from pydantic import BaseModel, ConfigDict, Field

ID_REGEX = re.compile(r'^[a-zA-Z0-9_.-]{1,64}$')
Duration = Annotated[float, Field(ge=0, allow_inf_nan=False, strict=True)]


def is_perf_trace_enabled():
    """Enable diagnostics only through the preserved-prefix environment flag."""
    return os.environ.get('MURMUR_PERF_TRACE', '').strip().lower() in {'1', 'true', 'yes', 'on'}


def validate_correlation_id(value):
    """Reject arbitrary content and unbounded identifiers without echoing them."""
    return isinstance(value, str) and ID_REGEX.fullmatch(value) is not None


def sanitize_correlation_id(value):
    """Use a bounded supplied trace token or generate a fresh random identifier."""
    return value if validate_correlation_id(value) else str(uuid.uuid4())


class ServerPerfTiming(BaseModel):
    """Durations in the server perf_counter domain, never synchronized to a client."""
    model_config = ConfigDict(extra='forbid', validate_assignment=True)
    session_id: str = Field(pattern=r'^[a-zA-Z0-9_.-]{1,64}$', strict=True)
    clock_domain: str = Field(default='python_perf_counter', pattern=r'^python_perf_counter$')
    last_audio_offset_ms: Duration | None = None
    stop_to_lock_wait_ms: Duration | None = None
    lock_wait_ms: Duration | None = None
    outstanding_partial_wait_ms: Duration | None = None
    partial_task_active_at_stop: bool | None = None
    executor_queue_wait_ms: Duration | None = None
    final_inference_start_offset_ms: Duration | None = None
    final_inference_end_offset_ms: Duration | None = None
    model_inference_ms: Duration | None = None
    ws_send_duration_ms: Duration | None = None


class PerfTraceRingBuffer:
    """Keep at most 50 validated content-free records; callers receive copies."""
    def __init__(self, maxlen=50):
        self._buffer = deque(maxlen=min(50, max(1, maxlen)))

    def record(self, timing):
        if is_perf_trace_enabled():
            safe = ServerPerfTiming.model_validate(timing.model_dump()).model_dump()
            self._buffer.append(safe)
            logging.getLogger('perf_trace').info('B4_PERF %s', json.dumps(safe, separators=(',', ':')))

    def get_records(self):
        return [dict(record) for record in self._buffer]

    def clear(self):
        self._buffer.clear()


_SERVER_TRACE_BUFFER = PerfTraceRingBuffer()


def record_server_perf(timing):
    """Publish an explicitly enabled fixed-field server diagnostic record."""
    _SERVER_TRACE_BUFFER.record(timing)


def get_recent_server_traces():
    """Return a copy of the bounded safe diagnostics without accessing user data."""
    return _SERVER_TRACE_BUFFER.get_records()


def clear_server_traces():
    """Discard only in-memory test timing observations."""
    _SERVER_TRACE_BUFFER.clear()
