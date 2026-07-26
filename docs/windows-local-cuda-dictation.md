# Windows local CUDA dictation setup

This document is the historical, machine-specific recovery record for the published
v0.6.3 Murmur release. Its Murmur paths are intentionally unchanged. Current source
builds are visibly named Eve and use `%APPDATA%\Eve`; use `BUILDING.md` for current
build instructions.

It captures a reproducible Windows 11 setup for running the published Murmur release
as a fully local, GPU-accelerated push-to-talk dictation assistant.

## Verified machine-local paths

These are the paths used for the verified setup:

- Installed app: `%LOCALAPPDATA%\Programs\murmur\Murmur.exe`
- Installed app resources: `%LOCALAPPDATA%\Programs\murmur\resources`
- Installed server: `%LOCALAPPDATA%\Programs\murmur\resources\server`
- App settings: `%APPDATA%\murmur\settings.json`
- Server settings: `%LOCALAPPDATA%\Programs\murmur\resources\server\settings.json`
- Hugging Face home: `E:\hf_cache`
- Hugging Face hub cache: `E:\AI\cache\huggingface\hub`
- Transformers cache: `E:\hf_cache`
- XDG cache home: `E:\AI\cache`

## Target hardware

- Windows 11
- NVIDIA RTX 3060 Laptop GPU, 6 GB VRAM
- Python 3.11
- CUDA-capable PyTorch and CTranslate2 runtime

## Fresh reinstall outline

Use this path if Murmur is removed from the laptop and needs to be restored.

1. Install Murmur from the latest release or build it from this repository after this fix is merged.
2. Install Python 3.11 if the bundled server virtual environment is missing or points to a stale build path.
3. Configure the server virtual environment with CUDA-capable dependencies.
4. Configure the model cache environment variables.
5. Download and verify `mobiuslabsgmbh/faster-whisper-large-v3-turbo`.
6. Apply the server and app settings in this document.
7. Start Murmur and query `%APPDATA%\murmur\server.pid` to find the active server port.
8. Verify `/health` reports `engine.current=whisper`, `model=large-v3-turbo`, `device=cuda`, `compute_type=float16`, `cuda_active=true`, CUDA GPU name, and `status=ready`.
9. Hold left `Ctrl + Windows`, speak, release, and confirm the transcript is inserted into the focused field.

If running an installed release that does not include these changes yet, install a build from the fork source or patch/repack `app.asar` from the fixed app build output.

## Recommended model and backend

- Engine: `whisper`
- Model: `large-v3-turbo`
- Faster-Whisper repository: `mobiuslabsgmbh/faster-whisper-large-v3-turbo`
- Device: `cuda`
- Compute type: `float16`

The `deepdml/faster-whisper-large-v3-turbo` repository name is not available at the time this setup was verified. Faster-Whisper resolves `large-v3-turbo` to the Mobius Labs/Dropbox Dash CTranslate2 model layout.

Expected model files:

- `.gitattributes`
- `README.md`
- `config.json`
- `model.bin`
- `preprocessor_config.json`
- `tokenizer.json`
- `vocabulary.json`

`model.bin` should be `1617884929` bytes.

## Server settings

Set `resources/server/settings.json` to:

```json
{
  "engine": "whisper",
  "engine_preference_mode": "manual",
  "whisper_model": "large-v3-turbo",
  "whisper_device": "cuda",
  "whisper_compute_type": "float16",
  "whisper_language": "en",
  "whisper_beam_size": 1,
  "whisper_temperature": 0.0,
  "whisper_condition_on_previous_text": false,
  "whisper_without_timestamps": true,
  "whisper_vad_filter": true,
  "whisper_vad_min_silence_duration_ms": 500,
  "whisper_vad_speech_pad_ms": 200,
  "whisper_vad_threshold": 0.5,
  "transcription_max_workers": 1,
  "allow_overlapping_inference": false,
  "partial_emission_interval": 0.1,
  "unload_before_swap": true
}
```

On the verified laptop this file was:

```powershell
$serverSettings = "$env:LOCALAPPDATA\Programs\murmur\resources\server\settings.json"
@'
{
  "engine": "whisper",
  "engine_preference_mode": "manual",
  "whisper_model": "large-v3-turbo",
  "whisper_device": "cuda",
  "whisper_compute_type": "float16",
  "whisper_language": "en",
  "whisper_beam_size": 1,
  "whisper_temperature": 0.0,
  "whisper_condition_on_previous_text": false,
  "whisper_without_timestamps": true,
  "whisper_vad_filter": true,
  "whisper_vad_min_silence_duration_ms": 500,
  "whisper_vad_speech_pad_ms": 200,
  "whisper_vad_threshold": 0.5,
  "transcription_max_workers": 1,
  "allow_overlapping_inference": false,
  "partial_emission_interval": 0.1,
  "unload_before_swap": true
}
'@ | Set-Content -LiteralPath $serverSettings -Encoding UTF8
```

## App settings

