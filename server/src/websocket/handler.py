"""Main WebSocket endpoint handler for transcription sessions."""

import asyncio
import json
import logging
import time

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from audio.parser import ParseError, parse_audio_frame
from config import get_settings
from protocol.errors import ErrorCode
from protocol.frames import ClosingReason, StartFrame
from session.context import SessionContext
from session.manager import SessionLimitError, get_session_manager
from session.state import SessionState
from transcription.processor import TranscriptionProcessor
from websocket.sender import FrameSender

logger = logging.getLogger(__name__)


async def websocket_handler(websocket: WebSocket) -> None:
    """Handle a WebSocket transcription session.

    This is the main entry point for transcription sessions.
    """
    settings = get_settings()
    manager = get_session_manager()

    # Try to create a session
    try:
        context = manager.create_session()
    except SessionLimitError:
        await websocket.accept()
        sender = FrameSender(websocket, "no-session")
        await sender.send_error(ErrorCode.RATE_LIMIT, "Maximum sessions reached")
        await websocket.close()
        return

    sender = FrameSender(websocket, context.session_id)

    try:
        await websocket.accept()
        logger.info("[%s] WebSocket connected", context.session_id)

        # Wait for start frame with timeout
        if not await _wait_for_start(
            websocket, sender, context, settings.start_timeout
        ):
            return

        # Create transcription processor
        processor = TranscriptionProcessor(context)

        # Determine partial emission interval (client override or server default)
        partial_interval = (
            context.partial_emission_interval
            if context.partial_emission_interval is not None
            else settings.partial_emission_interval
        )

        # Start background tasks
        partial_task = asyncio.create_task(
            _partial_emission_loop(sender, context, processor, partial_interval)
        )
        silence_task = asyncio.create_task(
            _silence_monitor_loop(sender, context, processor)
        )

        try:
            # Main message loop
            await _message_loop(websocket, sender, context, processor)
        finally:
            # Cancel background tasks
            partial_task.cancel()
            silence_task.cancel()
            try:
                await partial_task
            except asyncio.CancelledError:
                pass
            try:
                await silence_task
            except asyncio.CancelledError:
                pass

    except WebSocketDisconnect:
        logger.info("[%s] Client disconnected", context.session_id)
    except Exception as e:
        logger.exception("[%s] Unexpected error: %s", context.session_id, e)
        try:
            await sender.send_error(ErrorCode.INTERNAL, "Internal server error")
        except Exception:
            pass
    finally:
        # Clean up session (only transition if not already closed)
        if context.state_machine.state != SessionState.CLOSED:
            context.state_machine.transition_to(SessionState.CLOSED)
        manager.remove_session(context.session_id)
        try:
            await websocket.close()
        except Exception:
            pass


