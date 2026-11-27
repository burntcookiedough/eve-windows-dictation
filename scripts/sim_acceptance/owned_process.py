"""Launch a process tree that can be stopped even if its launcher exits first."""

import ctypes
from ctypes import wintypes
from contextlib import contextmanager, suppress
import os
import signal
import subprocess

import psutil


class BasicJobLimits(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD),
    ]


class ExtendedJobLimits(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", BasicJobLimits), ("IoInfo", ctypes.c_ulonglong * 6),
        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


@contextmanager
def launch_in_windows_job(command, options):
    create_suspended = 0x00000004
    kill_on_job_close = 0x00002000
    extended_limit_information = 9
    process_set_quota_and_terminate = 0x0101
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel.CloseHandle.restype = wintypes.BOOL

    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    launcher = None
    assigned = False
    try:
        limits = ExtendedJobLimits()
        limits.BasicLimitInformation.LimitFlags = kill_on_job_close
        if not kernel.SetInformationJobObject(job, extended_limit_information, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())
        launcher = psutil.Popen(command, **options, creationflags=create_suspended | subprocess.CREATE_NO_WINDOW)
        handle = kernel.OpenProcess(process_set_quota_and_terminate, False, launcher.pid)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if not kernel.AssignProcessToJobObject(job, handle):
                raise ctypes.WinError(ctypes.get_last_error())
            assigned = True
        finally:
            kernel.CloseHandle(handle)
        # The launcher may spawn the interpreter as soon as it starts running.
        launcher.resume()
        yield launcher
    finally:
        kernel.CloseHandle(job)
        if launcher is not None:
            if not assigned and launcher.poll() is None:
                with suppress(psutil.NoSuchProcess):
                    launcher.kill()
            launcher.wait(timeout=10)


@contextmanager
def launch_owned_process(command, *, cwd, env, stdout):
    options = dict(cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=subprocess.STDOUT)
    if os.name == "nt":
        with launch_in_windows_job(command, options) as launcher:
            yield launcher
        return

    launcher = psutil.Popen(command, **options, start_new_session=True)
    try:
        yield launcher
    finally:
        with suppress(ProcessLookupError):
            os.killpg(launcher.pid, signal.SIGKILL)
        launcher.wait(timeout=10)