Set `%APPDATA%\murmur\settings.json` to:

```json
{
  "hotkey": {
    "keycode": 3675,
    "ctrlKey": true,
    "altKey": false,
    "shiftKey": false,
    "metaKey": false
  },
  "holdToTalk": true,
  "autoCopy": true,
  "autoPaste": true,
  "restoreClipboardAfterPaste": true,
  "clipboardRestoreDelayMs": 250,
  "pasteMethod": "sendinput",
  "silenceTimeout": 15,
  "appendPeriod": false,
  "appendSpace": true,
  "dictationMode": "clean_prompt",
  "selectedDeviceId": "default",
  "launchOnBoot": true,
  "startMinimized": true,
  "serverAutoStart": true,
  "useExternalServer": false,
  "hotwordsEnabled": false,
  "hotwordsCsl": ""
}
```

`keycode: 3675` is the uiohook left Windows/Meta key. The application now tracks held modifier state across key events so `Ctrl + Windows` works even when uiohook reports inconsistent `ctrlKey`/`metaKey` flags on the Windows-key event itself.

On the verified laptop this file was applied with:

```powershell
$appSettings = "$env:APPDATA\murmur\settings.json"
@'
{
  "hotkey": {
    "keycode": 3675,
    "ctrlKey": true,
    "altKey": false,
    "shiftKey": false,
    "metaKey": false
  },
  "holdToTalk": true,
  "autoCopy": true,
  "autoPaste": true,
  "restoreClipboardAfterPaste": true,
  "clipboardRestoreDelayMs": 250,
  "pasteMethod": "sendinput",
  "silenceTimeout": 15,
  "serverUrl": "ws://localhost:51717/transcribe",
  "appendPeriod": false,
  "appendSpace": true,
  "dictationMode": "clean_prompt",
  "selectedDeviceId": "default",
  "launchOnBoot": true,
  "startMinimized": true,
  "serverAutoStart": true,
  "useExternalServer": false,
  "hotwordsEnabled": false,
  "hotwordsCsl": "",
  "__internal__": {
    "migrations": {
      "version": "0.2.0"
    }
  }
}
'@ | Set-Content -LiteralPath $appSettings -Encoding UTF8
```

`serverUrl` may remain at `51717`; the bundled server manager can allocate a dynamic port and writes the actual active port to `%APPDATA%\murmur\server.pid`.

## Server virtual environment

If the bundled server `.venv` is missing or broken, recreate it in place:

```powershell
$serverDir = "$env:LOCALAPPDATA\Programs\murmur\resources\server"
py -3.11 -m venv "$serverDir\.venv"
& "$serverDir\.venv\Scripts\python.exe" -m pip install -U pip
& "$serverDir\.venv\Scripts\python.exe" -m pip install `
  fastapi uvicorn websockets numpy soundfile huggingface_hub `
  faster-whisper==1.2.1 ctranslate2==4.8.0
& "$serverDir\.venv\Scripts\python.exe" -m pip install `
  torch==2.6.0+cu124 torchaudio==2.6.0+cu124 `
  --index-url https://download.pytorch.org/whl/cu124
```

If CTranslate2 cannot find CUDA DLLs, import `torch` before `faster_whisper` in the Whisper engine module so the CUDA runtime DLL directories are registered before CTranslate2 initializes.

## Model download

Use Hugging Face snapshot download and allow resume:

```powershell
$env:HF_HOME = "E:\hf_cache"
$env:HUGGINGFACE_HUB_CACHE = "E:\AI\cache\huggingface\hub"
$env:TRANSFORMERS_CACHE = "E:\hf_cache"
$env:XDG_CACHE_HOME = "E:\AI\cache"
python -m pip install -U huggingface_hub

@'
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id="mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    local_files_only=False,
    resume_download=True,
)
'@ | python
```

After download, check there are no `.incomplete`, `.lock`, temporary, or zero-byte files in the model snapshot.

Cache audit commands:

```powershell
$paths = @(
  "$env:USERPROFILE\.cache\huggingface",
  "$env:LOCALAPPDATA",
  "E:\hf_cache",
  "E:\AI\cache\huggingface\hub"
)
foreach ($path in $paths) {
  if (Test-Path $path) {
    Get-ChildItem -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -match '\.incomplete$|\.lock$|\.tmp$|partial|tmp' -or
        ($_.Length -eq 0 -and -not $_.PSIsContainer)
      } |
      Select-Object FullName, Length, LastWriteTime
  }
}
```

The model snapshot is usable only when `model.bin` is exactly `1617884929` bytes and the expected tokenizer/config files exist.

## Verify CUDA model loading

Run this from the server environment:

```powershell
python - <<'PY'
import time
import torch
import ctranslate2
from faster_whisper import WhisperModel

print("torch_cuda", torch.cuda.is_available(), torch.cuda.get_device_name(0))
print("ctranslate2_cuda_count", ctranslate2.get_cuda_device_count())
print("float16_supported", ctranslate2.get_supported_compute_types("cuda"))

t0 = time.perf_counter()
model = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")
print("load_seconds", round(time.perf_counter() - t0, 3))
PY
```

