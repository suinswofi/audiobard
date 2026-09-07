"""Booklark voice-cloning sidecar: Chatterbox Turbo behind a JSON-lines protocol.

Requests arrive on stdin, one JSON object per line; replies go to a private copy
of stdout so library chatter can never corrupt the protocol channel.
"""
import json
import os
import sys
import traceback
import wave

proto = os.fdopen(os.dup(1), "w", buffering=1)
sys.stdout = sys.stderr


def emit(obj):
    proto.write(json.dumps(obj) + "\n")
    proto.flush()


def keep_reference_float32(model):
    """Chatterbox scales the float32 reference waveform by a NumPy float64 scalar while
    normalising its loudness. Under NumPy 2 promotion rules that silently turns the whole
    waveform into float64, and the speech tokenizer then fails with "expected scalar type
    Double but found Float". Pin the result back to float32 whatever NumPy does."""
    import numpy as np

    original = model.norm_loudness

    def norm_loudness(wav, sr, **kwargs):
        return np.asarray(original(wav, sr, **kwargs), dtype=np.float32)

    model.norm_loudness = norm_loudness


def write_wav(path, wav, sr):
    """16-bit mono PCM via the standard library. torchaudio.save needs TorchCodec from 2.9 on."""
    pcm = (wav.squeeze().clamp(-1, 1) * 32767).round().to("cpu").short().numpy()
    with wave.open(path, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes(pcm.tobytes())


GPU_PROBE = r"""
import json, sys, torch
if not torch.cuda.is_available():
    sys.exit(3)
# Prefer the device with the most memory: on a desktop with a discrete card, the CPU's built-in
# GPU is also listed and is often unsupported or too small.
best = max(range(torch.cuda.device_count()), key=lambda i: torch.cuda.get_device_properties(i).total_memory)
torch.cuda.set_device(best)
x = torch.randn(256, 256, device="cuda")
(x @ x).sum().item()
torch.cuda.synchronize()
p = torch.cuda.get_device_properties(best)
print(json.dumps({"index": best, "name": p.name, "backend": "ROCm" if torch.version.hip else "CUDA"}))
"""


def probe_gpu():
    """Find a working GPU, or None. Runs in a child process: a CUDA build without a driver, or a
    ROCm build on a card it has no kernels for, can abort the interpreter instead of raising."""
    import subprocess

    try:
        r = subprocess.run([sys.executable, "-c", GPU_PROBE], capture_output=True, text=True, timeout=300)
    except Exception as e:  # timeout, or the interpreter could not even start
        print("GPU probe did not finish: %s" % e, file=sys.stderr)
        return None
    if r.returncode == 3:
        return None  # torch built without GPU support, or no device found
    if r.returncode != 0:
        print("GPU probe failed (exit %d):\n%s" % (r.returncode, r.stderr.strip()[-2000:]), file=sys.stderr)
        return None
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        return None


def main():
    emit({"event": "status", "message": "Starting voice cloning engine (loading PyTorch)..."})
    emit({"event": "status", "message": "Checking for a usable GPU..."})
    gpu = probe_gpu()
    if gpu is None:
        # Hide every device so nothing in Chatterbox or torch touches a GPU that failed the probe.
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
        os.environ["HIP_VISIBLE_DEVICES"] = ""
    import torch
    from chatterbox.tts_turbo import REPO_ID, ChatterboxTurboTTS
    from huggingface_hub import snapshot_download

    device, label = "cpu", "CPU"
    if gpu is not None:
        try:
            torch.cuda.set_device(gpu["index"])
            device, label = "cuda", "%s, %s" % (gpu["backend"], gpu["name"])
        except Exception as e:  # passed in the child process but not here: stay on the CPU
            print("Could not select GPU %r: %s" % (gpu, e), file=sys.stderr)

    emit({"event": "status", "message": "Downloading Chatterbox Turbo (about 3 GB on first run)..."})
    # Chatterbox's own from_pretrained fetches every *.safetensors in the repo, including a
    # 1 GB decoder the Turbo model never loads. Fetch only what from_local actually reads.
    ckpt_dir = snapshot_download(
        REPO_ID,
        allow_patterns=["ve.safetensors", "t3_turbo_v1.safetensors", "s3gen_meanflow.safetensors",
                        "conds.pt", "*.json", "*.txt", "*.yaml"],
    )

    def load(dev):
        m = ChatterboxTurboTTS.from_local(ckpt_dir, dev)
        keep_reference_float32(m)
        return m

    def fall_back_to_cpu(reason, stage):
        nonlocal model, device, label
        traceback.print_exc()
        emit({"event": "status", "message": "%s on the GPU failed (%s); using the CPU instead." % (stage, reason)})
        model, device, label = None, "cpu", "CPU"
        try:
            import gc
            gc.collect()
            torch.cuda.empty_cache()
        except Exception:
            pass  # the GPU is being abandoned anyway
        model = load("cpu")
        if ref_path:
            model.prepare_conditionals(ref_path)

    ref_path = None
    model = None
    emit({"event": "status", "message": "Loading Chatterbox Turbo on %s..." % label})
    try:
        model = load(device)
    except Exception as e:
        if device == "cpu":
            raise
        fall_back_to_cpu("%s: %s" % (type(e).__name__, e), "Loading")
    emit({"event": "ready", "sr": model.sr, "device": device, "label": label})

    def synth(req):
        with torch.inference_mode():
            return model.generate(req["text"], temperature=req.get("temperature", 0.8))

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        rid = req.get("id")
        try:
            op = req.get("op")
            if op == "ref":
                try:
                    model.prepare_conditionals(req["path"])
                except AssertionError:
                    raise ValueError("The voice sample must be longer than 5 seconds.")
                ref_path = req["path"]
                emit({"id": rid, "ok": True})
            elif op == "synth":
                try:
                    wav = synth(req)
                except Exception as e:
                    if device == "cpu":
                        raise
                    # A GPU that loads the model but cannot run it (missing kernels, out of memory)
                    # should cost one retry, not the whole book. Rebuild on the CPU and go on.
                    fall_back_to_cpu("%s: %s" % (type(e).__name__, e), "Synthesis")
                    wav = synth(req)
                write_wav(req["out"], wav, model.sr)
                emit({"id": rid, "ok": True, "seconds": wav.shape[-1] / model.sr})
            elif op == "quit":
                emit({"id": rid, "ok": True})
                break
            else:
                emit({"id": rid, "ok": False, "error": "unknown op %r" % (op,)})
        except Exception as e:  # report, keep serving; full traceback goes to the log
            traceback.print_exc()
            emit({"id": rid, "ok": False, "error": "%s: %s" % (type(e).__name__, e)})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        emit({"event": "fatal", "error": "%s: %s" % (type(e).__name__, e)})
        sys.exit(1)
