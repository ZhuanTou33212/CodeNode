"""Download pinned model data only; never executes repository Python code."""
import hashlib
import json
from pathlib import Path
import urllib.request

repo = 'SugoLabs/mmarco-mMiniLMv2-L12-H384-v1'
root = (Path(__file__).resolve().parent.parent / '.cache/rag-experiment/mmarco-reranker').resolve()
root.mkdir(parents=True, exist_ok=True)
meta = json.load(urllib.request.urlopen('https://huggingface.co/api/models/' + repo, timeout=30))
revision = meta['sha']
manifest = {'repository': repo, 'revision': revision, 'files': {}}
for relative in ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        url = 'https://huggingface.co/' + repo + '/resolve/' + revision + '/' + relative
        temporary = target.with_suffix(target.suffix + '.download')
        print('Downloading model data:', relative, flush=True)
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as stream:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                stream.write(chunk)
        temporary.replace(target)
    manifest['files'][relative] = {'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'bytes': target.stat().st_size}
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print('Pinned reranker model data ready:', revision, flush=True)