PowerShell-safe form:

```powershell
@'
import time
import torch
import ctranslate2
from faster_whisper import WhisperModel

print("torch_cuda", torch.cuda.is_available(), torch.cuda.get_device_name(0))
print("ctranslate2_cuda_count", ctranslate2.get_cuda_device_count())
print("float16_supported", ctranslate2.get_supported_compute_types("cuda"))

t0 = time.perf_counter()
model = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")
print("load_seconds", round(time.perf_counter() - t0, 3))
'@ | & "$env:LOCALAPPDATA\Programs\murmur\resources\server\.venv\Scripts\python.exe"
```

Expected:

- `torch_cuda True`
- `ctranslate2_cuda_count 1`
- `float16` listed as a supported CUDA compute type
- model load completes without missing weight, tokenizer, or config errors

## Runtime verification

Murmur writes a dynamic server port to `%APPDATA%\murmur\server.pid`. Query the active server instead of assuming a fixed port:

```powershell
$pidInfo = Get-Content "$env:APPDATA\murmur\server.pid" | ConvertFrom-Json
Invoke-RestMethod "http://localhost:$($pidInfo.port)/health" | ConvertTo-Json -Depth 10
```

Expected engine section:

```json
{
  "current": "whisper",
  "status": "ready",
  "info": {
    "model": "large-v3-turbo",
    "repo_id": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "device": "cuda",
    "compute_type": "float16",
    "cuda_active": true,
    "gpu_name": "NVIDIA GeForce RTX 3060 Laptop GPU",
    "load_time_s": 4.591
  }
}
```

Also confirm GPU memory increases after loading the model:

```powershell
nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits
```

## Functional test

1. Start Murmur.
2. Focus Notepad, VS Code, or a browser text field.
3. Hold left `Ctrl + Windows`.
4. Speak.
5. Release `Ctrl + Windows`.
6. Confirm text is inserted into the active cursor without manual copy/paste.

The verified behavior on RTX 3060 Laptop 6 GB was:

- model load time through Murmur: about 4.6 seconds
- 47.3 second sample transcription: about 1.7 to 3.1 seconds server inference time after warm load
- end-to-end WebSocket test elapsed time for that sample: about 5.7 seconds
- VRAM during/after transcription: about 4.95 GB used by the CUDA workload and desktop GPU context
- RAM usage depends on the Electron app, Python server, and Windows cache state; the model weights primarily live in VRAM during CUDA inference

Murmur returns the final transcript after recording stops; partial messages can be emitted, but this setup behaves as push-to-talk dictation rather than true streaming insertion.

## Local validation before publishing fork changes

Run these checks from a clean checkout before pushing the fork branch:

```powershell
cd app
bun install
bunx svelte-check --tsconfig ./tsconfig.json
bunx tsc --noEmit -p tsconfig.json
bunx tsc --noEmit -p tsconfig.main.json
bun run build

cd ..\server
$env:PYTHONPATH = "src;tests/ui/src"
python -m compileall -q src tests
python -m pytest tests -q

cd ..
git diff --check
```

Expected current result:

- `svelte-check found 0 errors and 0 warnings`
- renderer TypeScript check passes
- main-process TypeScript check passes
- app production build passes
- `94 passed` for the server test suite
- `git diff --check` exits successfully; Windows line-ending warnings are acceptable in this repository

## Rebuild from source

To rebuild the Electron app with this hotkey fix:

```powershell
git clone https://github.com/dikkadev/murmur.git
cd murmur\app
bun install
bun run build
bun run package:win
```

Use the fork branch containing this setup:

```powershell
git clone https://github.com/burntcookiedough/murmur.git
cd murmur
git checkout trunk
cd app
bun install
bun run build
```

The fixed source is in:

- `app/src/main/services/hotkey.ts`
- `app/src/main/services/clipboard.ts`
- `app/src/main/services/pipeline.ts`
- `server/src/transcription/engines/whisper.py`
- `server/src/transcription/model_download.py`
- `server/src/transcription/processor.py`

## Verified results

The setup was verified on the target laptop with:

- Model fully downloaded from `mobiuslabsgmbh/faster-whisper-large-v3-turbo`
- `WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")` loading successfully
- Runtime `/health` reporting Faster-Whisper, `large-v3-turbo`, `device=cuda`, `compute_type=float16`, `cuda_active=true`, and `NVIDIA GeForce RTX 3060 Laptop GPU`
- Push-to-talk using left `Ctrl + Windows`
- Transcription and auto-paste into Notepad
- Manual paste mechanism verified in browser and VS Code

The maintained reproducible code path for this laptop is the fork at `https://github.com/burntcookiedough/murmur` on branch `trunk`. There should be no active upstream pull request for this private/local setup unless one is intentionally opened later.
