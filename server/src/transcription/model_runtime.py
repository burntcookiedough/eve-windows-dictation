"""Transactional model preparation, activation, and generation leases."""

from __future__ import annotations

import asyncio
import inspect
import logging
import threading
from collections.abc import Callable
from dataclasses import replace
from typing import Any, TypeVar

from transcription.contracts import (
    Failed,
    ModelAdapter,
    ModelId,
    ModelInfo,
    ModelSession,
    PreparedModel,
    PreparationProgress,
    Preparing,
    ProgressSink,
    PublicModelError,
    Ready,
    RuntimeStatus,
    SessionId,
    Starting,
    Stopping,
    WhisperConfig,
)

logger = logging.getLogger(__name__)
_SnapshotValue = TypeVar("_SnapshotValue")
_DEFAULT_DRAIN_TIMEOUT_S = 30.0


class _Generation:
    """Runtime-owned slot for one prepared model and its leases."""

    __slots__ = (
        "generation",
        "config",
        "model",
        "leases",
        "retired",
        "shutdown_started",
        "shutdown_complete",
        "drained",
    )

    def __init__(self, generation: int, config: WhisperConfig, model: PreparedModel) -> None:
        self.generation = generation
        self.config = config
        self.model = model
        self.leases = 0
        self.retired = False
        self.shutdown_started = False
        self.shutdown_complete = threading.Event()
        self.drained = threading.Event()
        self.drained.set()


class SessionLease:
    """An idempotent lease over a session pinned to one model generation."""

    __slots__ = ("_runtime", "_generation", "_session", "_closed", "_lock")

    def __init__(
        self,
        runtime: ModelRuntime,
        generation: _Generation,
        session: ModelSession,
    ) -> None:
        self._runtime = runtime
        self._generation = generation
        self._session = session
        self._closed = False
        self._lock = threading.Lock()

    @property
    def session(self) -> ModelSession:
        with self._lock:
            if self._closed:
                raise RuntimeError("Session lease is closed")
            return self._session

    def close(self) -> None:
        """Close the native session and release its generation exactly once."""

        with self._lock:
            if self._closed:
                return
            self._closed = True
            session = self._session

        try:
            session.close()
        finally:
            self._runtime._release(self._generation)