async def _wait_for_start(
    websocket: WebSocket,
    sender: FrameSender,
    context: SessionContext,
    timeout: float,
) -> bool:
    """Wait for a valid start frame.

    Returns:
        True if start received successfully, False otherwise.
    """
    try:
        message = await asyncio.wait_for(
            websocket.receive(),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        await sender.send_error(ErrorCode.START_TIMEOUT, "No start frame received")
        await websocket.close()
        return False

    # Check message type
    if "bytes" in message:
        await sender.send_error(ErrorCode.NO_START, "Audio received before start")
        await websocket.close()
        return False

    if "text" not in message:
        # Connection closed
        return False

    # Parse control frame
    try:
        data = json.loads(message["text"])
    except json.JSONDecodeError:
        await sender.send_error(ErrorCode.INVALID_CTRL, "Invalid JSON")
        await websocket.close()
        return False

    # Validate as start frame
    if data.get("frame") != "control" or data.get("type") != "start":
        await sender.send_error(ErrorCode.INVALID_START, "Expected start frame")
        await websocket.close()
        return False

    try:
        start_frame = StartFrame.model_validate(data)
    except ValidationError as e:
        await sender.send_error(ErrorCode.INVALID_START, f"Invalid start frame: {e}")
        await websocket.close()
        return False

    # Update context with start frame config
    context.silence_timeout = start_frame.silence_timeout
    context.partial_emission_interval = start_frame.partial_emission_interval
    context.hotwords = (
        start_frame.hotwords.strip()
        if start_frame.hotwords is not None and start_frame.hotwords.strip()
        else None
    )
    context.mark_started()
    context.state_machine.transition_to(SessionState.STARTED)

    # Send ready
    await sender.send_ready()
    logger.info(
        "[%s] Session started (silence_timeout=%.1fs, partial_interval=%s, hotwords=%s)",
        context.session_id,
        context.silence_timeout,
        f"{context.partial_emission_interval:.2f}s"
        if context.partial_emission_interval
        else "default",
        "enabled" if context.hotwords else "disabled",
    )

    return True


async def _message_loop(
    websocket: WebSocket,
    sender: FrameSender,
    context: SessionContext,
    processor: TranscriptionProcessor,
) -> None:
    """Main message processing loop."""
    while context.state_machine.is_active():
        try:
            message = await websocket.receive()
        except WebSocketDisconnect:
            raise

        # Handle binary audio frames
        if "bytes" in message:
            await _handle_audio_frame(message["bytes"], sender, context)
            continue

        # Handle text control frames
        if "text" in message:
            should_close = await _handle_control_frame(
                message["text"], websocket, sender, context, processor
            )
            if should_close:
                return
            continue

        # Connection closed
        if message.get("type") == "websocket.disconnect":
            return


async def _handle_audio_frame(
    data: bytes,
    sender: FrameSender,
    context: SessionContext,
) -> None:
    """Handle a binary audio frame."""
    if not context.state_machine.is_accepting_audio():
        # Only log once per invalid state to avoid spam
        if not getattr(context, "_logged_invalid_audio", False):
            logger.warning(
                "[%s] Audio received in invalid state %s (suppressing further)",
                context.session_id,
                context.state_machine.state.value,
            )
            context._logged_invalid_audio = True  # type: ignore[attr-defined]
        return

    try:
        frame = parse_audio_frame(data)
    except ParseError as e:
        await sender.send_error(ErrorCode.INVALID_AUDIO, str(e))
        return

    # Add to buffer
    context.audio_buffer.append(frame.sequence, frame.samples)

    # Transition to streaming if first audio and record audio start time
    if context.state_machine.state == SessionState.STARTED:
        context.audio_start_time = time.monotonic()
        context.state_machine.transition_to(SessionState.STREAMING)
        logger.info("[%s] Audio streaming started", context.session_id)


async def _handle_control_frame(
    text: str,
    websocket: WebSocket,
    sender: FrameSender,
    context: SessionContext,
    processor: TranscriptionProcessor,
) -> bool:
    """Handle a text control frame.

    Returns:
        True if session should close, False otherwise.
    """
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        await sender.send_error(ErrorCode.INVALID_CTRL, "Invalid JSON")
        await websocket.close()
        return True

    frame_type = data.get("frame")
    msg_type = data.get("type")

    # Ignore unknown frame types
    if frame_type != "control":
        logger.warning("[%s] Unknown frame type: %s", context.session_id, frame_type)
        return False

    # Handle stop
    if msg_type == "stop":
        logger.info("[%s] Received stop frame from client", context.session_id)
        await _finalize_session(sender, context, processor, ClosingReason.STOP_RECEIVED)
        await websocket.close()
        return True

    # Ignore duplicate start
    if msg_type == "start":
        logger.debug("[%s] Ignoring duplicate start frame", context.session_id)
        return False

    # Log unknown control types
    logger.warning("[%s] Unknown control type: %s", context.session_id, msg_type)
    return False


async def _partial_emission_loop(
    sender: FrameSender,
    context: SessionContext,
    processor: TranscriptionProcessor,
    min_interval: float,
) -> None:
    """Background task for emitting partial transcription results.

    Uses adaptive timing: sleeps only for the remaining time after transcription
    completes, ensuring cycle time = max(min_interval, transcription_time).
    """
    while context.state_machine.is_active():
        cycle_start = time.monotonic()

        if not context.state_machine.is_accepting_audio():
            # Not ready for audio yet, use fixed sleep
            await asyncio.sleep(min_interval)
            continue

        try:
            result = await processor.transcribe_partial()
            if result is not None:
                # Update last speech time if speech was detected
                if (
                    result.last_speech_end is not None
                    and context.audio_start_time is not None
                ):
                    context.last_speech_time = (
                        context.audio_start_time + result.last_speech_end
                    )

                if not result.is_empty:
                    await sender.send_partial(
                        result.text,
                        result.confidence,
                        result.transcription_time,
                        result.audio_duration,
                    )
                    context.has_speech = True

                # Log cycle timing at debug level
                cycle_time = time.monotonic() - cycle_start
                logger.debug(
                    "[%s] Partial emission: transcribe=%.0fms, cycle=%.0fms, audio=%.1fs",
                    context.session_id,
                    result.transcription_time * 1000,
                    cycle_time * 1000,
                    result.audio_duration,
                )
        except Exception as e:
            logger.exception(
                "[%s] Error in partial emission: %s", context.session_id, e
            )

        # Adaptive sleep: only wait for remaining time to hit min_interval
        elapsed = time.monotonic() - cycle_start
        remaining = min_interval - elapsed
        if remaining > 0:
            await asyncio.sleep(remaining)


async def _silence_monitor_loop(
    sender: FrameSender,
    context: SessionContext,
    processor: TranscriptionProcessor,
) -> None:
    """Background task for monitoring silence and audio reception timeouts.

    Two timeout conditions are checked:
    1. Speech-based silence: No speech detected for silence_timeout seconds
    2. Audio reception: No audio frames received for silence_timeout seconds
    """
    while context.state_machine.is_active():
        await asyncio.sleep(0.5)  # Check every 500ms

        if not context.state_machine.is_accepting_audio():
            continue

        now = time.monotonic()

        # Check 1: Audio reception timeout (client stopped sending audio)
        # This uses the existing seconds_since_last_audio from the buffer
        if context.audio_buffer.has_audio():
            audio_gap = context.audio_buffer.seconds_since_last_audio
            if audio_gap >= context.silence_timeout:
                logger.info(
                    "[%s] Audio reception timeout (no audio for %.1fs)",
                    context.session_id,
                    audio_gap,
                )
                context.state_machine.transition_to(SessionState.FINALIZING)
                await _finalize_session(
                    sender, context, processor, ClosingReason.SILENCE_TIMEOUT
                )
                return

        # Check 2: Speech-based silence timeout
        # Only check after we've received some audio
        if not context.audio_buffer.has_audio():
            continue

        # Calculate silence duration based on speech detection
        if context.last_speech_time is not None:
            # Speech has been detected - check time since last speech
            silence_duration = now - context.last_speech_time
        elif context.started_at is not None:
            # No speech detected yet - use session start as fallback
            # This handles the case where user never speaks
            silence_duration = now - context.started_at
        else:
            continue

        # Check if silence timeout exceeded
        if silence_duration >= context.silence_timeout:
            logger.info(
                "[%s] Speech silence timeout (%.1fs since %s)",
                context.session_id,
                context.silence_timeout,
                "last speech" if context.last_speech_time else "session start",
            )
            context.state_machine.transition_to(SessionState.FINALIZING)
            await _finalize_session(
                sender, context, processor, ClosingReason.SILENCE_TIMEOUT
            )
            return


async def _finalize_session(
    sender: FrameSender,
    context: SessionContext,
    processor: TranscriptionProcessor,
    reason: ClosingReason,
) -> None:
    """Finalize session: send final text (if any) and closing frame."""
    if context.state_machine.state == SessionState.CLOSED:
        return

    logger.info("[%s] Finalizing session (reason=%s)", context.session_id, reason.value)

    # Transition to finalizing if not already
    if context.state_machine.state != SessionState.FINALIZING:
        context.state_machine.transition_to(SessionState.FINALIZING)

    # Get final transcription
    try:
        result = await processor.transcribe_final()
        if not result.is_empty:
            logger.info(
                "[%s] Final transcription: %r (%.1fs audio)",
                context.session_id,
                result.text[:100] if len(result.text) > 100 else result.text,
                result.audio_duration,
            )
            await sender.send_final(
                result.text,
                result.confidence,
                result.transcription_time,
                result.audio_duration,
            )
        else:
            logger.info("[%s] No speech detected in session", context.session_id)
    except Exception as e:
        logger.exception("[%s] Error in final transcription: %s", context.session_id, e)

    # Send closing frame
    logger.info("[%s] Sending closing frame", context.session_id)
    await sender.send_closing(reason)

    # Mark closed
    context.state_machine.transition_to(SessionState.CLOSED)
    logger.info("[%s] Session closed", context.session_id)
