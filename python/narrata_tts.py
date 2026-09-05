"""Narrata voice-cloning sidecar: Chatterbox Turbo behind a JSON-lines protocol.

Requests arrive on stdin, one JSON object per line; replies go to a private copy
of stdout so library chatter can never corrupt the protocol channel.
"""
import json
import os
import sys

proto = os.fdopen(os.dup(1), "w", buffering=1)
sys.stdout = sys.stderr


def emit(obj):
    proto.write(json.dumps(obj) + "\n")
    proto.flush()


def main():
    emit({"event": "status", "message": "Starting voice cloning engine (loading PyTorch)..."})
    import torch
    import torchaudio
    from chatterbox.tts_turbo import REPO_ID, ChatterboxTurboTTS
    from huggingface_hub import snapshot_download

    device = "cuda" if torch.cuda.is_available() else "cpu"
    emit({"event": "status", "message": "Downloading Chatterbox Turbo (about 3 GB on first run)..."})
    # Chatterbox's own from_pretrained fetches every *.safetensors in the repo, including a
    # 1 GB decoder the Turbo model never loads. Fetch only what from_local actually reads.
    ckpt_dir = snapshot_download(
        REPO_ID,
        allow_patterns=["ve.safetensors", "t3_turbo_v1.safetensors", "s3gen_meanflow.safetensors",
                        "conds.pt", "*.json", "*.txt", "*.yaml"],
    )
    emit({"event": "status", "message": f"Loading Chatterbox Turbo on {device.upper()}..."})
    model = ChatterboxTurboTTS.from_local(ckpt_dir, device)
    emit({"event": "ready", "sr": model.sr, "device": device})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        rid = req.get("id")
        try:
            op = req.get("op")
            if op == "ref":
                model.prepare_conditionals(req["path"])
                emit({"id": rid, "ok": True})
            elif op == "synth":
                with torch.inference_mode():
                    wav = model.generate(req["text"], temperature=req.get("temperature", 0.8))
                torchaudio.save(req["out"], wav.cpu(), model.sr, encoding="PCM_S", bits_per_sample=16)
                emit({"id": rid, "ok": True, "seconds": wav.shape[-1] / model.sr})
            elif op == "quit":
                emit({"id": rid, "ok": True})
                break
            else:
                emit({"id": rid, "ok": False, "error": "unknown op %r" % (op,)})
        except Exception as e:  # report, keep serving
            emit({"id": rid, "ok": False, "error": "%s: %s" % (type(e).__name__, e)})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        emit({"event": "fatal", "error": "%s: %s" % (type(e).__name__, e)})
        sys.exit(1)
