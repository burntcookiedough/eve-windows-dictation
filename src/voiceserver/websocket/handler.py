"""Main WebSocket endpoint handler for transcription sessions."""

import asyncio
import json
import logging

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from voiceserver.audio.parser import ParseError, parse_audio_frame
from voiceserver.config import get_settings
from voiceserver.protocol.errors import ErrorCode
from voiceserver.protocol.frames import ClosingReason, StartFrame
from voiceserver.session.context import SessionContext
from voiceserver.session.manager import SessionLimitError, get_session_manager
from voiceserver.session.state import SessionState
from voiceserver.transcription.processor import TranscriptionProcessor
from voiceserver.websocket.sender import FrameSender

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
        if not await _wait_for_start(websocket, sender, context, settings.start_timeout):
            return

        # Create transcription processor
        processor = TranscriptionProcessor(context)

        # Start background tasks
        partial_task = asyncio.create_task(
            _partial_emission_loop(sender, context, processor, settings.partial_emission_interval)
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
        # Clean up session
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
    context.mark_started()
    context.state_machine.transition_to(SessionState.STARTED)

    # Send ready
    await sender.send_ready()
    logger.info(
        "[%s] Session started (silence_timeout=%.1fs)",
        context.session_id,
        context.silence_timeout,
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
        logger.warning("[%s] Audio received in invalid state", context.session_id)
        return

    try:
        frame = parse_audio_frame(data)
    except ParseError as e:
        await sender.send_error(ErrorCode.INVALID_AUDIO, str(e))
        return

    # Add to buffer
    context.audio_buffer.append(frame.sequence, frame.samples)

    # Transition to streaming if first audio
    if context.state_machine.state == SessionState.STARTED:
        context.state_machine.transition_to(SessionState.STREAMING)


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
    interval: float,
) -> None:
    """Background task for emitting partial transcription results."""
    while context.state_machine.is_active():
        await asyncio.sleep(interval)

        if not context.state_machine.is_accepting_audio():
            continue

        try:
            result = await processor.transcribe_partial()
            if result is not None and not result.is_empty:
                await sender.send_partial(result.text, result.confidence)
                context.has_speech = True
        except Exception as e:
            logger.exception("[%s] Error in partial emission: %s", context.session_id, e)


async def _silence_monitor_loop(
    sender: FrameSender,
    context: SessionContext,
    processor: TranscriptionProcessor,
) -> None:
    """Background task for monitoring silence timeout."""
    while context.state_machine.is_active():
        await asyncio.sleep(0.5)  # Check every 500ms

        if not context.state_machine.is_accepting_audio():
            continue

        # Only check silence after we've received some audio
        if not context.audio_buffer.has_audio():
            continue

        # Check if silence timeout exceeded
        if context.audio_buffer.seconds_since_last_audio >= context.silence_timeout:
            logger.info(
                "[%s] Silence timeout (%.1fs)",
                context.session_id,
                context.silence_timeout,
            )
            # Signal finalization - the main loop will handle cleanup
            # We set a flag and let the handler notice
            context.state_machine.transition_to(SessionState.FINALIZING)
            await _finalize_session(sender, context, processor, ClosingReason.SILENCE_TIMEOUT)
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

    # Transition to finalizing if not already
    if context.state_machine.state != SessionState.FINALIZING:
        context.state_machine.transition_to(SessionState.FINALIZING)

    # Get final transcription
    try:
        result = await processor.transcribe_final()
        if not result.is_empty:
            await sender.send_final(result.text, result.confidence)
    except Exception as e:
        logger.exception("[%s] Error in final transcription: %s", context.session_id, e)

    # Send closing frame
    await sender.send_closing(reason)

    # Mark closed
    context.state_machine.transition_to(SessionState.CLOSED)
