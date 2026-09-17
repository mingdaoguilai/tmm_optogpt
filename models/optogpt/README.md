# OptoGPT checkpoint

The pretrained `optogpt.pt` checkpoint is not committed to Git because it is
approximately 726 MB and exceeds GitHub's normal per-file size limit.

From the repository root, install the Hugging Face CLI and download the model:

```powershell
python -m pip install -U huggingface-hub
hf download mataigao/optogpt optogpt.pt --local-dir .\models\optogpt
```

The expected local path is:

```text
models/optogpt/optogpt.pt
```

Only load the checkpoint from the official source. It is a PyTorch pickle
checkpoint and should be treated as executable serialized content.

