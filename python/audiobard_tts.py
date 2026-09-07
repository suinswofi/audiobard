"""Audiobard voice-cloning sidecar: Chatterbox Turbo behind a JSON-lines protocol.

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


GPU_COUNT = r"""
import torch
print(torch.cuda.device_count() if torch.cuda.is_available() else 0)
"""

# Runs with exactly one device visible. Times a few matrix products so the fastest card wins:
# memory is no guide, since integrated graphics report the whole of system RAM as theirs.
GPU_BENCH = r"""
import json, math, time, torch
if not torch.cuda.is_available() or torch.cuda.device_count() < 1:
    raise SystemExit(3)
p = torch.cuda.get_device_properties(0)
x = torch.randn(1024, 1024, device="cuda")
if not math.isfinite((x @ x).sum().item()):
    raise SystemExit("matrix product on the GPU returned a non-finite result")
torch.cuda.synchronize()
t = time.perf_counter()
y = x
for _ in range(20):
    y = x @ y
torch.cuda.synchronize()
gflops = 20 * 2 * 1024 ** 3 / (time.perf_counter() - t) / 1e9
print(json.dumps({"name": p.name, "memory_mb": p.total_memory // 2 ** 20, "gflops": gflops,
                  "backend": "ROCm" if torch.version.hip else "CUDA"}))
"""


def run_python(code, env=None, timeout=300):
    import subprocess

    return subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=timeout, env=env)


def with_visible_gpu(dev):
    """Environment that shows torch a single device. Both variables are set: HIP reads either."""
    env = dict(os.environ)
    env["CUDA_VISIBLE_DEVICES"] = dev
    env["HIP_VISIBLE_DEVICES"] = dev
    return env


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def probe_gpus():
    """Pick the fastest working GPU, or None. Every step runs in a child process: a CUDA build
    without a driver, or a ROCm build on a card it has no kernels for, can abort the interpreter
    instead of raising, and one bad device must not take the good one down with it."""
    try:
        r = run_python(GPU_COUNT)
    except Exception as e:
        log("GPU enumeration did not finish: %s" % e)
        return None
    if r.returncode != 0:
        log("GPU enumeration failed (exit %d):\n%s" % (r.returncode, r.stderr.strip()[-2000:]))
        return None
    try:
        count = int(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        count = 0
    if count == 0:
        return None
    # Respect a device list the user already chose; otherwise every device by index.
    preset = os.environ.get("HIP_VISIBLE_DEVICES") or os.environ.get("CUDA_VISIBLE_DEVICES")
    ids = [d.strip() for d in preset.split(",") if d.strip()] if preset else [str(i) for i in range(count)]
    best = None
    for n, dev in enumerate(ids):
        emit({"event": "status", "message": "Testing GPU %d of %d..." % (n + 1, len(ids))})
        try:
            r = run_python(GPU_BENCH, env=with_visible_gpu(dev), timeout=120)
        except Exception as e:
            log("GPU %s: test did not finish (%s)" % (dev, e))
            continue
        if r.returncode != 0:
            log("GPU %s: test failed (exit %d):\n%s" % (dev, r.returncode, r.stderr.strip()[-2000:]))
            continue
        try:
            info = json.loads(r.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            log("GPU %s: test produced no result" % dev)
            continue
        info["id"] = dev
        log("GPU %s: %s, %d MB, about %.0f GFLOPS" % (dev, info["name"], info["memory_mb"], info["gflops"]))
        if best is None or info["gflops"] > best["gflops"]:
            best = info
    return best


def main():
    emit({"event": "status", "message": "Starting voice cloning engine (loading PyTorch)..."})
    emit({"event": "status", "message": "Checking for a usable GPU..."})
    gpu = probe_gpus()
    # Show torch only the chosen device, or none at all, before it initialises: nothing in
    # Chatterbox can then land on an integrated GPU or on a card that failed its test.
    os.environ["CUDA_VISIBLE_DEVICES"] = os.environ["HIP_VISIBLE_DEVICES"] = gpu["id"] if gpu else ""
    os.environ.setdefault("TQDM_DISABLE", "1")  # the token loop's progress bar would flood the log
    import time
    import torch
    from chatterbox.tts_turbo import REPO_ID, ChatterboxTurboTTS
    from huggingface_hub import snapshot_download

    if gpu is None:
        device, label = "cpu", "CPU"
    else:
        device, label = "cuda", "%s, %s" % (gpu["backend"], gpu["name"])

    emit({"event": "status", "message": "Downloading Chatterbox Turbo (about 3 GB on first run)..."})
    # Chatterbox's own from_pretrained fetches every *.safetensors in the repo, including a
    # 1 GB decoder the Turbo model never loads. Fetch only what from_local actually reads.
    ckpt_dir = snapshot_download(
        REPO_ID,
        allow_patterns=["ve.safetensors", "t3_turbo_v1.safetensors", "s3gen_meanflow.safetensors",
                        "conds.pt", "*.json", "*.txt", "*.yaml"],
    )

    stages = {}

    def timed(obj, name, key):
        """Wrap a method so each call's wall time lands in stages[key]. Timing is a log line only,
        so a Chatterbox release that renames the method must cost the line, not voice cloning."""
        f = getattr(obj, name, None)
        if not callable(f):
            log("no %s.%s to time; stage timings will be missing from the log" % (type(obj).__name__, name))
            return

        def g(*a, **k):
            t = time.perf_counter()
            r = f(*a, **k)
            if device != "cpu":
                torch.cuda.synchronize()
            stages[key] = stages.get(key, 0.0) + time.perf_counter() - t
            return r

        setattr(obj, name, g)

    def load(dev):
        m = ChatterboxTurboTTS.from_local(ckpt_dir, dev)
        keep_reference_float32(m)
        timed(m.t3, "inference_turbo", "t3")
        timed(m.s3gen, "inference", "s3gen")
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
        stages.clear()
        t = time.perf_counter()
        with torch.inference_mode():
            wav = model.generate(req["text"], temperature=req.get("temperature", 0.8))
        total = time.perf_counter() - t
        seconds = wav.shape[-1] / model.sr
        # Speech tokens run at 25 per second of audio, so tokens/s of the decoder follows from the length.
        t3 = stages.get("t3", 0.0)
        log("synth: %d chars -> %.1f s audio in %.1f s (%.1fx real time); T3 decode %.1f s (about %.0f tokens/s), S3Gen %.1f s, other %.1f s"
            % (len(req["text"]), seconds, total, seconds / total if total else 0, t3, 25 * seconds / t3 if t3 else 0,
               stages.get("s3gen", 0.0), total - t3 - stages.get("s3gen", 0.0)))
        return wav

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
