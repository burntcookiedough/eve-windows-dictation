"""Protocol constants for audio frame format."""

# Audio frame header layout (big-endian):
# - Sequence: 2 bytes (uint16)
# - Sample count: 2 bytes (uint16)
# - Flags: 1 byte (uint8, reserved, must be 0x00)
HEADER_SIZE = 5

# Audio format specifications
AUDIO_SAMPLE_RATE = 16000  # Hz
AUDIO_BIT_DEPTH = 16  # bits
AUDIO_CHANNELS = 1  # mono
BYTES_PER_SAMPLE = AUDIO_BIT_DEPTH // 8  # 2 bytes per sample
MAX_FRAME_SECONDS = 4  # seconds
MAX_FRAME_SAMPLES = AUDIO_SAMPLE_RATE * MAX_FRAME_SECONDS

# Default timeouts
DEFAULT_START_TIMEOUT = 10.0  # seconds
DEFAULT_SILENCE_TIMEOUT = 5.0  # seconds

# Transcription emission interval
PARTIAL_EMISSION_INTERVAL = 0.5  # seconds