class ModelRuntime:
    """Deep model lifecycle module with one active and draining generations.

    Preparation runs in a worker thread and is serialized by an asynchronous
    lock.  A candidate is persisted before the state lock publishes the new
    in-memory settings and active pointer.  Failed candidates are discarded and
    never replace a usable current generation.
    """

    def __init__(
        self,
        *,
        adapter: ModelAdapter,
        initial: WhisperConfig | None = None,
    ) -> None:
        self._adapter = adapter
        self._initial = initial
        self._state_lock = threading.RLock()
        self._prepare_lock = asyncio.Lock()
        self._status: RuntimeStatus = Starting()
        self._active: _Generation | None = None
        self._draining: dict[int, _Generation] = {}
        self._next_generation = 0
        self._preparing_generation: int | None = None
        self._preparation_task: asyncio.Task[Any] | None = None
        self._native_prepare_task: asyncio.Task[Any] | None = None
        self._preparation_reserved = False
        self._shutdown_task: asyncio.Task[Any] | None = None
        self._shutting_down = False
        self._drain_timeout_s = _DEFAULT_DRAIN_TIMEOUT_S

    async def start(self) -> None:
        """Prepare the initial model once; retry is allowed after failure."""

        with self._state_lock:
            if self._active is not None:
                return
            if self._shutting_down:
                raise RuntimeError("Model runtime is stopping")
            in_flight = self._preparation_task
            initial = self._initial
            if initial is None:
                raise ValueError("ModelRuntime requires an initial WhisperConfig")

        if in_flight is not None and in_flight is not asyncio.current_task():
            await asyncio.shield(in_flight)
            return

        await self._prepare_and_activate(
            initial,
            persist=None,
            publish=None,
            initial=True,
        )

    def status(self) -> RuntimeStatus:
        """Return an immutable snapshot safe for health/settings responses."""

        with self._state_lock:
            return self._status_locked()

    def snapshot(
        self,
        read_settings: Callable[[], _SnapshotValue],
    ) -> tuple[RuntimeStatus, _SnapshotValue]:
        """Read runtime status and a caller-owned settings view atomically.

        Settings publication is supplied by the composition root.  Taking the
        read callback under the runtime state lock means health, diagnostics,
        and settings responses cannot combine a newly published Settings
        object with the previous model generation (or vice versa).
        """

        with self._state_lock:
            return self._status_locked(), read_settings()

    def _status_locked(self) -> RuntimeStatus:
        status = self._status
        if isinstance(status, Ready):
            return replace(
                status,
                active_sessions=self._active.leases if self._active else 0,
                draining_sessions=self._draining_session_count_locked(),
            )
        if isinstance(status, Preparing):
            return replace(
                status,
                active_sessions=self._active.leases if self._active else 0,
            )
        return status

    def open_session(self, session_id: SessionId) -> SessionLease:
        """Open a session on the current generation.

        Initial preparation has no active generation and rejects leases.  During
        replacement, the existing active generation remains admitted, so new
        sessions do not observe a transient loading outage.
        """

        del session_id  # IDs remain a caller concern; the lease owns generation identity.
        with self._state_lock:
            if self._shutting_down:
                raise RuntimeError("Model runtime is stopping")
            generation = self._active
            if generation is None:
                raise RuntimeError("Model runtime is not ready")
            session = generation.model.open_session()
            generation.leases += 1
            generation.drained.clear()
            return SessionLease(self, generation, session)

    async def prepare_and_activate(
        self,
        config: WhisperConfig,
        *,
        persist: Callable[[], Any],
        publish: Callable[[], Any],
    ) -> None:
        """Prepare, persist, and atomically activate a replacement model."""

        with self._state_lock:
            if self._shutting_down:
                raise RuntimeError("Model runtime is stopping")
            # Startup has no current generation and must not accumulate a second
            # untracked preparation behind the asynchronous lock.
            if self._active is None and self._preparation_task is not None:
                raise RuntimeError("Model preparation already in progress")

        await self._prepare_and_activate(
            config,
            persist=persist,
            publish=publish,
            initial=False,
        )

    def schedule_prepare_and_activate(
        self,
        config: WhisperConfig,
        *,
        persist: Callable[[], Any],
        publish: Callable[[], Any],
    ) -> asyncio.Task[None]:
        """Reserve and schedule one replacement on the current event loop."""

        with self._state_lock:
            if self._shutting_down:
                raise RuntimeError("Model runtime is stopping")
            if self._preparation_reserved or self._preparation_task is not None:
                raise RuntimeError("Model preparation already in progress")
            self._preparation_reserved = True
        try:
            return asyncio.create_task(
                self._run_reserved_replacement(config, persist=persist, publish=publish)
            )
        except BaseException:
            with self._state_lock:
                self._preparation_reserved = False
            raise

    async def _run_reserved_replacement(
        self,
        config: WhisperConfig,
        *,
        persist: Callable[[], Any],
        publish: Callable[[], Any],
    ) -> None:
        try:
            await self._prepare_and_activate(
                config,
                persist=persist,
                publish=publish,
                initial=False,
            )
        finally:
            with self._state_lock:
                self._preparation_reserved = False

    async def _prepare_and_activate(
        self,
        config: WhisperConfig,
        *,
        persist: Callable[[], Any] | None,
        publish: Callable[[], Any] | None,
        initial: bool,
    ) -> None:
        async with self._prepare_lock:
            same_config = False
            with self._state_lock:
                if self._shutting_down:
                    if initial:
                        return
                    raise RuntimeError("Model runtime is stopping")
                current = self._active
                if initial and current is not None:
                    return
                if not initial and current is not None and current.config == config:
                    same_config = True
                else:
                    generation = self._next_generation + 1
                    self._next_generation = generation
                    candidate = ModelId(str(config.model))
                    self._status = Preparing(
                        current=current.model.info if current is not None else None,
                        candidate=candidate,
                        progress=None,
                        active_sessions=current.leases if current is not None else 0,
                    )
                    self._preparing_generation = generation
                    preparation_task = asyncio.current_task()
                    self._preparation_task = preparation_task

            if same_config:
                if persist is not None:
                    await self._run_hook(persist)
                with self._state_lock:
                    if self._shutting_down:
                        return
                    if publish is not None:
                        result = publish()
                        if inspect.isawaitable(result):
                            raise TypeError("publish hook must be synchronous")
                    current = self._active
                    if current is not None:
                        self._status = Ready(
                            model=current.model.info,
                            active_sessions=current.leases,
                            draining_sessions=self._draining_session_count_locked(),
                        )
                return

            prepared: PreparedModel | None = None
            activated = False
            try:
                prepared = await self._prepare_native(config, generation)
                with self._state_lock:
                    shutting_down = self._shutting_down
                if shutting_down:
                    await self._discard(prepared)
                    return

                if persist is not None:
                    await self._run_hook(persist)

                with self._state_lock:
                    if self._shutting_down:
                        discard = True
                    else:
                        discard = False
                        # ``publish`` is the non-fallible in-memory settings
                        # publication hook.  It runs under the same state lock
                        # as the pointer swap, so readers cannot see a mixed
                        # settings/model snapshot.
                        if publish is not None:
                            result = publish()
                            if inspect.isawaitable(result):
                                raise TypeError("publish hook must be synchronous")
                        old = self._active
                        new_generation = _Generation(generation, config, prepared)
                        self._active = new_generation
                        activated = True
                        self._status = Ready(
                            model=prepared.info,
                            active_sessions=0,
                            draining_sessions=self._draining_session_count_locked(),
                        )
                        if old is not None:
                            old.retired = True
                            if old.leases:
                                self._draining[old.generation] = old

                if discard:
                    await self._discard(prepared)
                    return

                if old is not None and old.leases == 0:
                    await self._shutdown_generation(old)
                return
            except asyncio.CancelledError:
                # A native preparation may not be cancellable.  Wait for the
                # worker and discard its result before propagating cancellation.
                with self._state_lock:
                    native_task = self._native_prepare_task
                if prepared is None and native_task is not None:
                    try:
                        prepared = await asyncio.shield(native_task)
                    except BaseException:
                        prepared = None
                    finally:
                        self._clear_native_prepare_task(native_task)
                if prepared is not None and not activated:
                    await self._discard(prepared)
                with self._state_lock:
                    if not self._shutting_down and self._active is not None:
                        self._status = Ready(
                            model=self._active.model.info,
                            active_sessions=self._active.leases,
                            draining_sessions=self._draining_session_count_locked(),
                        )
                raise
            except BaseException as exc:
                if prepared is not None and not activated:
                    await self._discard(prepared)
                with self._state_lock:
                    if not self._shutting_down:
                        current_info = self._active.model.info if self._active else None
                        self._status = Failed(
                            current=current_info,
                            candidate=ModelId(str(config.model)),
                            error=_public_error(exc),
                        )
                raise
            finally:
                with self._state_lock:
                    if self._preparation_task is preparation_task:
                        self._preparation_task = None
                    if self._preparing_generation == generation:
                        self._preparing_generation = None

    async def _prepare_native(self, config: WhisperConfig, generation: int) -> PreparedModel:
        progress: ProgressSink = lambda update: self._accept_progress(generation, config, update)
        native_task = asyncio.create_task(asyncio.to_thread(self._adapter.prepare, config, progress))
        with self._state_lock:
            self._native_prepare_task = native_task
        try:
            return await asyncio.shield(native_task)
        finally:
            self._clear_native_prepare_task(native_task)

    def _clear_native_prepare_task(self, native_task: asyncio.Task[PreparedModel]) -> None:
        """Forget only a matching native task that has actually completed."""

        with self._state_lock:
            if self._native_prepare_task is native_task and native_task.done():
                self._native_prepare_task = None

    def _accept_progress(
        self,
        generation: int,
        config: WhisperConfig,
        update: PreparationProgress,
    ) -> None:
        event = replace(
            update,
            candidate=ModelId(str(config.model)),
            generation=generation,
        )
        with self._state_lock:
            status = self._status
            if (
                self._shutting_down
                or not isinstance(status, Preparing)
                or self._preparing_generation != generation
            ):
                return
            if status.candidate != event.candidate:
                return
            self._status = replace(status, progress=event)

    async def _run_hook(self, hook: Callable[[], Any]) -> None:
        result = hook()
        if inspect.isawaitable(result):
            await result

    async def _discard(self, prepared: PreparedModel) -> None:
        try:
            await asyncio.to_thread(prepared.shutdown)
        except Exception:
            logger.exception("Failed to discard an unactivated model")

    async def _shutdown_generation(self, generation: _Generation) -> None:
        owns_shutdown = False
        with self._state_lock:
            if generation.shutdown_started is False:
                generation.shutdown_started = True
                owns_shutdown = True
        if not owns_shutdown:
            await asyncio.to_thread(generation.shutdown_complete.wait)
            return
        try:
            await asyncio.to_thread(generation.model.shutdown)
        except Exception:
            logger.exception("Failed to shut down model generation %s", generation.generation)
        finally:
            with self._state_lock:
                self._draining.pop(generation.generation, None)
                generation.drained.set()
                generation.shutdown_complete.set()

    def _release(self, generation: _Generation) -> None:
        should_shutdown = False
        with self._state_lock:
            if generation.leases <= 0:
                return
            generation.leases -= 1
            if generation.leases == 0:
                generation.drained.set()
                if generation.retired and not generation.shutdown_started:
                    generation.shutdown_started = True
                    should_shutdown = True
        if should_shutdown:
            # ``close`` is intentionally synchronous because the existing
            # processor interface is synchronous.  Native shutdown belongs to
            # a retired generation only and is already outside the state lock.
            try:
                generation.model.shutdown()
            except Exception:
                logger.exception("Failed to shut down model generation %s", generation.generation)
            finally:
                with self._state_lock:
                    self._draining.pop(generation.generation, None)
                    generation.shutdown_complete.set()

    async def shutdown(self) -> None:
        """Join native preparation, discard candidates, and drain generations."""

        current_task = asyncio.current_task()
        with self._state_lock:
            if self._shutdown_task is not None and self._shutdown_task is not current_task:
                other = self._shutdown_task
            else:
                other = None
                self._shutdown_task = current_task
                self._shutting_down = True
                self._status = Stopping()
                if self._active is not None:
                    self._active.retired = True
                    self._draining[self._active.generation] = self._active
                    self._active = None
                generations = tuple(self._draining.values())

        if other is not None:
            await asyncio.shield(other)
            return

        try:
            with self._state_lock:
                preparation = self._preparation_task
            if preparation is not None and preparation is not current_task:
                try:
                    await asyncio.shield(preparation)
                except BaseException:
                    # The preparation task owns its public error; shutdown must
                    # still release all generations and complete deterministically.
                    logger.debug("Preparation ended while runtime was stopping", exc_info=True)

            # Capture any generation created just before the preparation task
            # observed shutdown, then wait for active sessions to drain.
            with self._state_lock:
                generations = tuple(self._draining.values())
            for generation in generations:
                drained = await asyncio.to_thread(
                    generation.drained.wait,
                    self._drain_timeout_s,
                )
                if not drained:
                    with self._state_lock:
                        leases = generation.leases
                    logger.warning(
                        "Generation %s still has %s lease(s) after %.1fs; forcing shutdown",
                        generation.generation,
                        leases,
                        self._drain_timeout_s,
                    )
                await self._shutdown_generation(generation)
        finally:
            with self._state_lock:
                self._shutdown_task = None

    def _draining_session_count_locked(self) -> int:
        return sum(generation.leases for generation in self._draining.values())


