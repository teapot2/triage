"""Muse Glimmer 30B on Modal, for Triage's "Modal" provider.

Serves meta-models/Muse-Glimmer-30B (Apache 2.0, from Hugging Face) with
vLLM's OpenAI-compatible server on one H100, with the flags vLLM's recipe
for the model gives: its own tool-call and reasoning parsers, which Triage
needs for tool calling and for showing the model's thinking.

Deploy:
    pip install modal && modal setup
    modal secret create triage-glimmer VLLM_API_KEY=<a long random string>
    modal deploy infra/modal/glimmer.py

Then in apps/triage/.env.local, and restart Triage:
    MODAL_BASE_URL=https://<workspace>--triage-glimmer-serve.modal.run/v1
    MODAL_API_KEY=<the same string>

The first request after a deploy (or after the container scales to zero)
downloads the ~60 GB of weights into a Volume and loads them, which takes
several minutes; later cold starts reuse the Volume.
"""

import os
import subprocess

import modal

MODEL = "meta-models/Muse-Glimmer-30B"
# What Triage's Modal provider asks for (its "glimmer" model ID).
SERVED_NAME = "muse-glimmer-30b"
# The recipe's minimum for the muse_glimmer parsers.
VLLM_VERSION = "0.28.0"
PORT = 8000
MINUTES = 60

# huggingface_hub 2.x downloads through hf-xet (installed with it) and has
# no hf_transfer extra any more; pip only warns about it, and the line is
# kept as built so Modal reuses the cached image. HF_HUB_ENABLE_HF_TRANSFER
# is deliberately not set: without the package it can fail the download.
image = modal.Image.from_registry("nvidia/cuda:12.8.1-devel-ubuntu22.04", add_python="3.12").pip_install(
    f"vllm=={VLLM_VERSION}", "huggingface_hub[hf_transfer]"
)

# Weights and vLLM's compile cache outlive containers, so only the first
# start pays for them.
hf_cache = modal.Volume.from_name("triage-glimmer-hf-cache", create_if_missing=True)
vllm_cache = modal.Volume.from_name("triage-glimmer-vllm-cache", create_if_missing=True)

app = modal.App("triage-glimmer")


@app.function(
    image=image,
    # BF16 weights are ~55 GiB; an 80 GB card leaves room for the KV cache.
    gpu="H100",
    # Stay warm through an investigation and its fix stage, then scale to
    # zero so idle time costs nothing.
    scaledown_window=15 * MINUTES,
    timeout=30 * MINUTES,
    volumes={"/root/.cache/huggingface": hf_cache, "/root/.cache/vllm": vllm_cache},
    secrets=[modal.Secret.from_name("triage-glimmer")],
)
# Triage runs one agent at a time; a few more covers Settings' checks and a
# second investigation started meanwhile.
@modal.concurrent(max_inputs=8)
@modal.web_server(port=PORT, startup_timeout=20 * MINUTES)
def serve():
    subprocess.Popen(
        [
            "vllm",
            "serve",
            MODEL,
            "--served-model-name",
            SERVED_NAME,
            "--host",
            "0.0.0.0",
            "--port",
            str(PORT),
            # Tool calling and reasoning, per vLLM's Muse Glimmer recipe: the
            # model emits channel-scoped reasoning and XML-style tool calls,
            # which the default parsers don't read.
            "--enable-auto-tool-choice",
            "--tool-call-parser",
            "muse_glimmer",
            "--reasoning-parser",
            "muse_glimmer",
            "--generation-config",
            "auto",
            # Investigations stay well under this; it keeps the KV cache in
            # what's left of the card after the weights.
            "--max-model-len",
            "65536",
            "--gpu-memory-utilization",
            "0.92",
            # Requests without this key get a 401 (Triage sends it as Bearer).
            "--api-key",
            os.environ["VLLM_API_KEY"],
        ]
    )