def _public_error(exc: BaseException) -> PublicModelError:
    """Map native/provider failures to bounded, stable public diagnostics."""

    text = _exception_text(exc)
    if any(marker in text for marker in ("401", "unauthorized", "invalid token", "oauth token")):
        return PublicModelError(
            code="authentication_failed",
            message="Hugging Face authentication failed while preparing this model.",
        )
    if any(marker in text for marker in ("repository not found", "gated repo", "cannot access gated")):
        return PublicModelError(
            code="repository_unavailable",
            message="The selected model repository could not be accessed.",
        )
    if any(marker in text for marker in ("offline mode", "outgoing traffic has been disabled")):
        return PublicModelError(
            code="offline_cache_miss",
            message="This model is not fully cached and Eve is offline.",
        )
    if any(marker in text for marker in ("connection error", "connectionerror", "timed out", "timeout", "tls", "ssl")):
        return PublicModelError(
            code="provider_unreachable",
            message="Eve could not reach the model provider.",
        )
    if any(marker in text for marker in ("cuda", "cudnn", "cublas", "cudart")):
        return PublicModelError(
            code="cuda_unavailable",
            message="The selected model could not initialize the CUDA runtime.",
        )
    return PublicModelError(
        code="preparation_failed",
        message="The selected speech model could not be prepared.",
    )


def _exception_text(exc: BaseException) -> str:
    seen: set[int] = set()
    pending: list[BaseException | None] = [exc]
    messages: list[str] = []
    while pending:
        current = pending.pop()
        if current is None or id(current) in seen:
            continue
        seen.add(id(current))
        messages.append(str(current).lower())
        pending.extend((current.__cause__, current.__context__))
    return "\n".join(messages)


__all__ = ["ModelRuntime", "SessionLease"]
